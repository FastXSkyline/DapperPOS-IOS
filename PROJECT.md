# PROJECT.md — Dapper

> Project guide for developers. Loaded into context every session.
> For exhaustive detail see the [`docs/`](docs/) folder (linked throughout). This file is the operational summary; the `docs/` files are the source of truth.

---

## 1. What this is

**Dapper** — a Point-of-Sale + **multi-store retail management** system for a clothing business (prêt-à-porter) in the **Algerian market**, by Ilyes. **Pure retail**: one shelf price, walk-in and repeat customers. There is no wholesale arm and no B2B distribution.

The business runs **two shops — Costume and Casual** — on 2–3 PCs. Store is a first-class entity: stock, sales, cash sessions and expenses are all store-scoped. See [docs/RETAIL_PLAN.md](docs/RETAIL_PLAN.md) for the topology (one server PC per store, LAN thin clients, central PostgreSQL on cPanel as a reporting mirror) and the reasoning behind it.

The domain model is built around **size × colour variants**: a garment is only sellable, stockable and scannable as a specific combination, so `product_variants` is load-bearing throughout (see §6).

> **History:** this codebase began as *GestionPOS*, an electrical-material distributor with wholesale (gros/demi-gros) and a BTP arm. It was pivoted to clothing retail across Phases 1–5 of [docs/DAPPER_PLAN.md](docs/DAPPER_PLAN.md). Wholesale tiers and multi-dépôt transfers still exist in the schema but are **dormant and no longer read** — do not wire anything back to them without revisiting that decision. Expect to still meet occasional artefacts of the old domain; treat them as bugs to clean up, not as requirements.

The headline differentiator is a **voice/chat AI assistant in Algerian Darija / Arabic / French** that must eventually drive and answer *anything* across the whole system (a "no-brainer" copilot — see §7 and [docs/AI_ASSISTANT.md](docs/AI_ASSISTANT.md)).

**Design language:** the **Elegance** palette — indigo accent on a cool light canvas, flat white cards. See §10 and `src/styles/tokens.css`.

## 2. Architecture

Three modules under the repo root (`D:\projects\dsa\gestion`):

| Module | Stack | Role |
|---|---|---|
| `core/` | `schema.sql`, `permissions.ts` | Nominal shared SQLite schema + RBAC matrix (⚠️ both currently under-used — see §6) |
| `desktop/` | Electron 34 + React 19 + Vite 7 + TypeScript + `better-sqlite3` | The main app. `electron/` = main-process services & IPC, `src/` = React renderer. Also runs a **Fastify LAN sync server on `:4000`**. |
| `mobile/` | Expo 54 / React Native 0.81 + `expo-sqlite` | Companion app; talks to desktop over LAN. Has a working `VoiceAssistant`. |

**Data flow (desktop):** React renderer → `window.electron.*` (preload bridge, `electron/preload.cjs`) → `ipcMain.handle` in `electron/main.ts` → service modules (`*Service.ts`) → `better-sqlite3`. The DB lives at `app.getPath('userData')/pos-system.db` in production, not in the repo.

**Data flow (mobile↔desktop):** mobile `SyncService` → HTTP → desktop `electron/syncServer.ts` (`/sync/*`, `/print/*`). See [docs/AUDIT.md](docs/AUDIT.md) §sync for the (serious) gaps.

### Key desktop files
- `electron/main.ts` — all IPC handlers + the AI orchestration `handleAIAction()`.
- `electron/ai/intentEngine.ts` — current OpenAI intent classifier (to be replaced by tool-calling, see §7).
- `electron/voice/{transcribe,tts,norm}.ts` — Whisper STT, OpenAI TTS, Darija phonetic normalizer.
- `electron/transactionService.ts` — sale lifecycle; fully variant-aware, awards loyalty on `complete()`.
- `electron/productService.ts` — products **and** the size×colour variant CRUD. `setVariants` upserts and soft-deletes; it must never DELETE+INSERT (sale history and stock reference those rows).
- `electron/pricingService.ts` — retail-only: negotiated price → shelf price → promotions/quantity breaks.
- `electron/{cashSession,loyalty,loss}Service.ts` — Dapper Phases 2–3: Z-report, points, shrinkage.
- `electron/{receipt,invoice,label,purchaseOrder,report,stock,expense}Service.ts` — domain services & document generation.
- `electron/syncServer.ts` — LAN server (⚠️ no auth).
- `electron/database.ts` — DB init + migrations 1–33, re-run every boot. This is the *real* schema. `core/schema.sql` executes first on every boot, so the two must agree.
- `electron/migrationsRetail.ts` — **migrations 34–45** (stores, terminals, permissions, audit, brands/sizes/colours, returns, transfers, counts, notifications, targets, bundles). Called from `runMigrations()` just before the `user_version` stamp; same idempotency contract. **Add new migrations here, not in database.ts.** `user_version` is currently **45**. Migration 44 turns `employees` into a real HR record (poste, contact, contrat, magasin, compte caisse) and gives `expenses` a `category`/`store_id`/`spent_at` plus a `source_type`/`source_ref` pair under a partial UNIQUE index — that index is what makes posting payroll to the books idempotent.
- `electron/productImageService.ts` — product photos and category artwork. Files are **copied** into `userData/product-images/` (an owner imports from a USB stick that is gone tomorrow) and served to the renderer over a registered **`dapper-img://`** protocol — never `file://` (blocked) and never base64 data URIs (a 50-tile POS grid would be tens of MB of IPC per keystroke). `primaryMap()` answers a whole grid in one call.
- `electron/inventoryService.ts` — store-scoped stock with the **atomic oversell guard** (`UPDATE … WHERE quantity >= ?`). `getOverview()` is the Inventaire screen's single source: it assigns each stock line exactly ONE state (rupture > faible > dormant > sain) so the four counts add up — the three single-purpose queries beside it (`getLowStock`/`getOutOfStock`/`getDeadStock`) OVERLAP and must not be summed. Every stock path goes through this, not `stockService.ts` — including the sale, the void and the avoir. `stockService.ts` is legacy; do not add callers.
- `electron/returnService.ts` — returns, refunds and exchanges. A return never edits the original sale, and always refunds the price stored on the original line. `exchangeWithNewSale()` builds, pays for and completes the replacement sale **and** records the return in one transaction — the renderer must never drive those steps separately.
- `electron/targetService.ts` — sales targets, measured against net revenue; a return is charged to whoever made the original sale.
- `electron/cloudPushService.ts` — one-way push to the central PostgreSQL mirror behind the owner's website. Watermark-based, retry-safe, never on the sale path. Contract + DDL in [docs/CLOUD_MIRROR.md](docs/CLOUD_MIRROR.md).
- `electron/rpcRouter.ts` / `rpcClient.ts` / `ipcRegistry.ts` / `terminalMode.ts` — **thin-client mode**. A PC is a server (holds the store's SQLite) or a client (forwards every data call to it). Routing is installed by wrapping `ipcMain.handle` ONCE in main.ts — do not add per-handler routing. Client default: forward. Server default: refuse. See docs/RETAIL_PLAN.md.
- `electron/eventBus.ts` — realtime fan-out to local windows (IPC) and LAN terminals (SSE on `/events`). **Publish only AFTER a transaction commits** — that is why `main.ts` publishes via `guardAndPublish()` and services never publish themselves. An event is a hint to re-read, never a value to trust.
- `electron/inventoryCountService.ts` — stock counts. Two rules carry it: `expected_qty` is snapshotted PER LINE at the moment of counting, and applying writes a **delta**, never an absolute — so sales made during the count are not mistaken for shrinkage nor erased. Uncounted lines are ignored, never zeroed.
- `electron/notificationService.ts` — the alert sweep. Makes no findings of its own; re-reads the services that already know. Dedupe is a **partial unique index** on `dedupe_key WHERE read_at IS NULL`, so one condition = one open alert, and dismissing lets it raise again later.
- `electron/transferService.ts` — two-phase store transfers. Source stock leaves on SHIP, destination gains on RECEIVE; every transition asserts the current status, so a double-click cannot receive twice.
- `electron/analyticsService.ts` — the retail reports. **Read its header before touching any profit figure**: it defines gross/net revenue, COGS, gross profit and margin, and states that expenses are never deducted.
- `electron/storeService.ts` / `permissionService.ts` / `auditService.ts` — stores + terminals + device identity, database-backed granular permissions with discount caps, and the before/after audit trail.
- `src/hooks/useRetailEvents.ts` — renderer subscription. Debounced, because one sale publishes several events; always re-reads rather than patching state from a payload.
- `src/App.tsx` — the shell and nothing else. One `NAV` table drives the sidebar, the `View` union, the AI navigation whitelist and the RBAC matrix, so **adding a screen is one row**; it used to take three hand-maintained lists and missing any one made the screen unreachable. The ~600 lines of settings JSX that lived here moved to `SettingsScreen.tsx` + `settingsPanels.tsx`.
- **There is no login screen.** The app boots as the LEAST privileged active user (remembered in config; a cashier if there is one), and `UserSwitcher.tsx` — the sidebar's bottom card — changes both WHO you are and WHICH SHOP this till sells for. Stepping up to `owner`/`manager` costs that person's PIN, verified in the main process via `auth.login`; stepping down is free. `PinLogin.tsx` is no longer mounted.
- `src/components/{ReturnsScreen,StockScreen,AuditLogScreen,StoreSettings,TransfersScreen,RetailReports,InventoryCountScreen,NotificationCenter}.tsx` — retours/échanges, stock bas·rupture·dormant·mouvements, the audit trail, and magasins/caisses/rôles (mounted inside the Settings view). `src/components/*` — other screens.
- `src/components/DepotSettings.tsx` — **dormant**, intentionally not imported (see §1 history).

## 3. Build & run

All commands run from `desktop/` unless noted. **Build scripts are currently Windows-cmd-only** (`if exist`, `copy /Y`) — see Phase 6 to fix for CI/cross-platform.

```bash
# desktop
npm install            # postinstall runs electron-builder install-app-deps (native better-sqlite3)
npm run dev            # Vite + Electron dev
npm run build          # tsc -b && vite build && copy preload + schema
npm run dist           # clean + build + rebuild native + electron-builder (NSIS installer)
npm run lint           # eslint
npm test               # vitest (node:sqlite, no Electron needed)

# mobile
npm install
npm run start          # expo start  (android/ios/web variants available)
```

`npm run build` runs `tsc -b`, which now typechecks **three** projects: `src` (renderer), `vite.config.ts`, and — new — **`electron` + `shared`** via `tsconfig.electron.json`. The main process had never been typechecked before; it is now, under `strict` + `noUnusedLocals` + `erasableSyntaxOnly`. That last flag forbids **parameter properties** (`constructor(readonly x: string)`) — declare the field explicitly instead.

To launch the app to verify a change, prefer the `/run` skill; for native-module issues run `npm run rebuild`.

## 4. Conventions

- **TypeScript strict** across app + node tsconfigs. Match surrounding style (2-space indent, single quotes, no semicolons in most renderer files — follow the file you're editing).
- **Renderer never touches the DB or `better-sqlite3` directly** — always go through `window.electron.*` IPC. (Exception that exists today and must be removed: the generic `dbQuery`/`dbRun` bridge — see §6.) Do **not** add new `dbQuery`/`dbRun` call sites; add a typed IPC handler instead.
- **Money:** all amounts are DZD. Display goes through `formatCurrency` in `src/utils/formatters.ts` — **one** formatter for the whole renderer (`35 000 DA`, narrow-nbsp grouping, decimals only when the amount has them; `formatCurrencyPrecise` forces them for anything reconciled against a drawer). Do not reintroduce `toFixed(2)`/`toLocaleString()` at a call site. Stored as SQLite `REAL` (centime-drift risk — noted for later).
- **Services are the unit of business logic**; IPC handlers in `main.ts` should be thin pass-throughs. New capabilities should also register in the **Capability Registry** (§7) so the AI can use them.
- **Multi-statement DB mutations must be wrapped in `getDatabase().transaction(() => …)()`** for atomicity (the sale-completion path was a violation — fixed in Phase 1).
- **Two languages: French and Arabic.** English is gone — it was the DEFAULT, which is why an Algerian shop opened on "New Product / Basic Information". `src/LanguageContext.tsx` persists the choice to `config.ui_language` (it used to live in `useState` alone and silently reset to English every launch), sets `lang`/`dir` on `<html>`, and falls back to the FRENCH string for a missing Arabic key rather than printing the raw key path at a shopkeeper. `fr.ts` and `ar.ts` must stay key-for-key identical. **Every redesigned screen is localised** — shell, Dashboard, POS, Inventaire, Produits, ProductDetail, ProductForm, Ventes, Clients, Employés, Fournisseurs, Paramètres, familles, images, poste de travail. `tests/locales.test.ts` enforces it: key parity both ways, no empty values, no English left in French, no Latin sentence left in Arabic, and **every literal `t('a.b')` in `src/` resolves** — that last check caught two screens rendering a raw key path as a column header. Money is wrapped in `unicode-bidi: isolate; direction: ltr` under RTL — without it the bidi algorithm reorders “35 000 DA” into “DA 35 000”.
- **Permissions are enforced in the main process**, via `PermissionService.assertCan(userId, code)` at the top of every mutating IPC handler. Roles are exactly the four `users.role`'s CHECK allows — `owner`, `manager`, `cashier`, `warehouse`; `warehouse` IS the brief's STOCK_MANAGER, and a `stock_manager` user row would fail the constraint. The renderer's `can()` only hides buttons — it is a courtesy, never the boundary.
- **Never write stock directly.** Use `InventoryService.consume/receive/setAbsolute`, which are atomic, store-scoped, and write the `stock_movements` ledger row. A silent stock write is a bug even when the number ends up right.
- **Sensitive mutations write an audit row** (`AuditService.log` / `logChange`) with the before and after values.
- New retail IPC handlers return a `ServiceResult<T>` envelope (`{ok:true,data}` / `{ok:false,code,message}`) instead of throwing, so the renderer branches on a stable `code`.

## 5. Security rules (READ BEFORE TOUCHING ANYTHING NETWORK/SECRET-RELATED)

- **Never commit secrets.** `.env` files hold the OpenAI key and must stay gitignored. A live key was historically committed in `desktop/.env`, `mobile/.env`, built bundles and the installer — **treat it as compromised; it must be rotated by the owner** (see [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md) Phase 1).
- **No provider key in the mobile bundle.** `EXPO_PUBLIC_*` is inlined into the shipped app. Mobile AI must call OpenAI **through the desktop server proxy**, never directly. Desktop holds the key server-side (main process).
- **The LAN sync server must require a pairing token** on every route once Phase 1 lands; it binds `0.0.0.0:4000` and currently has none.
- **No universal backdoors / plaintext PINs.** The `RESET-9999` master key is removed (Phase 1); PINs will be hashed.
- HTML-escape any user/DB field interpolated into print templates.

## 6. Current state — known critical issues (audit summary)

Full detail in [docs/AUDIT.md](docs/AUDIT.md). The headline defects:

| Area | Issue |
|---|---|
| 🔴 Fiscal | **TVA is hardcoded to 0** (`transactionService.ts` addItem/recalculateTotals). The printed A4 is a **"Bon de Livraison", not a Facture**, with **random non-sequential numbering**. No seller-fiscal-ID settings UI; timbre always 0. |
| 🟢 Correctness | Sale double-completion and non-transactional `complete()` are fixed. The **atomic oversell guard is live on the sale path**: `complete()`, `void()` and `createAvoir()` all go through `InventoryService`, backed by a UNIQUE index on `(store_id, product_id, COALESCE(variant_id,0))` (Migration 34). A refused sale stays `pending` and rolls back whole. Sales carry `store_id` + `terminal_id`. Existing negative stock in the live DB is untouched — the guard prevents new oversells, it does not repair old ones. |
| 🔴 Security | Leaked OpenAI key; open `:4000` sync server; `RESET-9999` backdoor; plaintext PINs; arbitrary SQL over `dbQuery`/`dbRun` IPC. |
| 🟠 AI | Desktop AI backend is complete but **no renderer UI triggers it**; action events (`view-change`, theme, lang) emitted but never consumed; `CREATE_PRODUCT` reads `data.name` while the prompt emits `product_name`; packaged build has no key. **The AI is not variant-aware** — it can create/sell a product but cannot pick a size/colour. |
| 🟠 Sync | No auth, no idempotency (duplicate sales), colliding `TX-${Date.now()}` numbers, manual IP. Mobile is **not** variant-aware either (Dapper Phase 6). |
| 🟠 Schema | `core/schema.sql` and the desktop migrations now agree on `product_variants`, and `user_version` is stamped (currently **45**). Mobile still diverges. `core/schema.sql` runs on every boot *before* migrations, so anything it declares must match what Migration N expects. |
| 🟠 Repo | No root git repo (only an orphaned `mobile/.git` scaffold); build artifacts + 100MB installer committed; no CI/auto-update. Tests now exist (346, `npm test`). |
| 🟠 Dead code | `HeldTransactions.tsx` imports `transactionService` **directly into the renderer** — it would crash if wired up. Nothing references it. `SupplierManager.tsx` had the identical defect (it imported `SupplierService`); it is now on IPC and mounted as Fournisseurs. Wiring it in broke the renderer build immediately, which is the honest version of what would have happened at runtime — check for this before mounting any unmounted screen. |

## 7. The AI assistant — the "no-brainer" north star

**Goal:** a copilot that handles *anything* a shop owner asks across the entire system — read ("how much did I sell this week? who owes me? what's my TVA this month? do we still have that shirt in M black?"), act ("create product, make a sale, settle Ahmed's debt, print the last invoice, order 50 from supplier X"), and analyze — in Darija/Arabic/French, online or with a graceful offline fast-path.

**The design principle that makes it a no-brainer:** every system capability is registered **once** in a **Capability Registry** (typed name + multilingual description + params schema + handler). The AI is a thin **function/tool-calling** layer over that registry. **Adding any new feature = registering a capability ⇒ the assistant can immediately use it.** No giant hand-coded intent switch. One shared "brain" for desktop + mobile.

Today it's a rigid intent-enum + hand-coded `switch` in `main.ts` — capable but brittle, desktop-only-untriggered, cloud-only, key-leaking, and divergent from mobile. The full target architecture, orchestration loop, offline strategy, security model, and migration path are in **[docs/AI_ASSISTANT.md](docs/AI_ASSISTANT.md)**.

## 8. Algerian fiscal/legal quick reference

Full spec in **[docs/ALGERIA_REQUIREMENTS.md](docs/ALGERIA_REQUIREMENTS.md)** (~75 requirements, mapped to code). Essentials:

- **TVA:** 19% standard, 9% reduced (CTCA art. 23 list), 0%/exonéré (art. 9). Per-line, per-rate, summable for the **G50** monthly declaration.
- **Droit de timbre** (cash invoices only): 1% (300–30 000 DA), 1.5% (30 000–100 000), 2% (>100 000), per 100-DA tranche on TTC, min 5 DA, cap ~10 000 DA. **Exempt** for cheque/virement/CCP/card.
- **Do NOT compute TAP** — abolished 01/01/2024.
- **Facture conforme** (décret 05-468) needs seller **NIF/NIS/RC/Article d'imposition**/address/capital, **buyer NIF** for B2B (TVA deductibility), **gapless sequential numbering**, per-rate TVA, total in figures + words, payment mode + date.
- **Facture d'avoir** is the only legal way to correct/cancel; issued invoices must never be silently edited/deleted.
- **IFU vs réel** regime switch (IFU ≤ 8 000 000 DA turnover, no TVA).
- **Arabic-first bilingual** documents (Loi 91-05).
- ⚠️ **Rates change every Loi de Finances — confirm with an accountant/DGI before hardcoding** (see the `legal_to_verify` list in the requirements doc). E-invoicing is **not yet mandatory** for SME retail/wholesale.

## 9. Roadmap

Two plans run side by side:

**[docs/RETAIL_PLAN.md](docs/RETAIL_PLAN.md) — multi-store retail management.** The **active** plan: two stores, terminals, returns/exchanges, transfers, counts, notifications, targets, analytics and the cPanel mirror. Phase 0 (architecture + migrations 34–41) and the service layer for phases 1/3/4 are built and tested; the UI is not.

**[docs/DAPPER_PLAN.md](docs/DAPPER_PLAN.md) — the clothing-retail pivot.** Complete; superseded as the active plan by RETAIL_PLAN.md.

1. **Variants** — size × colour as the sellable unit. ✅ built (purchase orders included)
2. **Daily operations** — cash sessions + Z-report, drawer movements, promotions UI. ✅ built
3. **Customer & loss tracking** — loyalty points, pertes/shrinkage, layaway column. ✅ mostly built
4. **Retail-only cleanup** — one shelf price; wholesale/multi-dépôt made dormant. ✅ built
5. **Rebrand** — Dapper, black & white, docs rewrite. ✅ built
6. **Mobile role-gating** — employee = scan-and-sell, manager = everything. ✅ built (plus mobile variant support, which fixed two stock-corruption bugs in the sync path)

⚠️ **None of Phases 1–5 has been click-tested in the running app** — all verification so far is
schema/logic-level against real SQLite, plus `tsc` and a full build. Carried-forward gaps are
listed at the end of each phase in the plan; read them before assuming a feature is complete.

**[docs/MASTER_PLAN.md](docs/MASTER_PLAN.md) — the original GestionPOS plan.** Its security and
fiscal tracks still apply and are **not** superseded (Phase 1 stabilisation, Phase 3 fiscal core,
Phase 5 accounting, Phase 6 deploy). Its **Phase 4 "Commercial & wholesale" is obsolete** — price
tiers and multi-dépôt were deliberately retired in the pivot.

## 10. Docs index

- [docs/CLOUD_MIRROR.md](docs/CLOUD_MIRROR.md) — the push contract and the PostgreSQL DDL for the website mirror.
- [docs/RETAIL_PLAN.md](docs/RETAIL_PLAN.md) — **active plan**: multi-store architecture, the schema delta, and the phase list.
- [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md) — the full phased plan with task breakdowns & acceptance criteria (incl. the **Redesign track R**).
- [docs/AI_ASSISTANT.md](docs/AI_ASSISTANT.md) — the system-wide copilot architecture.
- [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) — the "Liquid Glass" Apple-grade design language (desktop + mobile).
- [docs/ALGERIA_REQUIREMENTS.md](docs/ALGERIA_REQUIREMENTS.md) — fiscal/legal/commercial requirements, mapped to code.
- [docs/AUDIT.md](docs/AUDIT.md) — current-state audit findings (security, correctness, sync, build).

**Design language: "Elegance".** Indigo accent (`--accent: #5B57E8`) on a cool light canvas
(`#F5F6FA`), flat white cards, quiet shadows, tight radii (12–16px), bilingual FR/AR type. Modelled on
the owner-approved mockup. New UI uses the tokens in `src/styles/tokens.css` + the screen furniture in
**`src/styles/elegance.css`** (`el-page`, `el-card`, `el-stat`, `el-table`, `el-chip`, `el-tabs`,
`el-segmented`, `el-modal`, `el-btn`, `el-input`…) — **never hardcoded hex**. `src/styles/glass.css`
is materials only; the animated aurora field that used to sit behind everything is gone (a drifting
gradient destroys the value step that makes a white card read as lifted).

**A screen is built from `elegance.css` class names, not from its own paddings.** That is what keeps a
new window matching the mockup by construction. A card is a border plus `--shadow-sm`, not a shadow;
cards do not lift on hover, only things you can click move; money is tabular.

**Charts** go through `src/hooks/useChartTheme.ts` — the resolved Recharts ramp lives there ONCE
(Recharts cannot consume `var(--chart-1)` in an SVG fill). Do not paste a second literal copy into a
screen.

> **This replaced a strictly monochrome palette** (Dapper Phase 5). The owner chose the mockup; the
> tokens and this section were changed together so they cannot disagree. `docs/DESIGN_SYSTEM.md` still
> describes the older monochrome Liquid Glass system and has **not** been rewritten yet.

Three rules that survive the palette change:
- **Semantic colour still means something.** `--success` / `--warning` / `--error` exist because a short
  till or an oversell has to be unmistakable. They sit far from indigo in hue so a delta chip never
  reads as an accent chip. Never introduce a hue for decoration.
- **Charts may not rely on hue *alone* for identity.** `--chart-1..8` is **validated, not chosen**:
  adjacent slots alternate cool/warm so the pairs a reader compares are the furthest apart, which is
  what survives deuteranopia. Assign in order and never cycle — a filter that drops a series must not
  repaint the survivors. **Single-series charts use one ink (`--chart-ink`), not the ramp**: sizes,
  hours and store totals are ordered or one-dimensional, and a hue per bar would imply an identity
  the data does not have. Never a dual-axis chart. Re-validate with the `dataviz` skill's
  `scripts/validate_palette.js` before changing any chart colour.
- **Recharts needs resolved colours.** It cannot consume `var(--chart-1)` in SVG fills, so
  `AnalyticsDashboard.tsx` keeps a literal copy of the ramp. Change one, change the other.

## 11. Working notes / gotchas

- The app can fall back to an **inline schema** when `schema.sql` isn't found. That fallback is *thinner* than `core/schema.sql` — e.g. it creates `stock_inventory` without `variant_id`/`updated_at`. Any migration touching a table the fallback also creates must add its columns defensively (Migration 30 does this).
- **New migrations must be idempotent** — every one re-runs on every boot. Guard with `PRAGMA table_info` / `CREATE TABLE IF NOT EXISTS`, and bump the `user_version` stamp at the bottom of `runMigrations`.
- `expenses`, `sync_status`, `source_device`, and Migration-10 product columns exist **only in code**, not in `core/schema.sql`.
- **`userData` is derived from `package.json`'s `name` field in dev** (`Roaming/desktop`) and from `build.productName` when packaged. Changing either **moves the database** and orphans the old one — don't rename `name` casually.
- Mobile `index.js` may resolve the boilerplate `App.js` instead of the real `App.tsx` (Metro resolution) — delete the boilerplate.
- **Tests exist now: 346, via `npm test`.** `tests/helpers/sqliteHarness.ts` builds an in-memory database from `core/schema.sql` using **`node:sqlite`** and shims better-sqlite3's `.transaction()` (with SAVEPOINTs, because the real code nests). Services are tested by `vi.mock`-ing `../electron/database` with a factory that returns the test handle — the factory form never evaluates the real module, so `electron` and the native binding are never loaded. Import `node:sqlite` through `createRequire`, not a static import: it is newer than Vite's builtin list. **Add coverage for any money or stock logic.**
- **`better-sqlite3` is built for Electron's ABI**, so plain `node` can't require it. Use `node:sqlite` for scratch verification, or run under Electron.
- Don't commit unless asked. If you do init git, use the root `.gitignore` and never stage `.env`, `*.db`, `dist-electron/`, `release/`.

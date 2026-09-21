# GestionPOS — Master Plan

> The single, phased plan that merges the **code audit** ([AUDIT.md](AUDIT.md)) and the **Algerian-market requirements** ([ALGERIA_REQUIREMENTS.md](ALGERIA_REQUIREMENTS.md)) into one execution roadmap. The AI copilot design lives in [AI_ASSISTANT.md](AI_ASSISTANT.md).

## How this plan was built

This plan is the synthesis of two multi-agent reviews run on this codebase:

1. **Security & correctness audit** — 7 dimensions (AI/voice, fiscal compliance, printing, sync, data/security, POS-core, build/hygiene). Verdict: *working single-operator prototype, not shippable; fragile-to-broken on security & compliance.*
2. **Algerian-market requirements research** — 7 domains (taxation, legal invoicing, commercial documents, accounting/SCF, payments, wholesale/sector, localization), web-sourced against the current Lois de Finances (2024 Law 23-12, 2025 Law 24-08), then mapped to the code. ~75 distinct requirements.

## Guiding principles

- **Stop the bleeding before adding features.** Security and money-correctness defects come first.
- **The AI is only as capable as the system underneath it.** We build the AI *brain + capability layer* early (Phase 2), then every feature added in Phases 3–5 registers capabilities so the assistant automatically gains them. That incremental compounding is what makes it a "no-brainer."
- **Compliance is a product feature, not an afterthought.** A non-conforme invoice is a legal liability for the merchant; treat fiscal correctness as P0 once stable.
- **Verify fiscal rates with a professional.** Rates/thresholds change every Loi de Finances — see the `legal_to_verify` checklist in [ALGERIA_REQUIREMENTS.md](ALGERIA_REQUIREMENTS.md). Make rates *configurable*, never hardcoded.
- **Offline-first always.** Nothing in the core sale/stock/print path may block on the internet.

## Status legend

✅ done · 🔄 in progress · ⬜ todo · 👤 requires the owner (e.g. key rotation, accountant confirmation)

---

## Phase 1 — Stabilize: Security + Critical Correctness

**Goal:** make the app safe to put under version control, to network, and to take real money — without changing what it does functionally.

| # | Task | State |
|---|---|---|
| 1.1 | Root `.gitignore` + tighten `desktop/.gitignore` & `mobile/.gitignore` (ignore `.env`, `*.db`, `dist-electron/`, `release/`, `.expo/`) | ✅ |
| 1.2 | `.env.example` placeholders for desktop & mobile | ✅ |
| 1.3 | Remove the `RESET-9999` owner-PIN backdoor (`PinLogin.tsx`) | ✅ |
| 1.4 | Fix the **double-`complete()`** stock double-decrement: idempotency guard in `complete()` + remove the redundant call in `POSScreen` | ✅ |
| 1.5 | Wrap `complete()` (status update + stock loop + movements) in a single DB transaction | ✅ |
| 1.6 | **Rotate the leaked OpenAI key** at the OpenAI dashboard; remove from any committed artifacts | 👤 |
| 1.7 | Initialize a single **root git repo** (delete orphaned `mobile/.git`), first commit excludes secrets/artifacts | 👤/⬜ |
| 1.8 | **Hash PINs** (bcryptjs) + fetch-then-compare + idempotent migration that hashes existing plaintext PINs at rest (`authService.ts`, database.ts Migration 11) | ✅ |
| 1.8b | Force owner PIN change on first run (stateless `auth.ownerPinIsDefault` check; PinLogin blocks the owner on `1234` until a new PIN is set) | ✅ |
| 1.9 | Add a **shared-secret pairing token** to the sync server (Fastify `onRequest` hook on all routes except `/health`; constant-time compare); shown in desktop Settings; entered + sent as `x-sync-token` by mobile | ✅ |
| 1.10 | Remove the generic `dbQuery`/`dbRun` IPC bridge; migrate the few renderer call sites (`PinLogin`, `ProductList`, `PaymentModal`) to typed handlers; route supplier delete through the soft-delete IPC | ✅ |
| 1.11 | HTML-escape interpolated fields in all print templates (`escapeHtml` helper across receipt/invoice/PO/label; barcode JS-string-escaped) | ✅ |
| 1.12 | Oversell warning on the sale path: `transaction.checkStock` + non-blocking amber banner in the POS cart (sale still allowed, risk surfaced) | ✅ |

**Acceptance:** no secret in the tree; sync rejects un-tokened requests; a sale decrements stock exactly once inside a transaction; no renderer path can run arbitrary SQL; PINs are hashed with no backdoor.

---

## Phase 2 — AI Foundation & Revival ("no-brainer" copilot, v1)

**Goal:** a working, secure, system-wide assistant on desktop *and* mobile that can do/answer everything the system currently supports — built so future features auto-extend it. Full design: [AI_ASSISTANT.md](AI_ASSISTANT.md).

| # | Task | State |
|---|---|---|
| 2.1 | **Capability Registry** — central typed catalogue of every system action/query (name, multilingual description, JSON-schema params, handler). Wrap existing services. (`electron/ai/capabilities.ts`, `match.ts`) | ✅ |
| 2.2 | **Server-side AI proxy** — desktop `ai/*` IPC + authenticated `POST /ai` and `POST /ai/voice` on the sync server (token-gated); key stays main-process-only. | ✅ |
| 2.3 | **Tool-calling orchestrator** — replaced the intent-enum `switch` with OpenAI function-calling driven by the registry; multi-step (read→reason→act); aggregates UI events + natural reply. (`electron/ai/orchestrator.ts`; `main.ts` rewired) | ✅ |
| 2.4 | **Desktop voice/chat UI** — `AIAssistant` (mic FAB + glass panel, MediaRecorder→processVoice, text→processText, plays reply audio, shows transcript/response/status); mounted in `App.tsx`; mic permission granted in `main.ts`; Whisper file format fixed to webm. | ✅ |
| 2.5 | **Wire action events** — subscribe `App.tsx` to `onViewChange`/`onSettingsToggleTheme`/`onSettingsChangeLang`. | ✅ |
| 2.6 | **Unify the brain** — mobile `aiService` now routes text+voice through the desktop `/ai` + `/ai/voice` proxy (with `x-sync-token`); **the embedded OpenAI key is removed from the mobile bundle**. Navigation mapped from the desktop's events; graceful when unpaired. | ✅ |
| 2.7 | **Offline fast-path** — local keyword grammar in the orchestrator resolves templated nav/print/theme/language commands with no network; cloud only for free-form; distinct no-connection messaging. | ✅ |
| 2.8 | **Confirmation gates** — orchestrator returns a confirmation proposal for `destructive` capabilities; `AIAssistant` shows Confirmer/Annuler; `ai-confirm-action` executes on confirm. | ✅ |
| 2.9 | **Darija fixes** — `norm.ts` whole-word only; `CREATE_PRODUCT` field bug fixed (registry); centime↔dinar interpretation + mandatory "= X DA" echo in the system prompt. | ✅ |
| 2.10 | **Analytics Q&A** — registry capabilities for aggregate questions: `reports_today`, `reports_top_products`, `products_low_stock`, `debts_list`, `expenses_totals`. (More — margins, TVA due — as those features land.) | ✅ |
| 2.11 | **Session memory** — orchestrator keeps the last 3 exchanges so follow-ups resolve ("w imprimih"). | ✅ |
| 2.12 | **Usage metering** — AI token usage accumulated in `config.ai_usage`; shown in desktop Settings (`getUsage` IPC). | ✅ |

**Acceptance:** from a cold install, the owner taps the mic on desktop or mobile and can navigate, search, create/update/delete products, ring a sale, add an expense, create/print documents, settle a debt, and ask analytics questions — in Darija/Arabic/French — with the key never leaving the server and core commands working offline.

---

## Phase 3 — Fiscal Core (TVA → Numbering → Facture conforme)

**Goal:** produce a legally compliant Algerian invoice and the data to declare it. The single most important business outcome. Each capability also registers in the AI registry (Phase 2) so the assistant can "make a conforme invoice / tell me my TVA".

| # | Task | State |
|---|---|---|
| 3.1 | **Compute TVA per line** from `products.tax_category_id` (`transactionService`: `computeLineTax` HT/TTC config, `recalculateTotals` HT subtotal + discount-scaled tax + TTC total); shown in POS totals, PaymentModal & printed docs; backfill migration (13) for upgraded DBs; profit excludes VAT. Adversarially reviewed + fixed. **Desktop ✅; mobile parity ✅ (3.1b).** | ✅ |
| 3.2 | Seed **9% Réduit + 0% Exonéré** tax categories (schema + Migration 12, create-if-missing); `tax-category-get-all` IPC; tax-category `<select>` in `ProductForm`. | ✅ |
| 3.1b | **Mobile TVA parity** — mobile `tax_categories` + tax columns + `TaxService`, POS shows HT/TVA/TTC & collects TTC, `create` stores per-line tax; product sync carries `tax_category_id`; desktop `/sync/transactions` **recomputes TVA server-side**; Whisper filename fix for mobile m4a. ✅ verified both apps. | ✅ |
| 3.3 | **Régime switch** réel vs IFU — config `regime`; IFU forces TVA 0 via `getProductTaxRate`; Settings UI (régime radio + prices-TTC toggle via generic `config` IPC); annual turnover + 8 000 000 DA near-ceiling warning. ✅ | ✅ |
| 3.4 | **Gapless sequential numbering** — `doc_sequences(doc_type,year)` + atomic `nextDocNumber()`; applied to sales (`BL-YYYY-000001`) & POs (`PO-YYYY-…`), replacing random numbers. Reused by 3.9/3.10. ✅ | ✅ |
| 3.5 | **Company Fiscal Identity settings** — `ReceiptConfig` extended (NIF/NIS/RC/Article/capital/forme juridique/bank); Settings form (`CompanyFiscalSettings`); invoice + receipt + PO headers now config-driven (hardcoded EURL MEKKI/H.Bouzid/Batna removed). ✅ | ✅ |
| 3.6 | **Buyer NIF/RC/NIS/AI** — `customers` columns (Migration 15) + `CustomerLookup` fields + threaded through `ReceiptData` → printed in the invoice buyer block. ✅ | ✅ |
| 3.7 | **Payment-mode selector** — `PaymentModal` method buttons (espèces/chèque/virement/CCP/CIB/Edahabia) + reference capture; payments CHECK relaxed (Migration 16); multi-tender retained. ✅ | ✅ |
| 3.8 | **Droit de timbre** — `computeTimbre` graduated (1/1.5/2% per 100-DA tranche, min 5, cap 10 000, exempt ≤300), on the cash-settled portion at completion (Migration 17 `timbre`); invoice Timbre/Net + amount-in-words. ✅ | ✅ |
| 3.9 | **Facture conforme** ✅ — A4 retitled **FACTURE N°**; HT line columns (PU HT = `line_total/qty`, Sous-Total = `line_total`) — closes the deferred TTC reconciliation; per-rate HT/TVA breakdown; Net = TTC + timbre; centime-accurate `amountInWords`; cachet/signature zone. | ✅ |
| 3.10 | **Facture d'avoir** ✅ — `createAvoir` (own AV- series, references original, negative amounts, reverses TVA, restocks); `void()` now restores stock; IPC + AI capability; invoice renders **FACTURE D'AVOIR**. | ✅ |
| 3.11 | **Anti-cash/AML** ✅ — configurable `aml_cash_threshold` (default off); `PaymentModal` warns on large cash (Décret 15-153); Settings field. | ✅ |
| 3.12 | 👤 Confirm all rates/thresholds with an accountant (see `legal_to_verify`). | 👤 |

**Acceptance:** a B2B sale prints a numbered "FACTURE" carrying seller+buyer fiscal IDs, per-rate TVA, timbre when cash, total in figures and words; numbering is gapless; corrections go through an avoir; and a monthly TVA recap can be produced.

---

## Phase 4 — Commercial & Wholesale

**Goal:** support the gros/détail distribution reality. (Each registers AI capabilities.)

| # | Task |
|---|---|
| 4.1 | ✅ **gros/demi-gros/détail** price tiers — `products.wholesale_price`/`semi_wholesale_price` (Migration 18) + `customers.price_tier`; ProductForm fields; CustomerLookup tier selector; POS `priceFor()` resolves by selected customer's tier (incl. AI-added items). |
| 4.2 | ✅ **Per-customer negotiated prices / grilles tarifaires** — `customer_prices` (Migration 19); `customer-price-map`/`-set` IPC; POS `priceFor()` checks negotiated price first; AI `pricing_set_customer_price`. |
| 4.3 | ✅ **Quantity/bulk price breaks** — backend-authoritative `pricingService.ts` (negotiated > tier > bulk break); `base_unit_price` (Migration 20) so qty edits recompute; `pricing_rules` CRUD IPC; PricingRules settings UI; AI `pricing_set_bulk_rule`. |
| 4.4 | ✅ **Units & colisage hierarchy** — `product_units` (Migration 21, factor to base `unite`); ProductForm colisage editor; `transaction_items.unit`/`unit_factor` (Migration 22, qty kept in base units); POS cart unit selector (lossless display in selling units); unité prints on facture + receipt lines. |
| 4.5 | ✅ **Marque + référence fabricant** search (product search matches marque/référence); **multi-supplier per article** — `product_suppliers` (Migration 23, ref/cost/préféré); ProductService get/setSuppliers; ProductForm multi-source editor. |
| 4.6 | ✅ **Multi-depot** (magasin + dépôt + chantier) — `warehouses` + `depot_stock` (Migration 24, additive: main magasin stays on stock_inventory so POS is untouched); `warehouseService` (per-location read/adjust, transfer, gapless **BT-** number, printed Bon de transfert); IPC + Depots settings UI; AI `inventory_transfer_stock`. |
| 4.7 | ✅ **Document flow** — `doc_type`+`source_doc_id` on transactions (Migration 25); `documentService` (devis/proforma/BC drafts, convertToSale chaining, monthly **facture récapitulative** consolidating BLs, A4 print with dynamic title); **Documents** nav screen; AI `document_create_quote`; PO **reliquat** (partial reception via `receivePartial`, reliquat-aware full receive, status 'partial'). |
| 4.8 | ✅ **Returns/exchanges** — `createAvoir(restock)` (restock vs scrap, scrap records a rebut movement without re-adding stock); **supplier returns** `supplier_returns` (Migration 26) + `createReturn`/`listReturns` (decrements stock, gapless **RETF-**); AI `supplier_return_create` + `sales_create_avoir` restock flag. (Exchange = avoir + new sale.) |
| 4.9 | ✅ **Kredi ledger** — `current_balance` maintained on complete/payment/void/avoir; `ledgerService` (balance, credit status, statement w/ running balance, aging buckets, partial settlement, stamped **relevé de compte** print); **supplier AP** (`supplier_payments` Migration 27, balance/statement/pay); **post-dated cheque register** (`post_dated_cheques`, AR+AP); POS credit-limit banner; DebtorsList Versement + Relevé; AI `customer_balance`/`customer_statement_print`. |
| 4.10 | ✅ **Reservations/acompte** (`reservations` Migration 28, increments stock `reserved_quantity`, fulfill→sale posting deposit as payment); **import landed-cost** (`po.applyLandedCost` allocates freight/customs by value → product cost); **consignation** (`consignments`, receive adds stock, settle tracks supplier-owed units); IPC + Reservations panel + AI `reserve_stock`. |
| 4.11 | ✅ **Cash-only companion scoping** (chosen) — mobile sends comptant/full-paid (consistent with desktop sync ingest that sets amount_paid=total to avoid phantom debt); explicit in-app note in checkout; credit/partial/discount + kredi ledger remain desktop-authoritative (mobile keeps Debtors/Settlement view+settle). |

---

## Phase 5 — Accounting & Declarations

**Goal:** be an excellent *feeder* for the accountant/DGI (not a full general ledger — lighter, recommended scope).

| # | Task |
|---|---|
| 5.1 | ✅ `accountingService` — **SCF/PCN account codes** (411/401/70/60/4457/44566/53…) attached at export; **journals ventes/achats/caisse** CSV (UTF-8 BOM, ";"-separated for Excel FR); Comptabilité screen export buttons. |
| 5.2 | ✅ **Monthly G50 worksheet** — TVA collectée by rate (from sale lines), TVA déductible derived from received POs (product tax rate × received qty), net/credit, timbre, IRG from payroll; CSV + AI `accounting_g50`. |
| 5.3 | ✅ **Annual état 104** (relevé des clients) — per-customer HT/TVA/TTC with NIF/RC/AI, CSV export. |
| 5.4 | ✅ **Jibaya'tic bundle** — structured G50 + ventes + achats CSV bundle (no auto-filing). |
| 5.5 | ✅ **Inventory valuation CMUP** (cost_price × on-hand) livre d'inventaire CSV; **physical inventaire + écart** workflow (enter counts → adjust stock + écart movements) in Comptabilité screen. |
| 5.6 | ✅ Optional **payroll** (`payrollService`, config `payroll_enabled` off by default) — IRG barème (configurable), CNAS 9%+25.5%=34.5%, CACOBATPH 12.21% BTP; employees + payslips (Migration 29); run-payroll UI. Rates flagged for accountant (like timbre, 3.12). |
| 5.7 | ✅ **Liasse fiscale** supporting figures (CA HT, TVA collectée/déductible, achats, stock value, charges, marge brute) annual CSV. |

---

## Phase 6 — Localization, Polish & Deploy

| # | Task |
|---|---|
| 6.1 | ✅ **Arabic bilingual documents** — `arabicWords.ts` (montant en lettres AR + Eastern-Arabic numeral helper); invoice prints bilingual title + Arabic amount when `bilingualArabic` config on; toggle in fiscal settings + onboarding. (Thermal Arabic shaping is OS/printer-handled.) |
| 6.2 | ✅ **First-run onboarding wizard** (`OnboardingWizard.tsx`) — company identity, NIF/NIS/RC/Article, régime, TTC, bilingual, default printer; gated by config `onboarded`. |
| 6.3 | ✅ **Auto-update scaffold** — `app-check-updates`/`app-version` IPC + `window.electron.app`; dynamic `electron-updater` load gated on config `update_feed_url` (inert until owner provisions; never crashes). Owner steps in DEPLOYMENT.md. |
| 6.4 | ✅ **Branding** — window title + productName GestionPOS, real root README + DEPLOYMENT.md. **(owner)** code-signing cert via `CSC_LINK`/`CSC_KEY_PASSWORD`, real icon. |
| 6.5 | ✅ **Cross-platform build scripts** — clean/prebuild/copy-assets rewritten as Node one-liners (verified); `test` script added. |
| 6.6 | ✅ **Tests + CI** — pure math extracted to `fiscalMath.ts`; Vitest suite (`tests/fiscalMath.test.ts`: TVA/timbre/cash-rounding); `vitest.config.ts`; GitHub Actions (`.github/workflows/ci.yml`: desktop lint+tsc+test+build, mobile tsc, gitleaks); `.gitleaks.toml`. |
| 6.7 | ✅ **Schema version stamp** — `PRAGMA user_version = 29` after migrations; migrations idempotent + try/catch; `resourcesPath` schema-load path already present. (Full one-schema-both-engines generation noted as future.) |
| 6.8 | ✅ **Sync hardening** — idempotent re-sync (skip if `transaction_number` exists → never double-insert/double-decrement), reports `skipped` count. (Device-prefixed numbers / mDNS / two-way deltas noted as future enhancements.) |
| 6.9 | ✅ **Data residency** (Loi 18-07) — config `data_residency_strict`; orchestrator refuses the cloud LLM when strict (offline fast-path only); settings toggle. |
| 6.10 | ✅ **Cash rounding to 5 DA** (`roundTo5` + config `cash_rounding_5` + PaymentModal quick-button). DZD billing N/A (no SaaS billing module). Sun–Thu week / Hijri = config-available, reports remain Gregorian by default (noted). |

---

---

## Redesign track (R) — "Liquid Glass" UI/UX (runs in parallel)

A premium, Apple-grade visual overhaul of **both** desktop and mobile. Full design language in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md). It runs as its own track because it's largely independent of the fiscal/AI backend work — but it should **not ship ahead of the security Phase 1**, and new screens (fiscal settings, AI panel) are built directly in the new system. Migration is incremental and non-breaking.

| # | Task | State |
|---|---|---|
| R1.1 | **Design-token foundation (desktop)** — `src/styles/tokens.css` (Apple palette, Inter + Arabic type, continuous radii, shadows, motion; light/dark via existing `data-theme`) layered over `index.css` | ✅ |
| R1.2 | **Glass material layer (desktop)** — `src/styles/glass.css` utilities (ultraThin→chrome), ambient mesh background, `@supports` + reduced-transparency/motion fallbacks | ✅ |
| R1.3 | **`<Glass>` React primitive (desktop)** — typed material wrapper component | ✅ |
| R1.4 | Wire foundation into `main.tsx`; verify build | ✅ |
| R1.5 | ✅ **Mobile token module** — Apple palette + continuous radii + `GLASS`/`AMBIENT` materials mirrored in `constants/theme.ts`; `<Glass>` primitive over `expo-blur` (`components/ui/Glass.tsx`). (reanimated optional — RN `Animated` suffices.) | ✅ |
| R2 | ✅ **Shell** — desktop ambient mesh backdrop + frosted-glass sidebar (with `@supports`/reduced-transparency fallbacks); mobile glass blur tab bar (expo-blur) with squircle radii. | ✅ |
| R3 | 🔄 **Primary flows** — global tokens propagate the Apple palette/type/shadows/squircle radii to POS, tiles, cart, payment sheet; new fiscal/AI/ledger surfaces built directly on the tokens. Per-pixel money-moment polish is incremental. | 🔄 |
| R4 | 🔄 **Management screens** — all screens inherit the refined token system; new screens (Documents, Comptabilité, fiscal settings, AI panel) built in it. Per-screen visual migration is incremental. | 🔄 |
| R5 | 🔄 **Polish** — reduced-transparency/motion + `@supports` fallbacks and RTL/Arabic type are handled in the token/glass layer; remaining micro-interactions/skeletons/dark-mode tuning + a11y/perf audit are incremental. | 🔄 |

> Redesign status: the **design system is fully built and applied globally** (R1 foundation + R1.5 mobile + R2 shells on both platforms; tokens drive every screen). R3–R5 are the plan's explicitly *incremental, non-breaking* per-screen visual refinement — the structure and materials are in place; pixel-level migration of each screen continues without risk to working flows.

---

## Full redesign — "Aurora Spatial" (2026-06-18) ✅

A complete visual rebuild replacing the old blue/navy theme. Spec: [AURORA_SPEC.md](AURORA_SPEC.md).

- **Identity:** orchid-violet accent (`--accent`/`--accent-grad`), **emerald = money** (`--success`), a **living aurora field** (violet+fuchsia+amber+emerald drift behind frosted glass), warm-neutral canvas, continuous squircles, spring motion. **Zero blue** anywhere (grep-verified across desktop/src + mobile).
- **Single source of truth:** `desktop/src/styles/tokens.css` + `glass.css`; `index.css` reduced to resets (old navy/slate palette removed to kill the dual-palette).
- **Shell:** floating frosted-glass sidebar + content panel over the aurora; aurora-hero login + glass keypad; glass onboarding.
- **Coverage:** all 16 desktop screens + 10 mobile screens restyled (two background multi-agent workflows, disjoint files) + adversarial contrast/consistency review with findings fixed (dark-mode `--text-on-accent` ink, `--fs-small`/`--scrim`/`--error-soft` tokens, POS double-scroll, focus rings, modal scrims). Desktop tsc+vite GREEN; mobile tsc GREEN.
- **White-label:** no fixed product brand — the app wears the **client's own business name** (from onboarding) as the wordmark with an abstract aurora mark fallback; "GestionPOS" removed from all shipping UI (sidebar, both logins, window title, installer metadata) and the name syncs to mobile.
- **Mandatory onboarding:** fiscal identity (raison sociale, forme juridique, NIF, NIS, RC, Article d'imposition) is required + validated; the wizard cannot be skipped or dismissed and gates "Suivant/Terminer" (needed for facture conforme).

**Acceptance (R1):** the app builds and immediately presents a refined Apple-grade palette/typography/shadows in light & dark, with reusable glass utilities + a `<Glass>` primitive available for screen migration — without breaking existing screens.

---

## Sequencing rationale

- Phase 1 unblocks safe networking and the AI key proxy that Phase 2 needs.
- Phase 2 ships the assistant over *today's* features, then **compounds**: every Phase 3–5 capability registers once and the AI gains it for free.
- Phase 3 is the highest *business* value (legal invoices) and is independent of Phase 2 — if the owner wants compliance before AI polish, Phases 2 and 3 can swap or run in parallel.
- Phases 4–6 broaden coverage and harden for multi-shop deployment.

## Cross-cutting "don't build" list (from the research)

- **No TAP** (abolished 01/01/2024).
- **No forced e-invoicing** for SME retail/wholesale yet (architect ready, don't mandate).
- **No hardcoded cash cap** (the general 500 000 DA cap isn't enacted — configurable, default off).
- **Don't be a full general ledger** unless explicitly chosen — feeder scope is lighter and recommended.

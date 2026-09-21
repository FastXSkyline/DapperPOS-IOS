# DAPPER_PLAN.md — Pivot to "Dapper", a clothing-retail POS

> Status: **All six phases built.** This document is the working plan for
> turning the former electrical-material/BTP wholesale-distributor codebase (GestionPOS) into
> **Dapper**, a pure-retail clothing-shop POS for the Algerian market. `PROJECT.md` was rewritten to
> match in Phase 5.
>
> All open questions in §6 were answered by the owner — see the **Decisions** subsection.
>
> ⚠️ **Nothing here has been click-tested in the running app.** Verification to date is
> schema/logic-level against real SQLite (`node:sqlite` scratch scripts), plus `tsc -b`, `eslint` and
> full production builds. Migration 30 was additionally confirmed applied to the owner's real
> 1434-product database, and the variant grid was driven end-to-end once in the real app before
> testing was handed back to the owner. **Each phase below ends with a "carried forward" list — read
> those before assuming a feature is done.**

---

## 0. Why this document exists

The user (Ilyes) is repurposing the existing GestionPOS codebase for a **clothing shop**, pure retail (no wholesale/gros/demi-gros, no BTP arm). The reference for "what a competitor POS looks like" is a screenshot of **TIEMPO-SOFT V2025**, an existing Algerian retail POS product. That screenshot was audited feature-by-feature against the current codebase (`desktop/electron/database.ts`, service layer, `src/components/*`) to find out what's already built, what's dangling/broken, and what's genuinely missing. This document is the resulting plan.

**Ground rules confirmed with the user:**
- Business model: **pure retail only**. No wholesale/demi-gros pricing tiers, no B2B bulk invoicing, no BTP/job-costing.
- Rename: **GestionPOS → Dapper**.
- Visual direction: **black & white** design system (replacing the current purple accent).
- This is a **discussion-first plan document**, not yet greenlit for code changes.

---

## 1. Current-state audit: what pic2 (TIEMPO-SOFT) has vs. what Dapper has today

Verified directly against `desktop/electron/database.ts`, the `electron/*Service.ts` files, and `src/components/*.tsx` — not against `core/schema.sql`, which PROJECT.md §6/§11 already flags as aspirational and out of sync with the real, live schema.

### 1.1 Toolbar (F1–F12) — top-level modules

| TIEMPO-SOFT feature | Dapper status | Evidence | Clothing relevance |
|---|---|---|---|
| Achats (F1) | ✅ Have it | `purchaseOrderService.ts`, `OrdersManager.tsx` | High |
| Ventes (F2) | ✅ Have it | `POSScreen.tsx`, `transactionService.ts` | High |
| Produits (F3) | ⚠️ Partial | `ProductForm.tsx` / `ProductList.tsx` exist, but no size/color variant editing | Critical — see §2 |
| Fournisseurs (F4) | ✅ Have it | `SupplierManager.tsx` | High |
| Clients (F5) | ✅ Have it (minimal) | `CustomerLookup.tsx`; `customers` table = `id, name, phone, customer_type, is_active` only | Medium |
| Situation Fournisseurs (F6) | ⚠️ Unconfirmed | No dedicated per-supplier statement view found; `ledgerService.ts` may partially cover it | Low-medium |
| Situation Clients (F7) | ✅ Have it | `DebtorsList.tsx` | Medium (relevant only if extending customer credit) |
| Consultation d'achats (F8) | ✅ Likely have it | `DocumentsScreen.tsx` + `purchaseOrderService.ts` | Medium |
| Consultation de ventes (F9) | ✅ Likely have it | `DocumentsScreen.tsx` | Medium |
| Charges (Ctrl+C) | ✅ Have it | `ExpenseManager.tsx` + `expenseService.ts` | Medium |
| **Pertes (Ctrl+P)** | ❌ **Missing** | No loss/write-off service or table anywhere in `electron/` | **High** — shrinkage (theft, staining, damage) is a real apparel-retail cost category, distinct from a routine stock adjustment |
| Statistiques (F10) | ✅ Have it | `AnalyticsDashboard.tsx` | High |
| **Etat de la journée (F12)** | ❌ **Missing — confirmed** | No Z-report/daily-close service found anywhere in `electron/`. This matches the existing audit note in `PROJECT.md` §6: "No refunds/Z-report." | **High** — any cash business needs an end-of-day reconciliation of till cash vs. system total |

### 1.2 Dashboard widgets

| TIEMPO-SOFT feature | Dapper status | Notes |
|---|---|---|
| Nombre / Stock min / Valeur totale du stock / Produits les plus vendus / Famille de produits | ✅ Plausibly coverable by extending `AnalyticsDashboard.tsx` | Standard analytics tiles |
| **Périmés (expired)** | ⚠️ Schema exists, concept doesn't map | `stock_movements.expiration_date` already exists (built for perishables/hardware shelf-life). Repurpose this dashboard slot as **"old/stale stock"** — unsold past N days — which is the real clothing-retail equivalent (drives markdown decisions) |

### 1.3 Right-hand panel

Mostly TIEMPO-SOFT's own vendor SaaS chrome — **not applicable, skip entirely**: Espace disque, Boutique en ligne, Module Cloud, Notification mail, Support technique, Actualité. These are TIEMPO-SOFT's own cloud/support/news features as a commercial vendor, meaningless for a self-owned Electron app.

- Statistiques produits/bons d'achats/bons de ventes/clients / Analyse produit → reasonable extensions of `AnalyticsDashboard.tsx`, not new subsystems.
- **Rendez-vous** → maps to the existing `reservations` table + `reservationService.ts`, which already models **layaway / mise de côté** (customer reserves an item, pays later) rather than literal scheduling. Repurpose, don't rebuild.
- **Carte de crédit CIB** → payment-method diversity is **already there**: `payments.payment_method` was migrated (migration 16, `database.ts:440`) to accept `cash / cheque / virement / ccp / cib / edahabia`. A literal **CIB card-terminal integration** (hardware/API) would be new work — separate discussion, not assumed in scope here.

### 1.4 Bottom bar

| TIEMPO-SOFT feature | Dapper status | Relevance |
|---|---|---|
| Coffre (safe/vault ledger) | ❌ Missing | Medium — cash-control discipline, not blocking |
| Ouverture du Tiroir caisse (drawer float open) | ❌ Missing | Medium-high — pairs with the missing Z-report; without a recorded opening float, end-of-day reconciliation can't be exact |
| **Cartes de fidélité (loyalty cards)** | ❌ Missing | **High for clothing** — repeat-customer retail benefits far more from this than the previous hardware/BTP-wholesale business did |
| Caisses réseaux (multi-till networked) | ⚠️ Partial | `syncServer.ts` (LAN sync) exists but per `PROJECT.md` §5/§6 has **no auth** and isn't a true multi-till session model. Security work first. |
| **Promotions** | ⚠️ Partial, cheaper than it looks | `pricing_rules` already has a `rule_type = 'promotional'` in `pricingService.ts` — the backend hook exists. No dedicated UI component found in `src/components/*`. |
| **Tailles et couleurs (sizes/colors)** | ❌ **Broken, not just absent** | See §2 — this is the load-bearing gap |
| Etat de la caisse (till status) | ⚠️ Unconfirmed | Ties to the Z-report gap above |

---

## 2. The critical gap: size/color variants

This is confirmed broken, not merely unbuilt:

- `stock_movements`, `transaction_items`, and `purchase_order_items` all carry a `variant_id INTEGER` column with `FOREIGN KEY (variant_id) REFERENCES product_variants(id)` (`database.ts:344` and others).
- **`product_variants` is never `CREATE TABLE`'d anywhere in the live `database.ts`.** It only exists in `core/schema.sql`, which is explicitly *not* the real schema per `PROJECT.md` §6/§11.
- `products.has_variants` was actively **stripped** by a later migration (`unwantedCols` list, `database.ts:224`), meaning variant support was scaffolded once and then partially reverted, leaving the FK references as dead pointers.
- The live `products` table today is minimal: `id, sku, barcode, name, category_id, supplier_id, retail_price, is_active` (+ `updated_at` from migration 2). One SKU = one flat product, no size/color dimension at all.

For a clothing shop this is not optional polish — **a "T-shirt" is not a sellable, stockable, or scannable unit without a size+color combination**, each with its own barcode and its own stock count. Every other feature below (POS scanning, stock counts, purchase orders, sales history, analytics) implicitly assumes this is solved. **This is Phase 1.**

---

## 3. Direction: what changes and what doesn't

### 3.1 Drop (pure retail, confirmed)
- Wholesale/demi-gros pricing tiers (`pricingService.ts` — `tier === 'gros'`, `tier === 'demi_gros'`, `product.wholesale_price`, `product.semi_wholesale_price`)
- Multi-depot transfer machinery (`warehouses`, `depot_stock`, `transfer_orders`, `transfer_items`) — built for a distributor with multiple stock points, not a single shop
- Any B2B/bulk invoicing assumptions tied to the BTP arm
- Decision needed: **rip out or leave dormant?** Recommendation: leave the tables/code dormant for now (cheap, reversible), strip the *business logic paths* that assume a tier system (pricing engine simplifies to a single `retail_price`), revisit full removal later once the rest of the pivot is stable.

### 3.2 Keep unchanged
- Algerian fiscal core (`PROJECT.md` §8: TVA, droit de timbre, facture conforme, IFU vs réel) — business-type-agnostic, applies to a clothing shop exactly as written.
- Security remediation roadmap (`PROJECT.md` §5/§6/Phase 1: leaked key, `RESET-9999` backdoor, plaintext PINs, unauthenticated sync server, arbitrary SQL over `dbQuery`/`dbRun`) — unrelated to business domain, still the top priority regardless of pivot.
- AI Capability Registry architecture (`PROJECT.md` §7) — domain-agnostic by design; new clothing-specific capabilities (e.g., "find size M in blue") register into it same as before.
- Core architecture (Electron/React/better-sqlite3, LAN sync to mobile, `docs/DESIGN_SYSTEM.md`'s Liquid Glass *mechanics* — only its color tokens change, not its motion/structure).

### 3.3 Add (new for clothing retail)
1. Size/color variant system (Phase 1, blocking)
2. Loyalty cards (Cartes de fidélité)
3. Pertes / shrinkage tracking
4. Daily close / Z-report + cash drawer float open/close
5. Promotions UI (backend rule type already exists)
6. Repurpose `expiration_date` dashboard slot → "stale stock" (unsold > N days)
7. Repurpose `reservations` → layaway/mise de côté (already close to this shape)

### 3.4 Explicitly out of scope (from pic2, vendor-specific, skip)
Espace disque, Boutique en ligne, Module Cloud, Notification mail, Support technique, Actualité, literal appointment scheduling, CIB physical terminal integration, Caisses réseaux multi-till (blocked on sync-server auth work first), Coffre safe ledger (nice-to-have, not blocking).

---

## 4. Rename & rebrand scope

Confirmed touch points found in the repo:

- `desktop/package.json` — `"productName": "Caisse"` → `"Dapper"` (also flows into the NSIS installer output name/branding).
- `desktop/src/styles/tokens.css` — `--accent: #9333ea` (purple, referenced through `--primary`, `--shadow-accent`, gradients) in both light (`:root`, line ~41) and dark (line ~163) blocks → replace with a black/white/grayscale scale. Mechanical token swap; `docs/DESIGN_SYSTEM.md`'s Liquid Glass *system* (translucency, motion, glass primitive) stays intact — only the palette changes.
- `PROJECT.md` §1 — business description ("distributor/retailer of electrical material... wholesale (gros/demi-gros)... BTP") needs a full rewrite to describe Dapper/clothing-retail once this plan is approved.
- `docs/*.md` — spot-check for domain-specific examples (e.g., "Schneider cable stock" in `PROJECT.md` §7) that should be swapped for clothing-shop equivalents.
- Any hardcoded UI strings/window titles referencing the old business — to be found during implementation, not fully enumerated here.

---

## 5. Phased implementation plan

Mirrors the structure of `docs/MASTER_PLAN.md` so it slots into the existing roadmap rather than replacing it. Security/correctness work from the existing Phase 1 (`PROJECT.md` §9) is **not** superseded by this — it still needs to land; this plan's Phase 1 below is domain-pivot work and can run in parallel or immediately after, to be sequenced with the user.

**Sequencing note:** mobile work (Phase 6) is deliberately last, per the user's explicit instruction. Desktop is the primary surface; mobile only needs to catch up once the desktop-side domain model (variants, roles data) is settled — building mobile role gating against a still-changing product/variant model would mean redoing it.

### Phase 1 — Variant system (blocking everything else) — **mostly built**

Two audit corrections found while implementing:

1. `transactionService.ts` was **already fully variant-aware** — `addItem`, `complete`, `void`,
   `createAvoir` and `checkStock` all read/write `variant_id` and branch on NULL correctly. The
   real gap was narrower than assumed: the `product_variants` table those paths referenced
   simply never existed.
2. `core/schema.sql` declared `product_variants` in an **EAV shape** (`variant_name` /
   `variant_value`, one row per attribute), which cannot express a size+colour *combination* as
   a single stockable SKU. Migration 30 detects that shape and rebuilds it; nothing had ever
   written to the table, so no data was at risk.

Done:
- ✅ **Migration 30** (`database.ts`) + matching `core/schema.sql`: one row = one sellable
  size×colour. Both axes optional and stored as `''` rather than NULL, so
  `UNIQUE(product_id, size, color)` actually holds (SQLite treats NULLs as distinct in UNIQUE).
  Carries `sort_order` so sizes read S < M < L < XL instead of alphabetically, and `updated_at`
  to support the planned website sync. Defensively adds `stock_inventory.variant_id` /
  `updated_at`, which the inline fallback schema omits.
- ✅ **`has_variants` is derived, never stored** — Migration 7 unconditionally strips such a
  column from `products`, so a stored flag would disappear on the next boot.
- ✅ **Stock aggregation fixed** — queries joined only the `variant_id IS NULL` row, so any
  variant product would have reported 0 stock. Now summed across all rows, covering both
  shapes. The `getCount` low-stock filter was also comparing per-row rather than per-product.
- ✅ **Variant CRUD** (`productService.ts`): `getVariants` / `setVariants` / `updateVariantStock`.
  `setVariants` **upserts on the natural key and soft-deletes**, unlike the DELETE+INSERT used
  by `setUnits`/`setSuppliers` — `transaction_items.variant_id` and `stock_movements.variant_id`
  reference these rows and `stock_inventory` cascades on delete, so recreating them would orphan
  sale history and wipe stock.
- ✅ Base-row stock is drained (with an audit movement) when a product gains variants, so old
  flat stock isn't double-counted as unsellable phantom quantity.
- ✅ IPC handlers, preload bridge, renderer types.
- ✅ **Size×colour grid editor** in `ProductForm.tsx`: chip editor per axis with presets
  (S–XXL, numeric 38–48, child 2A–12A), a quantity matrix, and graceful collapse to one axis or
  none. The single stock field disables itself when variants are on.
- ✅ **Variant picker at POS** — grid click and barcode scan now share one path, so scanning a
  garment prompts for size/colour before the line is created. Cart dedupe matches on
  `(product_id, variant_id)` so two sizes of one shirt stay separate lines, and the chosen
  size/colour is carried onto the line name for the receipt.

Carried forward:
- ⬜ **Purchase orders** (`purchaseOrderService.ts`, `OrdersManager.tsx`) still restock at
  product level; they need variant-level line items.
- ⬜ **Not yet exercised in the running app.** Verified so far: migration and upsert/soft-delete
  logic against real SQLite across both the legacy-EAV and fallback schema paths (IDs preserved,
  dropped combos deactivated not erased, re-adding revives the original row with its stock),
  plus `tsc -b`, `eslint` (no new findings) and a full `vite build`.

Acceptance (unchanged): create "T-shirt Basic" with sizes S/M/L/XL × colours Black/White under
one shared barcode; scanning at POS prompts a size/colour picker; completing the sale decrements
only that variant's stock.

### Phase 2 — Daily operations (Z-report, drawer, promotions) — **built**

Done:
- ✅ **Migration 31**: `cash_sessions` (opening float, counted/expected cash, variance, gapless
  `Z-YYYY-NNNNNN` number stamped at close) + `cash_movements` (petty-cash payouts, safe drops,
  top-ups).
- ✅ **Key modelling decision — cash is attributed by PAYMENT time, not sale time.** A credit sale
  settled in cash three days later moves *that* day's drawer, not the day the goods left. So every
  window runs over `payments.created_at`, and no `session_id` column is needed on `transactions`.
- ✅ **`cashSessionService.ts`**: open / close / current / list / addMovement / report.
  Expected drawer = opening float + cash payments + drawer top-ups − payouts − cash expenses.
  Refuses to open a second session while one is open (two open drawers cannot reconcile).
- ✅ **Expenses count as drawer cash-out.** The `expenses` table has no payment-method column and
  in a shop they come out of the till, so they are subtracted — documented in the service.
- ✅ **Avoirs are reported but not auto-deducted.** `createAvoir` writes no payment row, so a credit
  note only moves drawer cash if a payout was also recorded. The screen says so explicitly rather
  than silently guessing.
- ✅ **`CashSessionScreen`**: open-till form, live tiles (float / cash in / non-cash / movements /
  expenses / expected), sales + per-payment-method breakdown, drawer movement entry, and a close
  panel that shows the variance live as you type the counted amount. History of past Z-reports.
- ✅ **Migration 32**: `pricing_rules` was declared **only** in `core/schema.sql`, never in a
  migration — so any DB built from the inline fallback schema had no such table and every
  `PricingService` call would throw. Now created defensively, same fix as Migration 12 for
  `tax_categories`.
- ✅ **`PromotionsManager`**: create/toggle/delete promotions by article or family, percentage /
  fixed / imposed price, optional date window and minimum quantity. It writes `pricing_rules` rows
  with `rule_type='promotional'`, which `applyBulkPrice` already consults on every POS line — so a
  promotion is live at the till the moment it is saved, with no extra wiring.
- ✅ Nav + RBAC: `cash` and `promotions` views registered. **Cashiers get `cash`** (they run the
  till, so they open and count it down); promotions stay owner/manager.

Verified: Z-report reconciliation tested against real SQLite — card/cheque correctly excluded from
the drawer, an old debt settled today lands in today's till, out-of-window sales excluded, expected
drawer and variance both correct. Plus `tsc -b` and a full `vite build`.

Not verified: no click-through in the running app (handed to the owner for manual testing).

Carried forward:
- ⬜ Closing a session does not yet *lock* the day's transactions against edits.
- ⬜ `PromotionsManager` has one `react-hooks/set-state-in-effect` lint finding on the standard
  mount-load pattern — a known-noisy heuristic that `App.tsx` already trips identically, and which
  the structurally identical `CashSessionScreen` does not. Cosmetic, not a defect.

### Phase 3 — Customer & loss tracking — **mostly built**

Done (Migration 33):
- ✅ **Loyalty** (`loyaltyService.ts`): points per DZD spent, redeemed as a discount, per the §6
  decision. `customers.loyalty_points` is a cached balance; `loyalty_entries` is the ledger that
  explains it, and the balance is always **recomputed from the ledger** rather than incremented in
  place, so the two cannot drift.
- ✅ **Earning is idempotent.** `UNIQUE(transaction_id, direction)` means a retried sale completion
  cannot award twice — which matters because `complete()` has a schema-repair retry path. The earn
  call is wrapped so a loyalty failure can never block a sale from completing.
- ✅ POS integration: the cart footer shows the customer's balance and a **Utiliser** button once
  they clear the configured minimum; redeeming is capped so points can never exceed the amount due.
- ✅ **Pertes** (`lossService.ts`, `LossesScreen`): shrinkage write-offs by reason
  (vol / casse / taché / égaré / périmé / autre), deliberately separate from routine stock
  corrections — a correction fixes a miscount, a loss destroys value the shop paid for. Each entry
  **snapshots the unit cost** at the time, so later price changes don't rewrite history. Stock
  movement and loss row commit in one transaction, so stock can never drop without a record of why,
  and an over-quantity loss is refused with no orphan row. Losses are revertible (goods back to stock).
- ✅ Variant-aware throughout: a loss names the exact size/colour, and a variant's own cost overrides
  the product's for valuation.
- ✅ **Layaway**: `reservations.variant_id` added, so a mise de côté can hold a specific size/colour
  rather than just a product (closes half of the gap logged during the Phase 1 audit).

Verified against real SQLite: correct point maths, retry does not double-award, walk-in sales earn
nothing, overspend and double-redeem both refused, per-variant stock decrement, variant cost override,
insufficient-stock refusal leaving no orphan row, and shrinkage cost summing by reason.

Carried forward:
- ⬜ **Voiding a sale does not return redeemed points.** The ledger entry is written at redemption
  time, so a cancelled sale currently needs a manual `LoyaltyService.adjust`. Worth wiring into
  `void()`/`createAvoir()`.
- ⬜ `reservationService.ts` still creates product-level sale lines and has no UI treating
  reservations as layaway — the column exists, the flow does not yet use it.
- ⬜ Stale-stock dashboard tile (repurposing the "Périmés" slot) not built.
- ⬜ No loyalty settings UI — config lives in `config` keys with sensible defaults
  (1 point per 100 DZD, 1 point = 1 DZD, 100-point minimum).

### Phase 4 — Retail-only cleanup — **built**

Pricing now resolves in one unambiguous way (highest precedence first):
1. per-customer negotiated price (`customer_prices`) — a personal agreement, not a tier
2. `products.retail_price` — the shelf price
3. promotions / quantity breaks (`pricing_rules`)

Done:
- ✅ `tierBasePrice(product, customer)` → **`shelfPrice(product)`**. The wholesale tier branch is
  gone from the called path; `resolveUnitPrice` no longer even loads the customer row to price an item.
- ✅ The POS carried a **second copy** of the tier logic in `priceFor()` — now collapsed to the same
  rule, so the till and the backend cannot disagree.
- ✅ **Prix Gros / Prix Demi-Gros removed from `ProductForm`** and the **price-tier selector removed
  from `CustomerLookup`**. The shop is no longer asked for prices and tiers that nothing reads.
- ✅ **Dormant, not deleted** (per the §6 decision): `products.wholesale_price` /
  `semi_wholesale_price`, `customers.price_tier`, and the `warehouses` / `depot_stock` /
  `transfer_orders` tables plus `warehouseService.ts` and its IPC all remain intact. `DepotSettings`
  was moved to `src/components/DepotSettings.tsx` and is simply not imported — the whole
  multi-dépôt/chantier feature is one import away from returning, rather than deleted.
- ✅ **Cut-to-length de-hardcoded.** `PaymentModal` selected "portion" lines by matching product
  names containing `cable` or `tube` — an artefact of the electrical-supplies origin. It now keys off
  the line's `unit === 'metre'`, so it never appears for ready-to-wear but still works for tissu or
  ruban sold by length. `TransactionItem` gained the `unit` / `unit_factor` fields it already had in
  the DB (Migration 22) but not in the type.
- ✅ UI copy swept: unit list reordered for clothing (pièce / paire / lot, métre kept for fabric),
  brand placeholder `BOSCH, Samsung…` → `Zara, Adidas, Lacoste…`, AI example prompt `câble` → `tricot`.

Verified against real SQLite: a customer still flagged `price_tier='gros'` with wholesale columns
populated (1200/1500) now correctly pays the 2000 shelf price; negotiated prices still honoured;
a 30 % promotion resolves to 1400; a category quantity break at qty 3 wins over the promotion at 1200;
promotions correctly do **not** stack onto a negotiated price. `tsc -b` clean, `pricingService.ts`
lint-clean, full build passes.

Not done here:
- ⬜ `PROJECT.md` §1 and the `docs/*` domain rewrite — deliberately left to **Phase 5**, where the
  rename gives it something accurate to describe.

### Phase 5 — Rebrand — **built**

- ✅ **`productName` "Caisse" → "Dapper"**, `appId` → `com.dapper.pos`, installer artifact →
  `Dapper Setup ${version}.exe`, window title and white-label fallbacks → Dapper, page title → Dapper.
- ⚠️ **`package.json` `name` was deliberately NOT changed.** Electron derives `userData` from `name`
  in dev (`Roaming/desktop`) and from `productName` when packaged — renaming either **moves the
  database**. Checked first: no `Roaming/Caisse` exists, so no packaged data was orphaned by the
  productName change, and the live 1434-product dev DB under `Roaming/desktop` is untouched. Renaming
  now was safe precisely because nothing had shipped under the old name yet.
- ✅ **Monochrome palette** in `tokens.css`, both modes. Light = ink accent (`#171717`) on neutral
  greys; dark = inverted, paper accent (`#fafafa`) on near-black. Every violet/fuchsia/amber token —
  accent, gradients, aurora field, shadows, glass borders, skeletons — is now pure neutral, and
  `--lg-saturate` dropped 185% → 100% (there is no hue left to enrich; boosting it only muddied the greys).
- ✅ **Semantic colour deliberately kept** as the single exception: a short till, an oversell warning
  or a failed save has to be unmistakable, and grey cannot carry that. Muted in light, lifted in dark.
- ✅ Hardcoded purple hunted down outside the tokens: the **PIN login hero** (its whole aurora was
  literal violet/fuchsia radials) and the **analytics charts**.
- ✅ **Charts reworked against the dataviz rules, not by eye.** Greyscale cannot do *categorical*
  identity — with no hue there is nothing to separate "product A" from "product B" — so:
  - ranked pie slices use a **validated ordinal ramp** (monotone lightness, adjacent ΔL ≥ 0.06,
    light end clears 2:1 on its surface), stepped **separately for dark**, not flipped;
  - the two-series area chart pairs its lightness gap with a **dashed stroke**, so identity never
    rests on colour alone;
  - top-product bars now all wear **one ink** — length already encodes revenue.
  Two pre-existing rule violations were fixed on the way: the pie **cycled** colours
  (`COLORS[i % len]`, which makes a small category impersonate the largest) and the nominal
  product bars were coloured **by rank**.
- ✅ **`PROJECT.md` rewritten**: Dapper/clothing-retail framing with the GestionPOS history kept as
  explicit context, variant-aware file map, corrected issues table (Z-report now exists; oversell
  still unguarded and the live DB already holds negative stock), monochrome design rules, both
  roadmaps reconciled, and new gotchas (idempotent migrations, the thinner inline fallback schema,
  the `userData`-follows-`name` trap, `better-sqlite3` ABI vs `node:sqlite`).

### Phase 6 — Mobile role-gating (deliberately last)

Current state, verified: `mobile/App.tsx:26` already tracks `user: { id, name, role: string }` from PIN login, but **no screen in `mobile/components/*` currently gates on it** — `InventoryScreen`, `ReportsScreen`, `POSScreen`, `DebtorsScreen`, `ExpensesScreen`, `OrdersScreen`, `SupplierScreen`, `SettlementScreen`, `SettingsScreen`, `ProductScanner` all appear equally reachable regardless of role today. Desktop already has a role matrix to reuse as reference: `core/permissions.ts` defines `UserRole = 'owner' | 'manager' | 'cashier' | 'warehouse'` with a `PERMISSIONS` matrix and a `hasPermission()` helper — this is the pattern to extend to mobile, not reinvent.

Requirement from the user: **two effective tiers on mobile**
- **Employee** — scan-and-sell only: `ProductScanner.tsx` (lookup) plus enough of `POSScreen.tsx` to complete a sale on the item(s) just scanned (picking the variant per the Phase 1 picker flow, taking payment). No reports, no financials, no supplier/customer data, no inventory editing, no settings.
- **Manager** — sees and can do everything the mobile app offers (all existing screens).

**Role naming — decided: no new role.** `cashier` already meant exactly "canProcessSales, nothing
else" in `core/permissions.ts`, so it *is* the employee tier. Mapping:
`owner`/`manager` → everything · `cashier` → POS only · `warehouse` → Inventory only.

Done:
- ✅ **`mobile/services/permissions.ts`** — role → allowed tabs, mirroring `core/permissions.ts`.
  Deliberately duplicated rather than imported: mobile is a separate Expo package and Metro does not
  resolve across the boundary (verified — mobile imports nothing outside its own directory). The file
  says so and points at the source of truth.
- ✅ Gating applied in **three** places, not one: the tab bar renders only permitted tabs, the
  rendered screen re-checks (falling back to the role's *own* landing tab, since `warehouse` has no
  POS), and **`VoiceAssistant.onNavigate` routes through the same gate** — otherwise a spoken command
  would have walked an employee straight into a screen the tab bar hides.
- ✅ Each role lands on its own first permitted tab at login.

**The scanner lives inside `POSScreen`**, so "scan and sell" is exactly one tab: the employee scans,
picks a size/colour, takes payment, and has no other destination on screen.

#### Mobile variant support — required for the employee flow to be *correct*

Mobile was entirely variant-unaware: no `product_variants` table, no `variant_id` on
`transaction_items`, flat `addToCart(product)`. An employee scanning a shirt would have sold it with
no size. Two **stock-corruption bugs** surfaced and were fixed:

- 🐛 **`/sync/products` duplicated variant products.** It joined `stock_inventory` directly, so a
  garment with 6 sizes returned 6 copies of itself, each carrying one size's quantity. Now joined
  through a grouped subquery. *Demonstrated: 5 rows for 2 products → 2 rows, stock summed correctly.*
- 🐛 **Selling one size decremented EVERY size.** Both the mobile local sale and the desktop
  `/sync/transactions` ingest ran `UPDATE stock_inventory … WHERE product_id = ?` with no variant
  clause. *Demonstrated: selling 1×M took S, M and L from 10 → 9 each; now only M moves.*

Also: variants ride along in the sync payload (full active set, replaced wholesale — a delta on the
parent's `updated_at` would leave a size deleted on the desktop sellable on mobile forever);
`variant_id` added to mobile `transaction_items` and carried upstream on upload; the desktop ingest
now writes a `stock_movements` audit row for mobile sales (it previously moved stock silently, unlike
the desktop path); receipts use `COALESCE(NULLIF(ti.product_name,''), p.name)` so the printed line
keeps its size; and the mobile POS gained a size/colour picker with out-of-stock sizes visible but
unselectable.

Carried forward:
- ⬜ `ProductScanner` matches the **product** barcode only — per-variant barcodes aren't scanned
  (consistent with the Phase 1 shared-barcode decision, but revisit if per-variant labels get printed).
- ⬜ No loyalty or promotions UI on mobile; those stay desktop-only for now.
- ⬜ Sync-server auth hardening (`PROJECT.md` §5) remains a prerequisite for trusting *any*
  mobile↔desktop flow. Tracked in the security roadmap, not here.
- ⬜ **Not run on a device or emulator.** `tsc --noEmit` passes for mobile and the desktop builds,
  but no mobile screen has been opened.

---

## 6. Decisions (previously open questions, now resolved)

All resolved by the user; recorded here so implementation doesn't re-litigate them.

1. **Variant dimensions** — ✅ Size and color are both **optional per product**: a product can have neither, size-only, color-only, or both. No forced grid.
2. **Barcode strategy** — ✅ **Shared product barcode**, not per-variant. Scanning at POS resolves to the product, then the cashier manually picks size/color before add-to-cart. No new per-variant label-printing workflow needed in Phase 1.
3. **Loyalty card mechanics** — ✅ **Points per DZD spent**, redeemable as a discount on a future sale. Requires a points-balance field on `customers` plus redemption logic at checkout.
4. **Z-report priority** — ✅ Stays in **Phase 2**, right after variants — cash control matters early for a cash-heavy retail shop.
5. **Wholesale code** — ✅ **Leave dormant.** Simplify the active `pricingService.ts` code path to flat retail pricing; don't delete the tier/multi-depot tables or logic yet.
6. **Mobile role mapping** — ✅ Employee tier is **scan-and-sell**, not read-only: `ProductScanner.tsx` plus enough of `POSScreen.tsx` to complete a sale on scanned items. Everything else (reports, financials, supplier/customer data, inventory editing, settings) is manager/owner only. **Settled at implementation: no new role** — `cashier` already meant "canProcessSales, nothing else" in `core/permissions.ts`, so it is reused verbatim as the employee tier (`warehouse` → Inventory only).

---

## 7. Non-goals (explicit, to prevent scope creep)

- No online store / e-commerce sync (Boutique en ligne) in this plan.
- No CIB physical terminal integration in this plan (payment-method *value* already supported; hardware integration is separate).
- No multi-till networked cash registers in this plan (blocked on sync-server auth hardening first, per existing `PROJECT.md` §5/§9 Phase 1).
- No literal appointment/scheduling module — `reservations` is being repurposed as layaway, not extended into a calendar feature.

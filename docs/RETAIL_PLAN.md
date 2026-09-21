# RETAIL_PLAN.md — multi-store retail management on top of Dapper

> Phase 0 architecture record for the two-store build (Costume + Casual).
> Supersedes nothing: [DAPPER_PLAN.md](DAPPER_PLAN.md) (clothing pivot) and
> [MASTER_PLAN.md](MASTER_PLAN.md) (security + fiscal tracks) still apply.
> This document covers what the retail-management brief adds on top of them.

---

## 1. Current project analysis

Dapper is **not** an empty repo and **not** a cashier toy. It is an Electron 34 +
React 19 + TypeScript desktop app over `better-sqlite3`, with 33 idempotent
migrations, a Fastify LAN server on `:4000`, a Firestore relay for the phone, and
a service layer that already implements a large share of the brief.

**Already built and connected to the real database** — do not rebuild:

| Brief section | State in Dapper |
|---|---|
| §4 variants (size × colour) | ✅ `product_variants`, one row per sellable SKU, `UNIQUE(product_id,size,color)` |
| §25/§26 products, hierarchical categories | ✅ `products`, `categories.parent_id` |
| §36–38 suppliers, purchase orders, partial receiving | ✅ `purchaseOrderService.ts` |
| §39/§40 cash sessions, drawer movements, Z-report | ✅ `cashSessionService.ts` |
| §41 expenses | ✅ `expenseService.ts` |
| §32 promotions | ✅ `PromotionsManager.tsx` + `pricingService.ts` |
| §35 loyalty | ✅ `loyaltyService.ts`, idempotent ledger |
| §33 customers, debt | ✅ `customers`, `DebtorsList.tsx` |
| §9 fast PIN login | ✅ `PinLogin.tsx`, PINs hashed (Migration 11) |
| §15 receipts, §72 documents | ✅ `receiptService.ts`, `invoiceService.ts`, `labelService.ts` |
| §18 stock movements | ✅ `stock_movements`, `stockService.ts` |
| §76 transaction numbering | ✅ gapless per-type per-year `doc_sequences` (Migration 14) |
| shrinkage / pertes | ✅ `stock_losses` |

**Missing — this plan's actual scope:**

| Gap | Why it matters |
|---|---|
| **Stores are not first-class** | A dormant `warehouses` table exists but is product-level (no `variant_id`), unreferenced by sales, cash sessions or expenses. Everything in the brief keys off store. |
| **No POS terminals** | §39 requires a register session per terminal. |
| **No returns / exchanges / refunds** | Zero occurrences in the schema. For a clothing shop this is the single biggest hole. |
| **No audit log with before/after** | `activity_logs` records an action string only — §59 needs old/new value. |
| **No notifications, no sales targets** | §58, §44. |
| **Sizes and colours are free text** | §27/§28 require configurable reference lists; free text means `Bleu Marine` and `bleu marine` split a report. |
| **No brands** | §25. |
| **No inventory counts** | §21. |
| **No oversell guard** | `checkStock` only warns; the live DB already carries negative stock. §62 and §78. |
| **Coarse permissions** | 10 hardcoded booleans, no discount cap per role. §8, §31. |
| **Analytics gaps** | sales by size, by colour, by hour, store comparison, period comparison, dead stock. §48–§55. |
| **No multi-terminal realtime** | §61. |

---

## 2. Recommended architecture — store-server topology

**Decision (confirmed with the owner).** Each store runs **one server PC** holding
that store's SQLite database and the existing Fastify server. Other PCs in the same
store are **thin clients over the shop LAN**. A central PostgreSQL on cPanel is a
**read-mostly reporting mirror** behind the owner's website.

```
        COSTUME STORE                          CASUAL STORE
   ┌──────────────────┐                   ┌──────────────────┐
   │  PC-1  SERVER    │                   │  PC-1  SERVER    │
   │  SQLite (truth)  │                   │  SQLite (truth)  │
   │  Fastify :4000   │                   │  Fastify :4000   │
   └───────┬──────────┘                   └───────┬──────────┘
       LAN │                                  LAN │
   ┌───────┴──────────┐                   ┌───────┴──────────┐
   │  PC-2  client    │                   │  PC-2  client    │
   └──────────────────┘                   └──────────────────┘
           │                                      │
           └──────────── push-up ────────┬────────┘
                                         ▼
                            ┌────────────────────────┐
                            │  cPanel PostgreSQL     │
                            │  + owner website       │
                            │  (reporting mirror)    │
                            └────────────────────────┘
```

**Why not "every PC talks to cPanel Postgres"** (what the brief literally asked for):

1. **Availability.** Shared cPanel hosting over Algerian ADSL on the hot path means a
   dropped line stops both shops selling. A POS that cannot sell when the internet
   blinks is not a POS.
2. **Latency.** Every barcode scan becomes an internet round trip. §10 demands the
   cashier be fast.
3. **Reachability.** cPanel PostgreSQL is normally bound to localhost; remote access
   needs a host allowlist, and shop ADSL is on a dynamic IP.
4. **It is not needed for correctness.** **Inventory is per store.** Two PCs racing for
   the last suit are always in the *same* store, so the lock only has to be
   store-local. A store-local server gives a real transaction boundary for free.

**Consequence, stated plainly:** cross-store operations are *eventually* consistent.
Store A's view of store B's stock is as fresh as the last sync. Stock **transfers** are
therefore modelled as an explicit two-phase workflow (ship decrements the source,
receive increments the destination) rather than an instantaneous move — see §7 below.
This is the correct model regardless of topology, because goods physically travel.

**Realtime within a store** is a WebSocket/SSE channel on the existing Fastify server:
the server PC broadcasts `inventory.updated`, `sale.created`, `cash_session.updated`
to every client in that store. **Realtime across stores** is the push-up interval, not
a socket, and the UI must label cross-store figures with their freshness.

**Offline, stated honestly (§63).** A thin client that loses the LAN **stops selling**
and says so. It does **not** queue sales locally. Queuing sales on a client while the
server keeps selling the same variant to another terminal is exactly the oversell the
whole design exists to prevent. The server PC itself is never "offline" — it *is* the
database. This is a deliberate limitation, not an omission.

---

## 3. Entity model (delta over the existing schema)

New tables and columns only; the 33 existing migrations are untouched.

```
stores ──┬─< pos_terminals ──< cash_sessions
         ├─< stock_inventory   (store_id + variant_id)   ← existing table, gains store_id
         ├─< transactions      (store_id, terminal_id)   ← existing table, gains both
         ├─< expenses          (store_id)
         ├─< stock_movements   (store_id)
         ├─< sales_targets     (store / employee / company)
         └─< user_stores >── users        (which stores an employee may work in)

products ──< product_variants ──< stock_inventory (per store)
    │              │
    │              └─ size_id → sizes,  color_id → colors   (reference lists, free text kept)
    ├─ brand_id → brands
    └─< bundle_components  (suit = jacket component + trouser component)

transactions ──< sale_returns ──< sale_return_items
                      │
                      └─ exchange_transaction_id → transactions   (the replacement sale)

inventory_counts ──< inventory_count_items
stock_transfers  ──< stock_transfer_items      (variant-level, DRAFT→…→RECEIVED)

audit_logs        (user, action, entity, entity_id, old_value, new_value, store, device)
notifications     (severity, type, store, entity, read_at)
permissions ──< role_permissions >── roles
```

**Suits (§5) — components + optional set.** Jacket and trouser are ordinary products,
each with its own size variants and its own per-store stock. A *set* is a product of
type `bundle` whose `bundle_components` name the jacket and trouser products; the sale
picks a variant for each component and draws both down. Mismatched sizes work
naturally, and a lone jacket is still sellable. No combinatorial explosion.

**Sizes and colours** become reference tables, but `product_variants.size`/`color`
**keep their text columns**. The text is what historical sales already reference and
what the UNIQUE constraint is built on; the reference tables add ordering (44 < 46 <
48, S < M < L), an optional hex swatch, and a canonical spelling. Migration backfills
the reference lists from the distinct values already in the database.

---

## 4. Numbering, money, and data integrity

- Reuse the existing gapless `doc_sequences` for new document types:
  `RET-2026-000001`, `EXC-2026-000001`, `TRF-2026-000001`, `CNT-2026-000001`.
  Allocation happens **inside** the same transaction as the document insert.
- **A completed sale is immutable.** Returns and exchanges create new documents that
  reference the original; nothing edits or deletes a sale. This also satisfies the
  Algerian *facture d'avoir* rule already documented in ALGERIA_REQUIREMENTS.md.
- **Historical prices are frozen on the line.** `transaction_items` already stores
  `unit_price`; returns refund the line's stored price, never today's price (§92).
- Every stock change writes a `stock_movements` row. No silent writes (§18).
- Multi-statement mutations run inside `getDatabase().transaction(() => …)()`.

## 5. Permissions

Replace the 10 hardcoded booleans with a `permissions` catalogue + `role_permissions`
join, seeded to the brief's list (`sales.create`, `sales.refund`, `inventory.adjust`,
…). Roles: `owner`, `manager`, `cashier`, `warehouse` — the four `users.role`'s CHECK
constraint permits, `warehouse` being the brief's STOCK_MANAGER. Numeric limits (max
discount %) live on the role row.
**Enforced in the service layer**, not the UI — the renderer only hides buttons.

## 6. Realtime events

`inventory.updated` · `sale.created` · `sale.returned` · `transfer.created` ·
`transfer.received` · `cash_session.updated` · `notification.created`

## 7. Transfers (§20, §92)

`DRAFT → REQUESTED → APPROVED → PREPARED → SHIPPED → RECEIVED`, variant-level.
Source stock decrements **on SHIPPED**, destination increments **on RECEIVED**.
Receiving is idempotent on `(transfer_id, state)` so a double-click or a retried sync
cannot receive twice. Stock in flight is visible as a distinct "in transit" figure.

## 8. Implementation phases

| Phase | Content | State |
|---|---|---|
| **0** | This document. Schema foundation: migrations 34–41, `user_version` 41. | ✅ done, 17 tests |
| **1** | Stores, terminals, user↔store, granular permissions, audit log. | ✅ services + IPC + store switcher + settings UI |
| **2** | Reference data (brands/sizes/colours), suit bundles, product screen. | schema only |
| **3** | Store-scoped inventory + **oversell guard** + movements ledger. | ✅ **live on the sale path**, 32 tests |
| **4** | Returns, exchanges, refunds — service + POS flow. | ✅ refunds **and** exchanges, service + UI, 40 tests |
| **5** | Store-aware POS: terminal registration, thin-client mode, realtime. | ✅ complete — realtime (11 tests) + thin-client mode (28 tests) |
| **6** | Variant-level store transfers with the full workflow. | ✅ service + UI, 25 tests |
| **7** | Inventory counts, low/out/dead stock, notifications. | ✅ complete — counts (28 tests) + notification centre (23 tests) |
| **8** | Analytics: size, colour, hour, store comparison, period comparison, targets. | ✅ complete — reports (22 tests) + targets (24 tests) |
| **9** | UI redesign to the Elegance mockup. | ✅ tokens + new screens; existing screens not relaid |
| **10** | cPanel PostgreSQL push-up + owner website mirror. | ✅ desktop half, 19 tests; **website half not built** — see [CLOUD_MIRROR.md](CLOUD_MIRROR.md) |

### How an exchange works

`ReturnService.exchangeWithNewSale()` builds, pays for and completes the replacement
sale **and** records the return, inside one transaction. The UI must not drive those
four steps itself: a failure between them — most often the replacement being out of
stock — would leave a completed sale that no return points at, with the customer
holding goods while the returned garment was never booked back in.

The replacement is a normal, fully-paid sale, settled first with the credit from the
returned goods and then with cash/card for any shortfall:

```
new 40 000 = store_credit 35 000 + cash 5 000     → balance −5 000 (customer tops up)
new 30 000 = store_credit 30 000                  → balance +5 000 (shop pays out)
```

Credit is **capped** at the replacement's total; the excess is refunded through the
return's balance rather than left as change due on the sale. Droit de timbre falls out
correctly for free — it is computed on the cash portion, and store credit is not cash.

### Reporting definitions (§79)

Stated once, in `analyticsService.ts`, and shown in the same words on the screen:

```
Gross revenue = Σ total_amount of COMPLETED sales in the window (TTC)
Returns       = Σ returned_value of completed returns
Net revenue   = Gross revenue − Returns
COGS          = Σ quantity × unit_cost over the sold lines
Gross profit  = Net revenue − COGS
Gross margin  = Gross profit ÷ Net revenue × 100
```

**Expenses are not deducted anywhere**, so nothing in that module may be called *net
profit*. A return is charged to the store that SOLD the goods, not the one that took
them back, so a cross-store return does not dent the wrong shop's revenue.

**Migration 42 freezes `unit_cost` on the sale line.** Before it, profit joined
`products.cost_price` — TODAY's purchase price — so a supplier increase silently
rewrote every margin the shop had ever earned. Lines written before that migration
stay NULL and fall back to the current cost; `estimatedCostLines` counts them and the
UI says so rather than passing an estimate off as a measurement.

### How an inventory count works

Two rules do all the work, both about the fact that a count takes hours while the
shop keeps selling:

1. **`expected_qty` is snapshotted per line, at the moment that line is counted** —
   never once at session start. Otherwise every garment sold during the count looks
   like shrinkage.
2. **Applying writes a DELTA, never an absolute.** The finding is "3 fewer than the
   system believed when I counted this rail", and that is still true an hour later
   even though two more have since sold. Writing the counted figure would erase those
   sales.

**Uncounted lines are ignored, never treated as zero** — a count abandoned half way
through must not wipe the stock of everything nobody reached. Applying goes through
`InventoryService.setAbsolute`, deliberately bypassing the oversell guard: an
adjustment is precisely the operation allowed to correct stock to any value,
including revealing that it is negative. Counting needs `inventory.count`; applying
needs `inventory.adjust` — a higher bar, because applying moves money.

### How notifications work

`notificationService.sweep()` re-evaluates every rule against the CURRENT state and
raises what is true. Pull, not push: a shop PC is not always running, and a rule that
only fired at the instant a condition arose would miss everything that changed while
the machine was off.

Migration 41's **partial unique index on `dedupe_key WHERE read_at IS NULL`** is what
makes the centre usable — one open alert per condition, enforced in the database so
two concurrent sweeps cannot slip a duplicate through. Partial on purpose: dismissing
means "I have seen this", not "never tell me again", so the same condition may raise
again later. Keys name the CONDITION, not the event (`transfer_stuck:12`, not the day
count), so an ageing transfer does not produce a fresh alert every morning.

Rules: out of stock · low stock · transfer shipped and not received (escalating at 7
days) · transfer awaiting receipt · cash session closed with a variance ≥ 100 DA
(critical ≥ 1 000) · inventory count left open ≥ 2 days.

### How realtime works, and what it does not yet do

`electron/eventBus.ts` publishes to two transports: Electron windows on this machine
(over IPC), and other terminals in the store (over **SSE** at `GET /events` on the
existing Fastify server, behind the same `x-sync-token` hook as every other route).

**The rule that matters: publish AFTER the transaction commits, never inside it.**
An event emitted mid-transaction announces work that may still roll back, and every
subscriber would then be showing stock that was never sold. That is why publishing
lives in the IPC handlers in `main.ts` — via `guardAndPublish()`, after the service
call has returned — and not inside the services, where "have we committed yet?" is
not knowable locally.

The bus is deliberately dumb: no retries, no ordering, no replay. **An event is a
HINT that something changed, never the change itself.** Payloads carry identifiers,
not values; `useRetailEvents` re-reads rather than patching state from a message, so
a dropped packet costs a refresh and never causes drift.

SSE rather than WebSocket: traffic is one-way, it rides plain HTTP so it inherits the
pairing-token hook unchanged, and it reconnects itself. The token stays in the
`x-sync-token` header, which means a browser `EventSource` cannot connect — deliberate,
since the clients are Electron and React Native (both can stream with fetch) and the
alternative would write the shared secret into every access log.

### Thin-client mode

A PC is a **server** (holds this store's SQLite, answers the others) or a **client**
(no data of its own, reads and writes the server's). Set in Settings → Caisses.
**Server is the default**, so a single-PC shop needs no configuration at all.

The routing is installed by wrapping `ipcMain.handle` ONCE, in `main.ts`. Wrapping
the global rather than editing 250-odd call sites is deliberate: a handler added
later routes correctly without anyone remembering to opt in, and there is exactly one
place where the client/server decision is made.

**The principle: data lives on the server, devices live on the client.** Printing
counts as data, because the shop's printer is on the server PC — which is how the
phone has printed since long before this.

The two sides default differently, on purpose (`rpcRouter.ts`):

| | unlisted channel | why |
|---|---|---|
| **Client** | forwarded | a new data channel nobody classified still behaves correctly; the other default would read the client's near-empty database and show plausible nonsense |
| **Server** | refused | `/rpc` executes what it is handed, so it is a remote-execution surface and must be deny-by-default |

The server's allowlist is **derived** from the channels actually registered minus an
explicit never-remote list (database reset, catalogue import, credential reads, owner
PIN), so the two sides cannot drift apart by hand-editing one of them.

**Failure is loud, never silent.** If the server is unreachable a forwarded call
REJECTS — it never falls back to the client's own database, which holds nothing but
config and an empty seeded schema and would answer "0 in stock" with total
confidence. The POS shows OFFLINE and stops selling (brief §63). Nothing is queued:
two tills selling the same garment offline is exactly the oversell the whole design
exists to prevent.

Two channels are hybrids, handled explicitly rather than by the generic layer:
`terminal-register` (the row belongs on the server, the identity belongs in this
box's config) and `store-set-current` (writes locally, but the permission is checked
against the SHOP's roles — a client's own database holds no real users).

### Sales targets

Measured against **net revenue** — the same definition the reports use, so a seller's
target and their line in the reports can never disagree. A return is charged to
whoever made the ORIGINAL sale, not to whoever processed the refund; otherwise a
target could be hit by selling hard in week one and letting it come back in week
four, while a colleague absorbed the damage.

Company and store targets are independent rows, not a parent and its children. The
owner may deliberately set stores short or long of the company figure, so the
difference is **reported, never enforced**. Every progress bar carries a second
marker showing where the period should be — a bar at 55 % is excellent on day 10 of a
month and alarming on day 28.

### What is NOT done

1. ⚠️ **Nothing in this plan has been click-tested in a running app.** Every screen
   typechecks, lints and builds; none has been seen rendering.
2. ⚠️ **Thin-client mode has never been run with two machines.** The routing rules,
   the client's error mapping and the event bus are unit-tested; the HTTP round trip
   between two PCs is not.
3. ⚠️ **The cloud mirror has no far side.** The desktop half is built and tested
   against a stubbed endpoint; the website half described in
   [CLOUD_MIRROR.md](CLOUD_MIRROR.md) does not exist, and no batch has ever been
   POSTed to a live server.
4. The **AI copilot is not variant-aware** and still runs on the old intent switch —
   see PROJECT.md §7. Untouched by this plan.
5. The fiscal track in [MASTER_PLAN.md](MASTER_PLAN.md) (TVA on the printed facture,
   gapless invoice numbering on the A4) is separate and still applies.
4. **`stock_manager` is not a role a user can hold.** `users.role` carries a CHECK
   allowing only `('owner','manager','cashier','warehouse')`, so `warehouse` IS the
   brief's STOCK_MANAGER. Migration 35 seeds `stock_manager` grants against a future
   widening of that CHECK, but nothing can use them today, and widening it means
   rebuilding the table every PIN and foreign key points at.

## 9. Risks and edge cases tracked

Two cashiers, one item (→ §4 oversell guard, store-local transaction) · return after a
price change (→ frozen line price) · exchange price difference either direction (→
signed balance) · sale in store A returned in store B (→ allowed, movement lands in
B, reported against A's revenue) · transfer shipped never received (→ ageing report on
in-transit) · double receive (→ state guard) · cash discrepancy (→ mandatory reason) ·
employee refunding another's sale (→ permission + audit) · variant deleted after sale
(→ soft delete only, `setVariants` never DELETEs) · duplicate barcode (→ unique index
+ resolution UI) · client loses LAN mid-sale (→ cart is server-side, sale is atomic) ·
employee deactivated while logged in (→ checked per mutation, not at login).

## 10. Testing strategy

Vitest against `node:sqlite` (`better-sqlite3` is built for Electron's ABI and cannot
be required from plain node). Priority order: oversell under concurrency, return
refund maths, exchange balance both directions, transfer ship/receive idempotency,
cash session reconciliation, discount permission caps, bundle stock draw-down.

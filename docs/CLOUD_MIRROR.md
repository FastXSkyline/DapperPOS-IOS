# CLOUD_MIRROR.md — the central PostgreSQL mirror

> Phase 10 of [RETAIL_PLAN.md](RETAIL_PLAN.md). The shop pushes; the website reads.
> **The mirror is never authoritative.** SQLite in each shop stays the system of
> record, and nothing is ever read back down.

---

## 1. Why an HTTP endpoint and not a direct Postgres connection

cPanel binds PostgreSQL to `localhost`. Exposing it would mean:

- a **remote-access host allowlist** that a shop's dynamic ADSL address invalidates
  every time the router reconnects;
- **database credentials inside a desktop installer** that anyone can unpack;
- the shop's till waiting on an internet round trip to a shared-hosting database.

So the desktop POSTs JSON batches to a small endpoint on the site, and the site —
already sitting next to the database, already authenticated to it — writes them.

```
  Costume PC ─┐
              ├─ HTTPS POST ─► https://boutique.dz/api/dapper-push ─► PostgreSQL ─► website
  Casual  PC ─┘   (x-dapper-secret)
```

## 2. What is pushed

| Entity | Watermark | Notes |
|---|---|---|
| `stores` | none — sent in full every time | Few and near-static. Sending them always removes the "a sale from a shop the mirror has never heard of" case. |
| `sales` | `id` (append-only) | Completed only. |
| `saleItems` | travel **with** their sale | Never split across batches: a sale with no lines reads as a sale of nothing. |
| `returns` | `id` (append-only) | Completed only; carries the original and replacement numbers. |
| `products` + `variants` | `updated_at` (mutable) | Variants ride along with their product. |
| `stock` | `updated_at` (mutable) | Per store × variant. |

**Two kinds of watermark, because the tables differ.** Append-only tables advance on
`id` — monotonic, assigned by the database, so `id > last_id` is exact and no clock
is involved. Mutable tables advance on `updated_at` with a **10-minute overlap on
re-read**: a row updated while a push was in flight could otherwise carry a timestamp
just before the new mark and never be sent again. Re-sending is free, because the
endpoint upserts.

**The mark advances only after the endpoint confirms.** A timeout, a 500 or a
truncated response leaves it untouched and the same rows go again.

## 3. The contract

`POST <url>` with `Content-Type: application/json` and `x-dapper-secret: <key>`.

```jsonc
{
  "shopId": "dapper",
  "pushedAt": "2026-09-03T18:00:00.000Z",
  "stores":   [{ "id": 1, "code": "CST", "name": "Costume", "city": null, "is_active": 1 }],
  "products": [{ "id": 12, "sku": "CST-MIL-NVY", "name": "Costume Milano", "cost_price": 18000, "retail_price": 35000, "is_active": 1, "updated_at": "..." }],
  "variants": [{ "id": 44, "product_id": 12, "sku": "CST-MIL-NVY-52", "size": "52", "color": "Bleu Marine", "retail_price": 35000, "is_active": 1 }],
  "stock":    [{ "store_id": 1, "store_code": "CST", "product_id": 12, "variant_id": 44, "quantity": 3, "updated_at": "..." }],
  "sales":    [{ "id": 901, "transaction_number": "BL-2026-000901", "store_id": 1, "total_amount": 35000, "created_at": "...", "completed_at": "..." }],
  "saleItems":[{ "transaction_number": "BL-2026-000901", "product_id": 12, "variant_id": 44, "quantity": 1, "unit_price": 35000, "unit_cost": 18000, "line_total": 35000 }],
  "returns":  [{ "id": 7, "return_number": "RET-2026-000007", "kind": "refund", "original_number": "BL-2026-000901", "returned_value": 35000, "balance": 35000 }]
}
```

A **ping** — `{ "shopId": "...", "pushedAt": "...", "ping": true }` with no entity
arrays — must answer `200`. That is what the *Tester* button sends.

**Response**

```jsonc
{ "ok": true, "received": { "sales": 12, "saleItems": 31 } }
```

Any non-2xx is treated as a failure and the batch is retried unchanged. Reply `401`
or `403` for a bad key so the desktop can say "key refused" rather than "unreachable".

## 4. The endpoint MUST upsert on the natural key

This is the whole basis of retry safety. A batch that times out after the database
committed will be sent again, and the second write must be a no-op, not a duplicate.

| Entity | Natural key |
|---|---|
| store | `code` |
| product | `sku` (fall back to `shop_id, source_id` when a product has no SKU) |
| variant | `sku` |
| stock | `(store_code, variant_id)` |
| sale | `transaction_number` |
| sale item | `(transaction_number, product_id, variant_id)` |
| return | `return_number` |

Numbers are gapless per document type per year and never reused, so they are safe as
keys. **Scope every key by `shop_id`** if the endpoint ever serves more than one
business.

## 5. PostgreSQL schema

```sql
CREATE TABLE stores (
    shop_id      text    NOT NULL,
    code         text    NOT NULL,
    name         text    NOT NULL,
    city         text,
    is_active    boolean NOT NULL DEFAULT true,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, code)
);

CREATE TABLE products (
    shop_id      text NOT NULL,
    sku          text NOT NULL,
    source_id    integer,
    name         text NOT NULL,
    category_name text,
    cost_price   numeric(14,2),
    retail_price numeric(14,2),
    is_active    boolean NOT NULL DEFAULT true,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, sku)
);

CREATE TABLE variants (
    shop_id      text NOT NULL,
    sku          text NOT NULL,
    product_sku  text,
    size         text,
    color        text,
    cost_price   numeric(14,2),
    retail_price numeric(14,2),
    is_active    boolean NOT NULL DEFAULT true,
    PRIMARY KEY (shop_id, sku)
);

CREATE TABLE stock (
    shop_id     text NOT NULL,
    store_code  text NOT NULL,
    variant_id  integer NOT NULL,
    product_sku text,
    variant_sku text,
    size        text,
    color       text,
    quantity    numeric(14,3) NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (shop_id, store_code, variant_id)
);

CREATE TABLE sales (
    shop_id            text NOT NULL,
    transaction_number text NOT NULL,
    store_code         text,
    user_name          text,
    customer_name      text,
    status             text,
    return_status      text,
    subtotal           numeric(14,2),
    discount_amount    numeric(14,2),
    tax_amount         numeric(14,2),
    timbre             numeric(14,2),
    total_amount       numeric(14,2),
    created_at         timestamptz,
    completed_at       timestamptz,
    PRIMARY KEY (shop_id, transaction_number)
);
CREATE INDEX ON sales (shop_id, completed_at);
CREATE INDEX ON sales (shop_id, store_code, completed_at);

CREATE TABLE sale_items (
    shop_id            text NOT NULL,
    transaction_number text NOT NULL,
    product_id         integer NOT NULL,
    variant_id         integer,
    product_name       text,
    sku                text,
    size               text,
    color              text,
    quantity           numeric(14,3),
    unit_price         numeric(14,2),
    unit_cost          numeric(14,2),
    tax_rate           numeric(6,2),
    tax_amount         numeric(14,2),
    line_total         numeric(14,2),
    returned_quantity  numeric(14,3) DEFAULT 0,
    PRIMARY KEY (shop_id, transaction_number, product_id, COALESCE(variant_id, 0))
);

CREATE TABLE sale_returns (
    shop_id            text NOT NULL,
    return_number      text NOT NULL,
    kind               text,
    original_number    text,
    replacement_number text,
    store_code         text,
    returned_value     numeric(14,2),
    replacement_value  numeric(14,2),
    balance            numeric(14,2),
    refund_method      text,
    reason             text,
    created_at         timestamptz,
    PRIMARY KEY (shop_id, return_number)
);
```

> `unit_cost` is the cost **frozen at the moment of sale** (Migration 42). Compute
> margin from it, never from `products.cost_price` — that one moves whenever a
> supplier changes a price, and using it would silently rewrite historical profit.
> Rows pushed from sales made before that migration carry `NULL`; treat their margin
> as unknown rather than assuming today's cost.

## 6. What the website must NOT do

- **Do not write back.** There is no downstream channel. A price edited in Postgres
  is overwritten on the next push and never reaches a till.
- **Do not treat the mirror as complete.** It is as fresh as the last successful
  push; a shop with no internet for a day is a day behind. Show the last push time
  next to any figure.
- **Do not recompute VAT or totals.** They are computed in the shop against Algerian
  rules and pushed as recorded. Recomputing invites two answers to one question.

## 7. Security

- The shared key travels in `x-dapper-secret` over **HTTPS only**. Never accept it in
  a query string — it would land in every access log.
- The key is stored in the shop's `config` table and **never crosses the IPC bridge**
  to the renderer; the settings panel only learns whether one is set.
- Rate-limit the endpoint and cap the body size. A batch is at most 500 rows per
  entity, which is a few hundred KB.
- The endpoint is **write-only for the shop**. Reads belong to the website's own
  authenticated session, not to this key.

## 8. Status: not yet run against a real endpoint

The desktop half is built and unit-tested (19 tests: batching, watermark advance and
non-advance, the overlap window, retry safety, error reporting). **The website half
does not exist**, and no batch has ever been POSTed to a live server. The contract
above is what to build against.

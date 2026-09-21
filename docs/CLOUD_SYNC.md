# CLOUD_SYNC.md — Firestore relay between the PC and the phone

> Goal: **use the phone away from the shop.** In the shop, nothing changes — the LAN
> server is still used first.

---

## 1. The shape of it

```
        IN THE SHOP (same wifi)                    AWAY FROM THE SHOP
   ┌──────────┐   LAN :4000   ┌───────┐      ┌──────────┐        ┌───────┐
   │ Desktop  │◄─────────────►│ Phone │      │ Desktop  │◄──────►│ Phone │
   │ (SQLite) │  fast, no     │       │      │ (SQLite) │Firestore│       │
   └──────────┘  internet,    └───────┘      └──────────┘  relay  └───────┘
                 CAN PRINT
```

- **SQLite stays the source of truth on both ends.** Firestore is a relay, not the
  database. Every migration, the gapless invoice numbering and the server-side TVA
  recompute are untouched.
- **The desktop stays the system of record.** A phone sale is *recomputed* on arrival
  (per-line TVA, timbre) rather than trusted — via `electron/mobileIngest.ts`, which is
  shared by both transports so a sale can't come out different depending on whether the
  shop wifi happened to be up.
- **Printing is LAN-only.** The receipt printer is wired to the PC; Firestore can't print.
  Away from the shop there's no printer anyway.

`SyncService.syncAuto()` on mobile picks the transport: LAN if `/health` answers within
3 s, otherwise the cloud, otherwise it reports that neither is reachable.

## 2. What lives in the cloud

```
shop_members/{uid}                → { shopId, role }   ← console-managed, never client-writable
shops/{shopId}/products/{id}      ← desktop writes, phone reads
shops/{shopId}/variants/{id}      ← desktop writes, phone reads
shops/{shopId}/suppliers/{id}     ← desktop writes, phone reads
shops/{shopId}/transactions/{transaction_number}   ← phone writes, desktop reads
```

**The transaction document id is the `transaction_number`.** That is what makes the relay
idempotent for free: re-uploading the same sale overwrites its own document instead of
creating a second one, which is the same guarantee the LAN path already had.

`ingested` is flipped **only by the desktop**, and only after the sale has actually landed
in SQLite. A failed ingest therefore leaves the sale queued for retry instead of vanishing.

## 3. Security — read this before deploying

- **The Firebase client config is public by design.** Anyone can read it out of the app
  bundle. Hiding it protects nothing; `firestore.rules` is the real boundary.
- **Dapper deliberately does not use `firebase-admin`.** Admin bypasses Security Rules and
  requires a service-account JSON. Shipping that inside a desktop installer on a shop PC
  would hand full database access to anyone who unpacked it. Both ends use the client SDK
  + Firebase Auth instead.
- **Rules enforce two things:** you must be signed in, and you may only touch the shop your
  `shop_members` document names. A phone cannot grant itself membership — that collection
  is `allow write: if false`.
- **Catalogue is owner-write, member-read**, so an employee's phone can never rewrite
  prices or stock.
- The shop's Firebase password is stored in the local `config` table (same place as the
  existing LAN pairing token), never in the repo.

## 4. Setup (you do this once, in the Firebase console)

1. **Firestore** → create database (production mode).
2. **Authentication** → enable *Email/Password*, then create one account for the shop,
   e.g. `boutique@exemple.com`.
3. **Firestore → Data** → create the membership document by hand:
   - collection `shop_members`, document id = that account's **UID** (copy it from the
     Authentication tab)
   - fields: `shopId` = `boutique-1` (any id you like), `role` = `owner`
   - If you later give an employee their own account, add a second document with
     `role: "employee"` — same `shopId`.
4. **Deploy the rules:**
   ```bash
   firebase deploy --only firestore:rules
   ```
   (from the repo root — `firestore.rules` is committed on purpose so it stays reviewable)
5. **Project settings → Your apps → Web app** → copy `apiKey`, `authDomain`, `projectId`,
   `appId`.
6. **In Dapper:** Settings → *Synchronisation cloud (Firestore)* → paste those four, plus
   `shopId`, the account email and password → **Activer** → **Tester la connexion** →
   **Envoyer le catalogue**.
7. **On the phone:** enter the same six values (same `shopId`), then sync.

## 5. Cost

Firestore bills per document read/write.

- The catalogue push is **delta** — it only sends products whose `updated_at` moved since
  the last push, so ~1400 products cost ~1400 writes **once**, then only what changed.
- Variants and suppliers are pushed whole because they are few, and because a delta would
  leave a size deleted on the desktop still sellable on the phone forever.
- The phone's catalogue pull currently reads the whole catalogue each time. If that gets
  expensive, the next step is a `where('syncedAt', '>', lastPull)` filter — the field is
  already written on every document for exactly this.

## 6. Not done yet

- ⬜ No automatic background sync loop — sync is triggered from Settings on the desktop and
  by `syncAuto()` on mobile. A timer or an `onSnapshot` listener would make it live.
- ⬜ Mobile has no cloud settings screen yet; the values must currently be written into its
  `config` table (`cloud_api_key`, `cloud_auth_domain`, `cloud_project_id`, `cloud_app_id`,
  `cloud_shop_id`, `cloud_email`, `cloud_password`, `cloud_enabled`).
- ⬜ Not tested against a live Firebase project — the code typechecks and builds on both
  ends, but no document has actually been written.
- ⬜ Customers, loyalty and cash sessions are not relayed; only catalogue down and sales up.

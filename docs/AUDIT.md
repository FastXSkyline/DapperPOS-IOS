# GestionPOS — Code Audit (current state)

> Findings from a 7-dimension multi-agent audit, independently spot-verified. Fixes are sequenced in [MASTER_PLAN.md](MASTER_PLAN.md). Market-compliance gaps are in [ALGERIA_REQUIREMENTS.md](ALGERIA_REQUIREMENTS.md).

## Overall verdict

A **working single-operator prototype, not a shippable product.** The hard parts work (native Electron build with `better-sqlite3`, happy-path cash/credit sale, sensible data model, offline-first), but features are **scaffolded-but-not-wired** and the **security/compliance fundamentals are broken**. Fragile-to-broken: it demos, but cannot safely take real money, produce a legal invoice, or be deployed to multiple shops as-is.

### Verdict by dimension

| Dimension | Verdict |
|---|---|
| AI assistant / Darija voice | 🟠 fragile — backend complete, desktop UI untriggered |
| Algerian fiscal compliance | 🔴 broken — TVA dead, BL-not-Facture |
| Printing | 🟠 fragile — works but CDN-dependent barcodes, hardcoded identity |
| Mobile ↔ PC sync | 🟠 fragile — no auth, no idempotency |
| Data model / security | 🟠 fragile — leaked key, plaintext PINs, backdoor, open SQL IPC |
| POS core correctness | 🟠 fragile — double stock decrement, no refunds/Z-report |
| Build / repo hygiene | 🟠 fragile — secrets + artifacts committed, no root git, no tests/CI |

## Top risks (cross-cutting)

1. **🔴 Leaked OpenAI key everywhere** — `desktop/.env`, `mobile/.env` (neither gitignored), inlined into the Expo bundle via `EXPO_PUBLIC_*`, embedded in ~25 committed `dist-electron/main-*.js` bundles and the 100MB installer. Treat as compromised → rotate, purge, proxy server-side. *(Phase 1.6 + Phase 2.2)*
2. **🔴 Unauthenticated LAN server** — `syncServer.ts` binds `0.0.0.0:4000`, `CORS origin:true`, zero auth. `/sync/products` leaks `cost_price`; `/sync/transactions` injects stock-draining sales; `/print/raw/*` drives the printer with unescaped HTML. *(Phase 1.9, 1.11)*
3. **🔴 TVA never computed / no legal Facture** — `tax_amount` hardcoded 0; doc titled "Bon de Livraison" with random numbering; seller fiscal IDs blank/hardcoded; timbre 0. *(Phase 3)*
4. **🔴 Desktop AI untriggerable** — backend complete but no renderer calls `processVoice`/`processText`; action events never consumed; `CREATE_PRODUCT` reads `data.name` vs prompt's `product_name`; packaged `.env` not bundled (empty key in prod). *(Phase 2)*
5. **🟠 Plaintext PINs + `RESET-9999` backdoor + unused RBAC** — `permissions.ts` imported nowhere; mobile biometric logs in as owner id=1. *(Phase 1.3, 1.8)*
6. **🟠 Arbitrary SQL over IPC** — `db-query`/`db-run` give the renderer full read/write/DDL; also used for a hard supplier DELETE that orphans FKs. *(Phase 1.10)*
7. **🟠 Double sale completion** — `PaymentModal` + `POSScreen` both call `complete()`; no guard ⇒ **stock decremented twice per sale**; `complete()` not transactional; no oversell guard. *(Phase 1.4, 1.5, 1.12)* — **fixed in Phase 1.**
8. **🟠 Sync has no idempotency / colliding numbers** — dropped HTTP response duplicates sales + double-decrements; mobile `TX-${Date.now()}` collides across phones; one-way sales sync. *(Phase 6.8)*
9. **🟠 Three diverging schemas, no version** — `core/schema.sql` vs 10 desktop migrations vs a hand-rolled mobile schema; packaged app may load a fallback inline schema (search paths omit `process.resourcesPath`). *(Phase 6.7)*
10. **🟠 No auto-update / tests / CI / root git** — only an orphaned `mobile/.git` scaffold tracking none of the real source; money math untested; fixes can't reach dispersed shops. *(Phase 1.7, 6.3, 6.6)*
11. **🟠 Barcode labels need a CDN** — `labelService.ts` loads jsbarcode from jsdelivr at print time; offline = blank label, no error. Plus fixed `setTimeout` print timing, swallowed invoice/label errors, two hardcoded company identities (H.Bouzid vs EURL MEKKI). *(Phase 6 / printing track)*

## Strengths to preserve

- Native-module packaging actually works (better-sqlite3 → `app.asar.unpacked`, schema → resources, NSIS installer produced).
- Offline-first local SQLite on both platforms; `sync_queue` foundation exists.
- AZERTY-safe barcode scanning (`mapSymbolsToNumbers`) and fractional/metré quantities.
- Per-document printer routing (thermal vs A4); receipt/PO print paths have default-printer fallback.
- Credit/kredi tracking modeled end-to-end on desktop (debt_status/due_date, debtors, settle).
- The A4 template already *knows the shape* of an Algerian fiscal document (HT/TVA/TTC/Timbre/Net, RC/NIF/NIS/AI cells, amount-in-words) — it's just unpopulated.

## Contradictions / thin coverage (verify during implementation)

- Monetary `REAL` storage centime-drift is asserted, not demonstrated (no tests yet).
- "Packaged app loads the wrong schema" is reasoned from search-path code, not confirmed on an installed build.
- Stock source-of-truth (delete-and-replace pull vs blind-subtract push) conflict is documented but undecided — Phase 6.8 must pick one.
- Mobile scope (full POS vs cash-only companion) is undecided — changes the size of mobile work.
- Whisper Darija accuracy is unproven by real testing.

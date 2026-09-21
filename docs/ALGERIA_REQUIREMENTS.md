# Algerian-Market Requirements — GestionPOS

> ~75 requirements for Algerian commerce software, web-researched against the current Lois de Finances (2024 Law 23-12, 2025 Law 24-08) and **mapped to the current code**. Implementation sequencing is in [MASTER_PLAN.md](MASTER_PLAN.md).

**State legend:** ✅ done · ⚠️ partial (schema/UI exists but not wired) · 🔴 wrong (implemented incorrectly/misleading) · ❌ absent · ❓ unknown
**Weight:** **LAW** legally required · **EXP** strongly expected · **PRAC** common practice · **OPT** optional

## ⚠️ Three "don't build" corrections to common assumptions

- **Do NOT implement TAP** (Taxe sur l'Activité Professionnelle). **Abolished for all commerce from 01/01/2024** (LF 2024 art. 14). Many older DZ POS still wrongly charge ~1–2%.
- **E-invoicing is NOT yet mandatory** for SME retail/wholesale (only DGE/State, pharma B2B, hydrocarbons B2B; LF 2026 extends to *services* from 01/01/2026). Architect e-invoice-ready; don't force.
- **The general 500 000 DA cash cap is NOT enacted.** Make it configurable, default OFF.

---

## 1. Taxation (beyond TVA)

| Requirement | Weight | State | Detail |
|---|---|---|---|
| TVA computed per line at correct rate | LAW | 🔴 | **19% standard** (stable since LF 2017). `tax_amount` forced to 0 today — root blocker for every fiscal feature. |
| Reduced **9%** + **0%/exonéré**, per-article, mixed-rate | LAW | ❌ | 9% = CTCA art. 23 list (tourism/hôtellerie ext. to 31/12/2027); exonéré = art. 9 (semoule, pain, farines, exports). Only 19% seeded. |
| Régime switch **réel** (TVA) vs **IFU/forfait** (no TVA) | LAW | ❌ | Binary toggle changing whole document + declaration layout. |
| IFU: **8 000 000 DA** ceiling, **5%** goods / **12%** services, min **10 000 DA** | LAW | ❌ | Track cumulative annual turnover, warn near ceiling. |
| IFU declarations **G n°12** (30 Jun) + **G n°12 bis** (20 Jan), pay **G50A** quarterly | LAW | ❌ | Distinct calendar from monthly G50. |
| **Droit de timbre** on cash invoices, graduated | LAW | ⚠️ | 1% (300–30 000), 1.5% (30 000–100 000), 2% (>100 000), per 100-DA tranche on TTC, min 5 DA, cap ~10 000 DA. Static "0" row today. |
| Auto-**suppress timbre** for non-cash (chèque/virement/CCP/carte) | LAW | ❌ | Only cash portion taxed. Blocked by hardcoded cash. |
| **Do NOT compute TAP** | LAW | ✅ | Correctly absent — keep it that way. |
| **IBS** multi-rate: 19% goods / **23% BTP** / **26% commerce** | EXP | ❌ | 26% also the penalty rate if mixed activities not separately accounted. |
| Route profit tax IBS (société) vs **IRG/BIC** (personne physique) | PRAC | ❌ | Many traders are personnes physiques above IFU ceiling. |
| **IRG sur salaires** (payroll withholding) → G50 | LAW | ❌ | Barème 0/23/27/30%, 40% abatement, SNMG exempt. No payroll tables. |
| Retenues à la source: **10%** interest, **5%** dividends, **30%** foreign providers | EXP | ❌ | 30% non-resident relevant to importers. |
| LF 2025 importer/advertiser levies (import solidarity 2→3%, pub 1→2%) | PRAC | ❌ | Configurable cost trackers. |

## 2. Legal invoice compliance (facture conforme — décret 05-468)

| Requirement | Weight | State | Detail |
|---|---|---|---|
| **Seller identifier block** every fiscal doc | LAW | ⚠️ | NIF(15), NIS(15), RC, Article d'Imposition, capital social, forme juridique, address. Hardcoded "EURL MEKKI" today; no settings UI. |
| **Buyer NIF** on B2B | LAW | ⚠️ | Condition of buyer's TVA deductibility (LF 2022). `customers.tax_id` exists but never reaches invoice. |
| **Sequential, gapless** numbering per type per year | LAW | 🔴 | Gap = présomption de dissimulation. Random base36 / `Date.now()` today. Avoirs need own series. |
| Line/totals layout, **per-rate TVA**, total figures + words | LAW | ⚠️ | Layout exists but TVA always 0, no per-rate breakdown, words footer drops centimes + says "Bon de Livraison". |
| Emit a true **Facture conforme** (not a BL) | LAW | 🔴 | Only A4 doc is titled "Bon de Livraison" and used as the invoice. |
| **Facture d'avoir** — only legal way to correct/cancel | LAW | ❌ | Own series, references original, reverses TVA, restocks. Today `void()` flips a flag. |
| **Payment mode + date de règlement** mandatory; multi/split capture | LAW | 🔴 | Hardcoded cash; also drives timbre + AML. |
| **Anti-cash / AML thresholds** (Décret 15-153) | LAW | ❌ | Scriptural above ~1 000 000 DA (equipment/vehicles/B2B services), ~5 000 000 (real estate); fines 500k–5M. |
| **10-year retention** + tamper-evident, e-invoice-ready | LAW | ⚠️ | Code de commerce art. 12. Lacks fiscal fields + immutable issued-doc journal. |
| Hard enforcement of mandatory mentions | LAW | ❌ | Défaut de facturation ≈80% penalty; non-conforme ≈50% + rejet de déduction. Design driver. |

## 3. Commercial document flow

| Requirement | Weight | State | Detail |
|---|---|---|---|
| **BL** + client réception signature; BL→facture; wilaya-authorization gate | LAW | ⚠️ | BL replaces facture only for repetitive sales (≥3 ops/wk, same client) WITH prior Direction de Wilaya du Commerce authorization. |
| **Facture récapitulative** (monthly BL consolidation) | LAW | ❌ | Cites each BL no./date. |
| **Bon de transfert** (inter-site, no sale) | LAW | ❌ | RC, qté, origin/destination, transporteur, cachet humide; roadside-producible. |
| **Facture proforma** (banque/douane/B2B) | EXP | ❌ | Base doc for mandatory import bank domiciliation. |
| **Devis** (binding once signed) | PRAC | ❌ | Useful for BTP quotations. |
| **Bon de commande client** + BC→BL→facture chain | PRAC | ⚠️ | Supplier POs exist; no client BC. |
| **Bon de réception** + reliquat reconciliation | PRAC | ⚠️ | PO tracks ordered/received; no reliquat UI. |
| **Cachet humide + signature** zones on A4 | EXP | ⚠️ | Thermal has it; A4 invoice has none. |
| **Remise / Rabais / Ristourne** distinct, line + footer | LAW | ⚠️ | Three defined separately by décret; A4 prints no discount line at all. |
| Retail ticket vs wholesale facture vs proforma from one engine | LAW | ⚠️ | Consumer → ticket (facture on request); B2B → mandatory facture. |

## 4. Accounting & declarations

| Requirement | Weight | State | Detail |
|---|---|---|---|
| **SCF account codes** + journal export (ventes/achats/caisse) | LAW | ❌ | 70 Ventes, 4457/4456 TVA, 411 Clients, 401 Fournisseurs, 53 Caisse, 30 Marchandises. |
| Monthly **G50** worksheet | LAW | ❌ | TVA by rate, déductible, IRG salaires, timbre, retenues. Filed before 20th. Blocked: TVA never computed, no purchase-VAT capture. |
| Annual **état 104** (relevé des clients), DGI Excel | LAW | ❌ | Due 30 Apr; per pro client raison sociale/NIF + annual HT/TVA/TTC. Needs buyer NIF. Strong B2B selling point. |
| Feed annual **liasse fiscale** | EXP | ❌ | Export SCF balance for accountant. |
| **Jibaya'tic-ready** exports (no auto-filing — no public API) | EXP | ❌ | Structured Excel/CSV mapping to Jibaya'tic screens. |
| SCF-valued inventory **CMUP/FIFO** → livre d'inventaire | EXP | ⚠️ | Valued at last cost only; no CMUP/FIFO, no variation-de-stock. |
| Optionally **BE** the accounting system | LAW¹ | ❌ | ¹If system of record (livre journal coté/paraphé). **Recommend feeder scope.** |
| **CNAS** (34.5%: 9% employee/25.5% employer) + DAS | PRAC | ❌ | Optional/modular — most SMEs outsource payroll. |
| **CACOBATPH** (congés 12.21% + intempéries 0.375%) | LAW² | ❌ | ²BTPH only — not the électrique distributor. Sector toggle. |

## 5. Payments & money conventions

| Requirement | Weight | State | Detail |
|---|---|---|---|
| **Multi-tender** mixing instruments | EXP | ⚠️ | All forced "cash" today. Unblocking cascades to timbre + AML + mentions. |
| **Cheque** capture + lifecycle (post-dated reçu→remis→encaissé→impayé) | EXP | ❌ | Core B2B guarantee; impayé must reopen balance. |
| **Virement** + **versement** (cash deposit to seller account) + lettrage | EXP | ⚠️ | "Versement" is a distinct common DZ method. |
| Algerian rails: **CIB**, **EDAHABIA**, **BaridiMob/BaridPay QR**, **CCP** | PRAC | ⚠️ | CCP often the only "account" a small merchant has. |
| **Kredi** running balance, credit-limit, aging, printed **relevé** | EXP | ⚠️ | Debt tracking exists; `current_balance` never maintained, no plafond alert, no statement. |
| **Supplier credit** (30/60/90j) + AP échéancier + post-dated cheques | EXP | ❌ | Wholesale runs on this. |
| LF 2025 art. 207 — **mandatory non-cash** for specific transactions | LAW | ❌ | Real estate, vehicle/equipment dealers, mandatory insurance. Relevant to BTP entity. |
| **Cash rounding to nearest 5 DA** w/ tracked arrondi line | PRAC | ❌ | Centime/½-DA coins obsolete; keep exact TTC on fiscal doc. |
| **Centime↔dinar** interpretation for Darija voice | EXP | ❌ | "million" = 10 000 DA; avoid 100× errors with visible confirm. |
| Configurable **cash-cap** (~500 000 DA), default OFF | OPT | ❌ | Not yet enacted — be ready, don't enforce. |
| **DZD-only** at till; FX proforma (EUR/USD) for importers | PRAC | ⚠️ | Domestic = DZD (correct); add FX proforma only. |

## 6. Wholesale / sector (électrique, quincaillerie)

| Requirement | Weight | State | Detail |
|---|---|---|---|
| Multi-tier **gros / demi-gros / détail**, default by customer type | EXP | 🔴 | `wholesale_price` dropped by Migration 7; POS always sells retail. |
| Per-customer negotiated **grilles tarifaires** + precedence | EXP | ❌ | B2B runs on per-contractor prices. `pricing_rules` has no customer dimension, never read. |
| **Quantity/bulk price breaks** | PRAC | ⚠️ | Schema supports it; no engine applies it. |
| **Units of measure** + fractional (mètre, rouleau/bobine, kg, carton) | LAW | ✅ | Done. Verify unité prints on facture line. |
| **Unit conversion / colisage** (buy carton/bobine, sell pièce/mètre) | EXP | ⚠️ | "Colisage" column exists; no conversion-factor logic. |
| **Marque + référence fabricant**, multi-supplier, search on them | EXP | ⚠️ | Fields exist; single supplier_id; search ignores marque/référence. |
| **Multi-depot** + transfers | EXP | ❌ | Single-location; `stock_location` dropped; transfer type unused. |
| Bilingual **AR/FR designations** + no-barcode search | EXP | ⚠️ | `name` is a single field. |
| **Import lot/batch** + landed cost | PRAC | ❌ | DZD devaluation → re-price from latest lot. |
| **Returns/exchanges** (restock vs scrap) + avoir; supplier returns | EXP | ❌ | Only `void()` today. |
| Client **reservations/deposit** (acompte) → PO | PRAC | ⚠️ | `reserved_quantity` never set. |
| **Consignation** d'emballages récupérables line type | LAW | ❌ | Décret 16-66 (lent bobines/tourets). |

## 7. Localization & operational

| Requirement | Weight | State | Detail |
|---|---|---|---|
| **Arabic-first bilingual** printed docs (Loi 91-05 / Décret 92-303) | LAW | ⚠️ | Arabic primary, French complementary. UI has ar.ts/RTL but all printed docs are French-only LTR. |
| Correct **Arabic RTL shaping** on thermal (ESC/POS) + A4 | EXP | ❌ | Render to shaped bitmap; mix RTL Arabic + LTR digits/DZD. |
| **Montant en lettres** FR + AR incl. centimes; Eastern-Arabic numeral option | LAW | ⚠️ | French words exist but `Math.floor` drops centimes + footer mislabeled. |
| First-run **onboarding wizard** + Algeria defaults | PRAC | ❌ | Target users configure nothing. |
| **Signed Windows installer** (avoid SmartScreen) | PRAC | ❓ | Non-technical users read warning as a virus. |
| Offline **AI graceful degradation**, Darija, no USD billing at POS | PRAC | ⚠️ | Voice engine cloud-only; POS must never block on remote. |
| **Data residency** (Loi 18-07 / ANPDP) | LAW | ⚠️ | PII in Algeria; cross-border needs authorization. Prefer local/Algerian-hosted. |
| Algerian **working week (Sun–Thu)** / Ramadan / optional Hijri | PRAC | ⚠️ | Daily-close day boundary wrong for DZ week. |
| **Offline-first** architecture | EXP | ✅ | Done — preserve when adding sequential numbering. |
| Thermal 58/80mm + A4 + **AZERTY-safe barcode** scanning | EXP | ✅ | Done. |
| **DZD local billing** for any SaaS fee | PRAC | ❓ | DZ SMBs lack international cards. |

---

## Quick wins (high value / low effort)

1. Stop hardcoding TVA to 0 — compute per line from `tax_category_id`; seed 9% + exonéré. Unblocks conforme invoices, G50, état 104 at once.
2. Replace random `transaction_number` with an atomic per-year sequential counter (= gapless facture numbering).
3. Un-hardcode the payment method (`PaymentModal.tsx`) → real selector. Cascades to multi-tender, timbre exemption, AML.
4. Implement graduated droit de timbre, gated by payment mode.
5. Company fiscal-identity settings panel (NIF/NIS/RC/AI) wired into invoice + `customer.tax_id` for buyer.
6. Re-template the "Bon de Livraison" into a true Facture conforme; fix amount-in-words (wording + centimes).
7. Capture buyer `tax_id` in the customer form; require for professional clients.
8. Restore gros/demi-gros/détail tiers (dropped by Migration 7); default from `customer_type`.
9. Cash rounding to nearest 5 DA with tracked arrondi line.
10. Centime→dinar conversion in the Darija engine with a visible "= X DA" confirmation.

## 👤 legal_to_verify — confirm with an accountant/DGI before hardcoding

Rates/thresholds change every Loi de Finances. Confirm: the **9% (art.23)** and **exonéré (art.9)** lists; **timbre brackets/floor/cap**; **IFU 8M ceiling + 5%/12% + min 10k**; IFU filing forms/deadlines (G12 30 Jun, G12 bis 20 Jan, G50A quarterly); **IBS 19/23/26%** + non-segregation penalty; **IRG salaires barème** + abatement; **retenues** 10/5/30; **Décret 15-153** thresholds + fines; **LF 2025 art. 207** cash-banned list + date; whether the **500 000 DA cap** is enacted (currently not); the **facture récapitulative / BL-substitution** authorization + ≥3 ops/week rule; **défaut de facturation ≈80%** + non-conforme ≈50% penalties; **CNAS** split + DAS 31 Jan; **CACOBATPH** rates; LF 2025 import/advertising/TDB levies; **10-year retention** + electronic-format recognition; **e-invoicing** scope (no SME mandate yet); **Loi 18-07/ANPDP** data-residency; **Loi 91-05** Arabic-primacy on commercial documents.

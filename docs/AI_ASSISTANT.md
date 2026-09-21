# GestionPOS AI Copilot — Architecture

> The design for an assistant that handles **anything** a company asks across the whole system — a genuine no-brainer copilot. This replaces the current rigid intent-enum approach.

## 1. The vision

A shop owner (or cashier, manager, warehouse clerk) should be able to **speak or type, in Algerian Darija / Arabic / French**, any of:

- **Navigate / control:** "warini stock", "dir mode nuit", "rod l'arabe".
- **Read / ask:** "ch7al bberk dert lyoum?", "chkoun li kraydin 3liya?", "combien de TVA ndefa3 had ššhar?", "win rah cable Schneider 2.5?", "ach naqes f stock?", "ach howa l'produit li rbe7t fih bezzaf?"
- **Act:** "zid produit disjoncteur Legrand b 1800", "bi3 3 cable w 2 metr tube", "khalas kredi ta3 Ahmed", "dir bon de commande l'fournisseur X ta3 50 coca", "imprimi facture", "badel prix ta3 X l 500".
- **Analyze:** "compare les ventes hada chhar m3a li fat", "ach mn client khallasni akthar", "wešnu li produits li ma mšawch hada chhar".

It must do this **online, and degrade gracefully offline** for the common templated commands. It must **never block the core POS** on a network call. The key must **never live on a client device**.

## 2. Why the current design can't get there

`electron/ai/intentEngine.ts` + `main.ts handleAIAction()` use a **fixed enum of ~20 intents** and a hand-coded `switch`. Problems:

- **Closed world:** anything outside the enum → `UNKNOWN`. It can never answer "what's my TVA this month" because there's no such intent and no analytics path.
- **Hand-coded per intent:** each capability is bespoke glue; adding one means editing the prompt *and* the switch *and* keeping desktop & mobile in sync (they've already diverged).
- **No composition:** can't chain "create the product **and** print its label" reliably, or "settle Ahmed's debt **and** show me remaining debtors".
- **No grounding for questions:** it routes to screens, it doesn't query and summarize data.
- **Cloud-only, key-leaking, brittle Darija TTS.**

## 3. The core idea: a Capability Registry + tool-calling

**Register every system capability once. Let the model call them.**

```
            ┌─────────────────────────────────────────────┐
  speech ─► │ STT (Whisper) ─► Orchestrator (tool-calling) │ ─► action result
  / text    │        ▲                    │                │ ─► natural reply (TTS)
            │        │            selects + fills          │
            │        │                    ▼                │
            │   conversation      ┌──────────────────┐     │
            │     memory          │ Capability       │     │
            │                     │ Registry         │     │
            │                     │  • products.*    │     │
            │                     │  • sales.*       │     │
            │                     │  • stock.*       │     │
            │                     │  • customers.*   │     │
            │                     │  • debts.*       │     │
            │                     │  • expenses.*    │     │
            │                     │  • purchasing.*  │     │
            │                     │  • documents.*   │     │
            │                     │  • reports.*     │     │
            │                     │  • fiscal.*      │     │
            │                     │  • settings/nav  │     │
            │                     └────────┬─────────┘     │
            └──────────────────────────────┼──────────────┘
                                            ▼
                              existing services (same code the UI uses)
```

### Capability shape

```ts
interface Capability {
  name: string                 // e.g. "sales.add_item", "reports.tva_due"
  group: string                // products | sales | stock | customers | debts |
                               // expenses | purchasing | documents | reports | fiscal | nav | settings
  description: string          // natural-language, what it does + when to use (the model reads this)
  descriptionAr?: string       // optional localized hints to improve Darija/AR routing
  params: JSONSchema           // typed args (Zod -> JSON schema)
  kind: 'read' | 'action'      // read = safe/idempotent; action = mutates
  destructive?: boolean        // true => requires user confirmation before executing
  handler: (args, ctx) => Promise<CapabilityResult>  // calls the SAME service the UI uses
}
```

The OpenAI **tools** array is generated from the registry. The model picks tool(s), fills params, we execute against the **existing services** (no duplicate logic), feed results back, and the model composes the spoken/written reply in the user's language.

### Why this makes it a "no-brainer"

- **Open world:** the assistant can do anything in the registry — and the registry mirrors the entire app.
- **Auto-extending:** Phase 3 adds `fiscal.compute_tva` and `documents.print_facture`; Phase 4 adds `pricing.resolve` and `documents.create_proforma`; Phase 5 adds `reports.g50`. Each is one registry entry ⇒ the assistant can immediately use it, in all three languages, with zero prompt surgery.
- **One brain:** desktop and mobile share the registry definitions and the orchestrator prompt. Mobile calls the desktop proxy when paired; both stay identical.
- **Grounded:** read-capabilities query the real DB, so questions get real answers, and entity resolution (product/customer/supplier names) reuses the existing fuzzy matcher.

## 4. Orchestration loop

1. **Input:** audio → Whisper (with Darija priming) → text, or direct text. Detect language for the reply.
2. **Plan:** send text + tool schemas + short conversation memory to the model (function-calling).
3. **Execute:** for each tool call:
   - resolve entities (fuzzy match names to IDs),
   - if `destructive`, return a **confirmation proposal** instead of executing ("Tu veux vraiment supprimer X? / wah wla lla?") and wait for "wah/oui/yes",
   - else run the handler (an existing service method).
4. **Observe → reply:** feed tool results back; model writes a concise natural answer; optionally emit UI events (navigate, refresh) and TTS audio.
5. **Remember:** keep the last few turns so "w imprimih" / "nafs l7aja l tube" resolve.

Multi-step is native: "zid produit X w kherjli l'étiquette" = `products.create` then `documents.print_label`.

## 5. Offline & resilience strategy

- **Local fast-path resolver** (no network) for the high-frequency templated commands — navigation (`SHOW_*`), printing the last receipt/invoice/PO, theme/language, and simple "zid/naqes" cart ops — via a Darija/Arabic/French keyword grammar. These must work during an internet outage because they dominate daily use.
- **Cloud path** (tool-calling) only for free-form extraction, analytics questions, and anything the grammar doesn't match.
- **Distinct failure messaging:** network/auth/quota errors say so ("ماكاش انترنت" / "problème de connexion") — never the generic "ما فهمتش", which today hides outages and makes users re-speak impossible commands.
- **Never blocks POS:** the assistant is additive; manual UI always works.

## 6. Security model

- **Key server-side only.** The desktop main process holds `OPENAI_API_KEY` and exposes:
  - IPC `ai.processVoice` / `ai.processText` for the desktop renderer, and
  - an **authenticated** `POST /ai` on the sync server for mobile (pairing token from Phase 1).
- **Mobile never calls OpenAI directly** and ships **no** `EXPO_PUBLIC_OPENAI_API_KEY`.
- **Confirmation gates** on destructive/financial actions (delete product, price change, debt settlement, large/credit sale, void/refund).
- **RBAC-aware:** the registry filters capabilities by the logged-in user's role (a cashier's assistant can't delete products or change settings).
- **Audit:** every executed action logged to `activity_logs` with `source='ai'` and the transcript.
- **Per-shop usage metering** so the merchant who pays for tokens can see spend (DZD-aware).

## 7. Language & voice quality

- **Darija-first**, code-switched with Arabic + French; replies in the user's language.
- Fix `norm.ts`: drop the unanchored single-letter replaces (`/f/g`, `/li/g`) that corrupt words; use whole-word matching or rely on the TTS model's native Arabic handling.
- **Number/money interpretation:** map spoken centimes/"million" to DZD ("5 million" = 50 000 DA? confirm convention) and **always echo "= X DA"** before committing a price/expense/debt amount, to prevent 100× errors.
- Keep TTS caching; standardize on one TTS model/voice.

## 8. Capability catalogue (initial, grows each phase)

| Group | Examples (read / action) |
|---|---|
| nav/settings | go to screen; toggle theme; change language |
| products | search; get details; create; update price/stock; delete (confirm); low-stock list |
| sales | start sale; add/remove item (qty, metr); apply discount; take payment; complete; void (confirm) |
| stock | current quantity; adjust (confirm); movement history |
| customers | search; create; balance; statement |
| debts | who owes / overdue; settle (confirm, amount+method) |
| expenses | add; list; totals by period |
| purchasing | create PO; receive; list; print PO |
| documents | print last receipt / invoice / PO / label; (Phase 3+) print facture / proforma / avoir |
| reports | sales by period; top products; margins; payment-method split; (Phase 5) TVA due / G50 figures |
| fiscal *(Phase 3+)* | compute TVA; timbre due; regime info |

## 9. Migration path from today's code

1. **Extract** the logic in `handleAIAction()` into registry handlers that call the existing services (one capability per current intent) — behavior-preserving.
2. **Swap** `intentEngine.detectIntent` (enum) for a tool-calling planner over the registry.
3. **Add** read/analytics capabilities the old switch never had.
4. **Build** the desktop UI (Phase 2.4) and wire the action events (2.5).
5. **Point** mobile `aiService` at the desktop `/ai` proxy; delete the client-side key.
6. **Layer** the offline fast-path in front of the cloud planner.
7. Thereafter, **every new feature registers a capability** — the assistant grows automatically.

## 10. Acceptance for "no-brainer"

A non-technical owner, on a fresh install, taps the mic and—without training—can run their day: check takings, find/adjust stock, ring sales (including metré cable), record expenses, manage kredi, create and print documents, and ask plain-language business questions, in their own dialect, with sensitive actions confirmed, the key safe on the server, and the essentials still working when the internet drops. New features appear in the assistant the moment they're built.

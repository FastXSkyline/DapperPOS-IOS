# GestionPOS

A Point-of-Sale & business-management system built for the **Algerian market** —
desktop (Electron) + mobile companion (Expo), sharing a SQLite core, with an
AI copilot that understands **Darija / Arabic / French**.

## What it does

- **POS & inventory** — sales, multi-tier pricing (gros / demi-gros / détail),
  per-customer negotiated prices, quantity breaks, colisage (units/packaging),
  multi-supplier articles, multi-depot stock + bon de transfert.
- **Algerian fiscal compliance** — TVA 19 % / 9 % / 0 %, régime réel vs IFU,
  droit de timbre, gapless document numbering, **facture conforme**
  (NIF/NIS/RC/Article), facture d'avoir, anti-cash/AML warnings,
  bilingual (Arabic + French) documents (Loi 91-05).
- **Commercial documents** — devis, proforma, bon de commande, bon de livraison,
  facture récapitulative, returns/exchanges, kredi ledger (relevé de compte,
  aging, partial settlement), supplier AP + post-dated cheques, reservations/acompte.
- **Accounting feeders** — SCF journals (ventes/achats/caisse), monthly G50,
  annual état 104, Jibaya'tic bundle, CMUP inventory valuation + physical-count
  écart, optional payroll (IRG/CNAS/CACOBATPH), liasse fiscale figures.
- **AI copilot** — voice/chat control over the whole system via a capability
  registry + tool-calling; offline keyword fast-path; cloud LLM optional.

## Repo layout

| Path | What |
|------|------|
| `core/` | Shared `schema.sql` (fresh-install schema) |
| `desktop/` | Electron main (`electron/`) + React/Vite UI (`src/`) + Fastify LAN sync server (`:4000`) |
| `mobile/` | Expo / React Native companion (cash-only caisse) |
| `ios/` | iOS home: build & install guide (`README.md`), local `.ipa` drop-zone (`builds/`), download tooling (`tools/`) |
| `docs/` | `MASTER_PLAN.md` (roadmap), `AI_ASSISTANT.md`, `ALGERIA_REQUIREMENTS.md`, `DESIGN_SYSTEM.md`, `DEPLOYMENT.md` |

## Develop

```bash
cd desktop
npm install
npm run dev          # Vite + Electron dev
npm run lint
npm test             # Vitest — fiscal/money math
npx tsc -b           # type-check
npm run build        # renderer + electron bundle (cross-platform)
```

Mobile:

```bash
cd mobile
npm install
npx expo start
```

## Security notes

- The OpenAI key lives **only** in `desktop/.env` (gitignored) and is used
  server-side; the mobile app calls the desktop `/ai` proxy and ships **no** key.
- A previously committed key is **compromised — rotate it** (see `docs/DEPLOYMENT.md`).
- The LAN sync server requires a pairing token (`x-sync-token`) on every route
  except `/health`. PINs are bcrypt-hashed.

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for packaging, code-signing and auto-update.

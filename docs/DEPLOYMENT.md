# Deployment — GestionPOS desktop

This covers packaging the Windows installer, code-signing, and enabling
auto-update. Items marked **(owner)** require credentials/infrastructure only
the business owner can provide.

## 1. Build the installer

```bash
cd desktop
npm install
npm run dist        # clean → build → native rebuild → electron-builder (NSIS)
```

Output: `desktop/release/GestionPOS Setup <version>.exe`.

The build scripts are cross-platform (Node-based), so CI on Linux/macOS can run
`npm run build` and type-check; the NSIS installer itself is produced on Windows.

## 2. Code-signing (owner) — avoids SmartScreen warnings

electron-builder signs automatically when these env vars are set at `npm run dist` time:

```bash
# Windows Authenticode (an OV/EV code-signing certificate, .pfx)
set CSC_LINK=C:\path\to\certificate.pfx
set CSC_KEY_PASSWORD=********
```

Without a certificate the app still installs but Windows SmartScreen shows an
"unknown publisher" warning. An **EV** certificate clears SmartScreen reputation immediately.

## 3. Auto-update (owner)

The in-app flow is scaffolded (`app-check-updates` IPC + `window.electron.app.checkUpdates()`).
To enable real updates:

1. `cd desktop && npm i electron-updater`
2. Add a publish target to `desktop/package.json` under `build`:
   ```json
   "publish": [{ "provider": "generic", "url": "https://updates.example.dz/gestionpos/" }]
   ```
   (or `github`, S3, etc.) — must be an **Algerian/local host** if data-residency mode is required.
3. Upload the artifacts produced by `electron-builder` (the `.exe` + `latest.yml`) to that URL.
4. Set the feed in-app: config key `update_feed_url` = the same URL.

The check is intentionally inert until both `electron-updater` is installed and
`update_feed_url` is configured, so an un-provisioned build never crashes.

## 4. Branding

- Window title and `productName` are set to **GestionPOS**.
- Replace `desktop/public/electron-vite.svg` with the real logo and point
  `build.win.icon` at a `.ico` to brand the installer/taskbar.

## 5. First run

The **onboarding wizard** collects company identity (raison sociale, NIF/NIS/RC/
Article), régime (réel/IFU), TTC-pricing, bilingual documents and the default
printer. It appears once (config `onboarded`).

## 6. Secrets

- `.env` (gitignored) holds `OPENAI_API_KEY`. **The historically committed key is
  compromised — rotate it** in the OpenAI dashboard before going live.
- CI runs `gitleaks` (`.gitleaks.toml`) to catch any future secret commits.

## 7. Data residency (Loi 18-07)

Enabling **Résidence des données stricte** (Settings) disables the cloud LLM so no
business data leaves the country; the AI then answers only offline templated
commands. Prefer a local/Algerian-hosted update + sync infrastructure when this
mode is required.

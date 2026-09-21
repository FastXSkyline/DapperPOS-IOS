# iOS — Dapper POS companion

Everything for the iOS build of the app lives under this folder: the build
pipeline reference, where the `.ipa` files land, and how to install one on an
iPhone from Windows.

The app itself is the Expo project in [`mobile/`](../mobile) — `mobile/app.json`
carries the iOS identity (`com.dapper.pos`, display name **Dapper POS**).
The native Xcode project is generated fresh on every build by
`expo prebuild --platform ios` (it is not committed, and cannot be generated on
Windows — the pipeline runs it on a macOS runner).

## Build (GitHub Actions — no Mac, no Apple account needed)

The workflow [`.github/workflows/ios-unsigned.yml`](../.github/workflows/ios-unsigned.yml)
builds an **unsigned device `.ipa`**:

1. macOS 15 runner, newest Xcode (RN 0.81 requires Xcode ≥ 16.1)
2. `npm ci` (pinned by `mobile/package-lock.json`)
3. `expo prebuild --platform ios` + `pod install` (CocoaPods is installed on
   demand — runner images no longer ship it)
4. `xcodebuild -configuration Release CODE_SIGNING_ALLOWED=NO`
5. `Payload/*.app` → **`DapperPOS-unsigned.ipa`**

**Every push rebuilds it automatically.** To build manually:
repo **Actions** tab → **iOS Unsigned IPA** → **Run workflow**.

### Getting the .ipa

| Where | Link |
|---|---|
| Direct download (public repo, no sign-in) | `https://github.com/FastXSkyline/DapperPOS-IOS/releases/latest/download/DapperPOS-unsigned.ipa` |
| Releases page | https://github.com/FastXSkyline/DapperPOS-IOS/releases (tag `ipa-v<N>` per run) |
| Actions run page | artifact `DapperPOS-unsigned-ipa` (requires signing in) |

On success the workflow also attaches the `.ipa` to a GitHub Release
(`ipa-v<run number>`). On failure, build logs are pushed to the `ci-logs`
branch under `logs/run-<N>-*.log`.

Save downloads into `ios/builds/` (that folder is for local `.ipa` files and is
gitignored). `ios/tools/download-latest-ipa` fetches the latest one directly.

## Installing on an iPhone (unsigned .ipa)

iOS refuses unsigned code, so sign it **at install time** with a free tool:

- **Sideloadly** (Windows/Mac, free) — plug the iPhone in, open the `.ipa` in
  Sideloadly, sign with a normal Apple ID, install. Valid **7 days**, then
  re-sign (open Sideloadly and sideload the same file again).
- **AltStore / SideStore** — installs and *refreshes automatically* while the
  phone and the PC app are on the same network.
- **Paid Apple Developer certificate** ($99/yr) — permanent installs, no
  refresh, also required for TestFlight/App Store distribution.

Sideloadly needs **iTunes** (Apple version, not the Store version) installed on
Windows for the USB drivers.

## Troubleshooting the pipeline

| Symptom | Cause / fix |
|---|---|
| `pod: command not found` on runner | Fixed in the workflow: Homebrew-installs CocoaPods when missing |
| `React Native requires XCode >= 16.1. Found 15.4` | Fixed: workflow runs on `macos-15` and selects the newest installed Xcode |
| `workspace does not contain a scheme` (exit 66) | Fixed: `pod install` runs **before** scheme detection/compile |
| Want the real schema of a failed build | See `ci-logs` branch → `logs/run-<N>-pod.log` / `run-<N>-xcodebuild.log` |

## Folder contents

```
ios/
├── README.md    ← this guide
├── builds/      ← local .ipa downloads (gitignored)
└── tools/       ← fetch-latest-ipa scripts (Windows + shell)
```

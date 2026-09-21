// Ship-blocker: verifies the RENDERER bundle's React context graph before the
// app can be packaged.
//
// Twice now the bundle came out with the LanguageContext module emitted TWICE
// (two context objects). <LanguageProvider> fed copy A while every
// useLanguage() read copy B — provider and hook never met, the first render
// threw "useLanguage must be used within a LanguageProvider", React unmounted
// the tree and the window painted blank white. The failure is intermittent
// (same sources, different runs, different output), so it cannot be caught by
// typecheck — only by inspecting the artifact.
//
// What this checks, on every emitted renderer chunk:
//   For each `X = createContext(...)` there must be at least one `X.Provider`
//   usage SOMEWHERE in the bundle, and each context consumed by a
//   `useXxx → useContext(X)` guard must be one of the provided ones.
// Cheap, minification-agnostic approximations:
//   1. Count `NAME=createContext(` declarations.
//   2. Count `NAME.Provider` render sites.
//   3. Every declaration with ZERO Provider sites is suspicious — recharts &
//     co. legitimately create contexts that are provided from within other
//     chunks only when code-splitting (this app emits a single chunk, so a
//     context provided nowhere in the artifact is a real break) — BUT known
//     library internals may be provided via a minified alias `q0=X.Provider`
//     assignment. So the strong signal we rely on is the KNOWN app contexts:
//     the error strings are unique literals; each must be paired with a
//     context that is BOTH read and provided in the same bundle.
//
// Concretely, the gate:
//   A. exactly ONE occurrence of each app context error string
//      ("must be used within a LanguageProvider" / "...ThemeProvider") — two
//      copies of the module = two copies of the string = fail.
//   B. the hook's context variable (read just before each error string) must
//      have at least one `.Provider` render site in the bundle.
// If either fails → non-zero exit, and `npm run build` stops before
// electron-builder can box a blank-window installer.

const fs = require('fs')
const path = require('path')

const distAssets = path.join(__dirname, '..', 'dist', 'assets')
if (!fs.existsSync(distAssets)) {
  console.error('[verify-contexts] dist/assets missing — run `vite build` first.')
  process.exit(1)
}

const chunks = fs.readdirSync(distAssets).filter(f => f.endsWith('.js'))
if (chunks.length === 0) {
  console.error('[verify-contexts] no renderer chunks found in dist/assets.')
  process.exit(1)
}

const GUARDS = [
  { name: 'LanguageContext', marker: 'must be used within a LanguageProvider' },
  { name: 'ThemeContext', marker: 'must be used within a ThemeProvider' },
]

let failed = false

for (const chunk of chunks) {
  const src = fs.readFileSync(path.join(distAssets, chunk), 'utf8')

  for (const g of GUARDS) {
    const copies = src.split(g.marker).length - 1

    if (copies === 0) {
      // The guard string is dead-code-eliminated only if the module is gone —
      // but the app uses the hook, so zero copies means the module vanished.
      console.error(`[verify-contexts] ${chunk}: ${g.name} module missing entirely from the bundle.`)
      failed = true
      continue
    }

    if (copies > 1) {
      console.error(
        `[verify-contexts] ${chunk}: ${g.name} emitted ${copies}× — duplicate context module, ` +
        `provider and hook will read different objects. Refusing to ship a blank window.`,
      )
      failed = true
      continue
    }

    // Single copy: resolve which context object the hook reads, then require
    // at least one Provider render for THAT variable.
    const at = src.indexOf(g.marker)
    const before = src.slice(Math.max(0, at - 260), at)
    const read = before.match(/useContext\(([A-Za-z_$][A-Za-z0-9_$]*)\)/)
    if (!read) {
      console.error(`[verify-contexts] ${chunk}: could not resolve the context variable for ${g.name}; inspect manually.`)
      failed = true
      continue
    }
    const ctxVar = read[1].replace(/\$/g, '\\$')
    const provided = new RegExp(`${ctxVar}\\.Provider`).test(src)
    if (!provided) {
      console.error(
        `[verify-contexts] ${chunk}: ${g.name} hook reads context ${read[1]} but ${read[1]}.Provider is rendered ` +
        `nowhere in the bundle — consumers would throw on first paint.`,
      )
      failed = true
      continue
    }

    console.log(`[verify-contexts] ${chunk}: ${g.name} OK (1 copy, ${read[1]} provided)`)
  }
}

if (failed) process.exit(1)
console.log('[verify-contexts] renderer context graph verified.')

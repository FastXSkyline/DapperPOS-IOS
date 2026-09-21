import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { fileURLToPath } from 'node:url'

// Absolute ids for the context modules: however an importer spells the
// relative path, every Language/Theme context import must resolve to ONE
// module id — two ids means two context objects, a provider feeding one and
// every hook reading the other, and a blank window (see the long comment
// inside resolve below).
const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // Main-process entry point of the Electron App.
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['better-sqlite3'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.cjs',
      },
    ]),
  ],
  resolve: {
    // The renderer bundle once shipped TWO copies of the React module graph
    // (a CJS-interop copy and an ESM copy). The app's components then read
    // Language/Theme contexts from copy A while <LanguageProvider> provided
    // copy B — every useLanguage() threw "must be used within a
    // LanguageProvider" and the window painted blank.
    //
    // dedupe forces every transitive import of react/react-dom onto the same
    // module id, so provider and hook share one context object. (Plain string
    // aliases broke subpath imports like react/jsx-runtime — they concatenate
    // onto the alias target — so dedupe + preservingSymlinks is the fix.)
    dedupe: ['react', 'react-dom'],
    preserveSymlinks: false,
    alias: [
      { find: /^[.][/.]*LanguageContext$/, replacement: abs('./src/LanguageContext.tsx') },
      { find: /^[.][/.]*ThemeContext$/, replacement: abs('./src/ThemeContext.tsx') },
    ],
  },
  build: {
    // Single renderer chunk context: keep module identity stable across the
    // index.html entry and any dynamic imports.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
})

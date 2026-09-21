import { defineConfig } from 'vitest/config'

// Phase 6.6 — unit tests for pure fiscal/money math. Kept separate from the
// electron/renderer builds; runs in CI via `npm test`.
export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
})

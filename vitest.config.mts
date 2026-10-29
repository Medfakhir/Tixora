import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    // Allocation tests assert real database behaviour against one shared test
    // database, so files must not run concurrently.
    pool: 'forks',
    maxWorkers: 1,
    isolate: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})

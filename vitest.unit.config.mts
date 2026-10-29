import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Database-free suite: pure logic only (money, crypto, templates, file sniffing,
 * id generation). Runs anywhere, so correctness can be checked before a PostgreSQL
 * instance is available. Integration tests live in vitest.config.mts.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 1,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://kibir:kibir@127.0.0.1:5432/kibir_test',
      APP_URL: 'http://localhost:3000',
      // Test-only material: never used outside the process running the suite.
      AUTH_SECRET: 'unit-test-auth-secret-unit-test-auth-secret',
      SMTP_ENCRYPTION_KEY: 'a'.repeat(64),
      CRON_SECRET: 'unit-test-cron-secret',
    },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})

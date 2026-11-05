import { defineConfig } from 'vitest/config'

// Research checkouts and generated artifacts are not this application's tests.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], maxWorkers: process.env.CI ? 2 : undefined },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/tests/**/*.spec.{ts,tsx}'],
    environmentMatchGlobs: [
      ['**/*.client.spec.{ts,tsx}', 'jsdom'],
    ],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})

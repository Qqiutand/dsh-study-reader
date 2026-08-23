import { defineConfig } from '@playwright/test'

const baseURL = process.env.DSH_STUDY_READER_E2E_BASE_URL
if (baseURL === undefined || baseURL.length === 0) {
  throw new Error('Set DSH_STUDY_READER_E2E_BASE_URL to an isolated Study Reader test server; this suite never uses a shared web server.')
}

export default defineConfig({
  testDir: './packages/study-reader/e2e',
  // The first test is intentionally a continuous user journey.  Targeted
  // expectations specify their own shorter bounds so this does not mask a
  // missing control.
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL,
    headless: true,
    launchOptions: {
      executablePath: '/usr/bin/chromium',
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './evals/browser',
  timeout: 15_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'evals/playwright-report' }]],

  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    storageState: 'evals/storageState.json',
    trace: 'on-first-retry',
  },

  globalSetup: './evals/global-setup.ts',
  globalTeardown: './evals/global-teardown.ts',

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results',
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'pdf-manager/playwright-report', open: 'never' }]]
    : 'list',
});

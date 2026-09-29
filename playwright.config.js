import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4311', headless: true, channel: 'chrome', viewport: { width: 1440, height: 1100 } },
  webServer: { command: 'node e2e/fixture-server.js', url: 'http://127.0.0.1:4311', reuseExistingServer: false },
});

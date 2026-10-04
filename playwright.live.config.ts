import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/live',
  timeout: 300000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'outputs/live-ui-tests',
  use: {
    baseURL: process.env.ARTBOARD_LIVE_URL || 'http://127.0.0.1:5173',
    browserName: 'chromium', channel: process.env.UI_BROWSER || 'chrome', headless: true,
    viewport: { width: 1221, height: 545 }, screenshot: 'off', video: 'off', trace: 'off',
  },
});

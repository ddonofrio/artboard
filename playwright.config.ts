import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  timeout: 30000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'outputs/ui-tests',
  use: {
    baseURL: 'http://127.0.0.1:5187',
    browserName: 'chromium',
    channel: process.env.UI_BROWSER || 'chrome',
    headless: true,
    viewport: { width: 1221, height: 545 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  webServer: [{
    command: 'node --import tsx tests/fixtures/model-http-server.ts',
    url: 'http://127.0.0.1:5189/health',
    reuseExistingServer: false,
  }, {
    command: 'npm run dev -- --port 5187 --strictPort',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: false,
    env: { ARTBOARD_CONFIG_FILE: 'outputs/ui-config/agents.local.json', AGENT_BASE_URL: 'http://127.0.0.1:5189', AGENT_EDITOR_MODEL: 'test-model', AGENT_REVIEWER_MODEL: 'reviewer-model', AGENT_API_KEY: 'server-only-test-key', AGENT_MAX_REVIEWS: '2', AGENT_VISION: 'true' },
  }],
});

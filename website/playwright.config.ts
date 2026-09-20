import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  reporter: 'list',
  outputDir: '../.local/docs-browser',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PREVIEWHOST_TEST_BROWSER },
  },
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory .local/docs-site',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});

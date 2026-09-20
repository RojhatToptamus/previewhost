import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: "../.local/dashboard-browser",
  use: {
    browserName: "chromium",
    viewport: { width: 1360, height: 900 },
    launchOptions: { executablePath: process.env.PREVIEWHOST_TEST_BROWSER },
    // Private capabilities must never enter traces, screenshots, or videos.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});

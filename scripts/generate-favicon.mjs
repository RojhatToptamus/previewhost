import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Raster fallback for search engines and browsers that cannot use the SVG icon.
const logo = await readFile(new URL('../assets/previewhost.svg', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.PREVIEWHOST_TEST_BROWSER });
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await page.setContent(`<style>body{margin:0;background:white}img{display:block;width:64px;height:64px}</style><img src="data:image/svg+xml;base64,${logo.toString('base64')}" alt="">`);
  await page.locator('img').evaluate(image => image.decode());
  await page.screenshot({ path: fileURLToPath(new URL('../assets/favicon.png', import.meta.url)) });
} finally {
  await browser.close();
}

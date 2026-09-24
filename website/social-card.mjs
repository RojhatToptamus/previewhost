import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const logo = await readFile(new URL('../assets/previewhost.svg', import.meta.url));
const font = await readFile(new URL('../src/fonts/geist.woff2', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.PREVIEWHOST_TEST_BROWSER });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await page.setContent(`<!doctype html><html lang="en"><style>
    @font-face { font-family: Geist; src: url(data:font/woff2;base64,${font.toString('base64')}); }
    * { box-sizing: border-box; }
    body { margin: 0; width: 1200px; height: 630px; padding: 64px 80px; background: #ffffff; color: #18181b; font-family: Geist, sans-serif; }
    header { display: flex; align-items: center; gap: 18px; font-size: 32px; font-weight: 600; }
    img { width: 64px; height: 72px; }
    h1 { margin: 44px 0 20px; font-size: 68px; line-height: 1.08; letter-spacing: -3px; font-weight: 600; }
    p { margin: 0; color: #52525b; font-size: 26px; line-height: 1.42; }
    footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid #d4d4d8; font-size: 22px; line-height: 1.45; color: #52525b; }
  </style><body><header><img src="data:image/svg+xml;base64,${logo.toString('base64')}" alt="">Previewhost</header>
    <h1>Local previews<br>for full-stack apps.</h1><p>Run and manage multiple isolated previews side by side, with your frontend, API, databases, and services together.</p>
    <footer>Open source · CLI · MCP<br>previewhost.app</footer></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('img').evaluate(image => image.decode());
  await page.screenshot({ path: fileURLToPath(new URL('./social-card.png', import.meta.url)) });
} finally {
  await browser.close();
}

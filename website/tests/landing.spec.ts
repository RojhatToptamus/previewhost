import { expect, test } from '@playwright/test';

test('landing page links, dashboard tour, setup, copying and themes', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page).toHaveTitle('Previewhost — Your whole app. One local preview.');
  await expect(page.locator('h1')).toHaveText('Your whole app.One local preview.');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const tour = page.getByRole('tablist', { name: 'Dashboard screenshots' });
  await tour.getByRole('tab', { name: 'Logs', exact: true }).click();
  await expect(page.locator('#dashboard-tour-panel img:visible')).toHaveAttribute('src', '/landing/logs-light.png');
  await tour.getByRole('tab', { name: 'Logs', exact: true }).press('ArrowRight');
  await expect(tour.getByRole('tab', { name: 'Configuration' })).toBeFocused();
  await expect(page.locator('#dashboard-tour-panel')).toHaveAttribute('aria-labelledby', 'dashboard-tour-configuration');
  await tour.getByRole('tab', { name: 'Configuration' }).press('Home');
  await expect(tour.getByRole('tab', { name: 'Services' })).toBeFocused();
  await expect(tour.getByRole('tab', { name: 'Services' })).toHaveCSS('outline-style', 'solid');

  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-site-theme', 'dark');
  await expect(page.locator('#dashboard-tour-panel img:visible')).toHaveAttribute('src', '/landing/activity-dark.png');
  await expect(page.locator('.landing-tour').getByRole('link', { name: 'View full size (opens a new tab)', exact: true })).toHaveAttribute('href', '/landing/activity-dark.png');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-site-theme', 'dark');
  await page.getByRole('button', { name: 'Toggle color theme' }).click();

  await page.getByRole('link', { name: 'Get started', exact: true }).first().click();
  await expect(page).toHaveURL(/#get-started$/);
  await page.getByRole('button', { name: 'Copy install command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm install -g previewhost');
  await expect(page.getByRole('status').filter({ hasText: 'Command copied.' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy start command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('previewhost start --allow-exec');
  await page.getByRole('button', { name: 'Copy dashboard command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('previewhost dashboard');
  await page.getByRole('tab', { name: 'Coding agent', exact: true }).click();
  await page.getByRole('button', { name: 'Copy Codex MCP command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('codex mcp add previewhost -- previewhost mcp --allow-exec');
  await expect(page.getByRole('link', { name: 'Read the MCP guide' })).toHaveAttribute('href', '/mcp/');
  await page.getByRole('tab', { name: 'Coding agent', exact: true }).press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toBeFocused();

  const localLinks = await page.locator('.landing a[href^="/"]').evaluateAll(elements => [...new Set(elements.map(el => (el as HTMLAnchorElement).pathname))]);
  for (const href of localLinks) expect((await page.request.get(href)).status(), href).toBe(200);
  await page.getByRole('link', { name: 'Docs', exact: true }).click();
  await expect(page).toHaveURL(/\/introduction\/$/);
  await expect(page.locator('h1')).toHaveText('Introduction');
  await page.getByRole('link', { name: 'Previewhost home', exact: true }).click();
  await expect(page.locator('#hero-heading')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile navigation, responsive media and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`).toBe(true);
    await expect(page.locator('.landing-hero-copy')).toHaveCSS('animation-name', 'none');
    const screenshot = page.locator('#dashboard-tour-panel img:visible');
    await expect(screenshot).toBeVisible();
    await screenshot.evaluate((image: HTMLImageElement) => image.decode());
    expect(await screenshot.evaluate((image: HTMLImageElement) => image.currentSrc)).toContain(width <= 600 ? 'activity-mobile-light.png' : 'activity-light.png');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await page.getByRole('link', { name: 'How it works' }).click();
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#workflow-heading')).toBeInViewport();
});

test('copy failure stays useful and page remains readable without JavaScript', async ({ page, browser }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Clipboard denied')) } });
  });
  await page.route('**/landing/activity*.png', route => route.abort());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Screenshot unavailable.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the dashboard guide' })).toHaveAttribute('href', '/dashboard/');
  await page.getByRole('button', { name: 'Copy install command' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copy failed.' })).toHaveText('Copy failed. Select the command and copy it manually.');
  await expect(page.locator('.landing-command code').first()).toHaveText('npm install -g previewhost');
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await context.newPage();
  await staticPage.goto('http://127.0.0.1:4173/');
  await expect(staticPage.locator('h1')).toContainText('Your whole app.');
  await staticPage.getByRole('link', { name: 'Get started', exact: true }).last().click();
  await expect(staticPage.locator('#start-heading')).toBeInViewport();
  await staticPage.getByRole('link', { name: 'Follow the CLI quickstart' }).click();
  await expect(staticPage.locator('h1')).toHaveText('First preview with the CLI');
  await context.close();
});

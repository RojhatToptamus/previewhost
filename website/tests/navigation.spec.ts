import { test, expect } from '@playwright/test';

test('static documentation, links, images, search, theme and copying', async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page).toHaveTitle('Introduction · Previewhost');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Introduction');
  await expect(page.locator('.docs-sidebar')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('desktop-light.png') });
  const links = await page.locator('.docs-sidebar-nav a').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).pathname));
  for (const href of links) {
    const response = await page.goto(href);
    expect(response?.status(), href).toBe(200);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('.docs-sidebar-nav [aria-current="page"]')).toHaveAttribute('href', href);
    expect(await page.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), href).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), href).toBe(true);
    expect(await page.locator('vite-error-overlay').count()).toBe(0);
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'Search documentation (Command or Control K)' }).click();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('searchbox');
  await expect(search).toBeFocused();
  await search.fill('nonexistent-doc-query');
  await expect(page.getByText('No documentation found')).toBeVisible();
  await search.fill('database');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL('http://127.0.0.1:4173/');
  await page.goto('/installation/');
  await page.getByRole('button', { name: 'Copy code', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Code copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('npm install -g previewhost');
  await page.getByRole('button', { name: 'Copy page', exact: true }).last().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Requirements');
  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-site-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-site-theme', 'dark');
  await expect(page.locator('.docs-app')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('desktop-dark.png') });
  await page.getByRole('link', { name: 'Next CLI quickstart' }).click();
  await expect(page).toHaveURL(/first-preview/);
  await page.goBack();
  await expect(page).toHaveURL(/installation/);
  expect(errors).toEqual([]);
});

test('mobile navigation, keyboard dismissal and long reference tables', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('mobile.png') });
  const openMenu = page.getByRole('button', { name: 'Open documentation menu', exact: true });
  await openMenu.click();
  const drawer = page.getByRole('dialog', { name: 'Documentation navigation' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(openMenu).toBeFocused();
  await openMenu.click();
  await drawer.getByRole('link', { name: 'API and CLI', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('API and CLI reference');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('mobile-reference.png') });
  await page.getByRole('button', { name: 'Search documentation (Command or Control K)' }).click();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const href of ['/first-preview/', '/mcp/', '/library/', '/configuration/', '/integrations/', '/services-and-jobs/', '/dashboard/', '/secrets/']) {
    await page.goto(href);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), href).toBe(true);
  }
  await page.goto('/404.html');
  await expect(page.locator('h1')).toHaveText('Page not found');
  await page.getByRole('link', { name: 'Read the Previewhost introduction' }).click();
  await expect(page.locator('h1')).toHaveText('Introduction');
});

test('deep links and reading without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/databases/#prepare-docker');
  await expect(page.getByRole('heading', { name: 'Prepare Docker' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Installation', exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Installation', exact: true }).first().click();
  await expect(page.locator('h1')).toHaveText('Installation');
  const response = await page.goto('http://127.0.0.1:4173/missing-page/');
  expect(response?.status()).toBe(404);
  await context.close();
});

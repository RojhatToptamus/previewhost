import { expect, test, type Page } from '@playwright/test';

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function selectPreview(page: Page, id: 'inventory-main' | 'inventory-stock' | 'booking-main' | 'overview' | 'secrets') {
  if (await page.getByRole('combobox', { name: 'Choose preview', exact: true }).isVisible()) {
    const labels = { 'inventory-main': 'inventory / main', 'inventory-stock': 'inventory / feature/stock-alerts', 'booking-main': 'booking / main', overview: 'Overview', secrets: 'Secret Manager' };
    await choose(page, 'Choose preview', labels[id]);
  } else {
    const names = { 'inventory-main': 'inventory main Ready', 'inventory-stock': 'inventory feature/stock-alerts Ready', 'booking-main': 'booking main Ready', overview: 'Overview', secrets: 'Secret Manager' };
    if (id !== 'overview' && id !== 'secrets') {
      const group = page.locator('.demo-project-toggle').filter({ hasText: id === 'booking-main' ? 'booking' : 'inventory' });
      if (await group.getAttribute('aria-expanded') === 'false') await group.click();
    }
    await page.getByRole('button', { name: names[id], exact: id !== 'overview' }).click();
  }
}

test('ready previews expose isolated application stacks without launching local software', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.demo-services tbody tr')).toHaveCount(4);
  await expect(page.locator('.demo-services')).toContainText('Next.js');
  await expect(page.locator('.demo-services')).toContainText('FastAPI');
  await expect(page.locator('.demo-job')).toContainText('Succeeded');
  await expect(page.getByRole('button', { name: /Open app|Play startup|Start demo/ })).toHaveCount(0);
  await expect(page.locator('.product-demo a, .product-demo dialog, .product-demo select:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy hostname URL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('http://inventory--frontend.localhost:49837');
  await page.getByRole('button', { name: 'Copy localhost URL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('http://127.0.0.1:49837');
  await selectPreview(page, 'inventory-stock');
  await expect(page.locator('.demo-identity')).toContainText('feature/stock-alerts');
  await expect(page.locator('.demo-project-path code')).toHaveText('~/worktrees/inventory-stock-alerts');
  await expect(page.locator('.demo-address')).toContainText(':49902');
  await expect(page.locator('.demo-services [data-tone="success"]')).toHaveCount(4);
  await selectPreview(page, 'booking-main');
  await expect(page.locator('.demo-address')).toContainText('booking--frontend.localhost:49961');
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await expect(page.locator('.demo-log-output')).toContainText('GET /rooms/studio');
  await expect(page.locator('.demo-log-output')).not.toContainText('SKU-1042');
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await page.getByText('YAML', { exact: true }).click();
  await expect(page.getByLabel('booking configuration', { exact: true })).toContainText('name: booking');
  await expect(page.getByLabel('booking configuration', { exact: true })).toContainText('booking/dev/api-token');
  expect(writes).toEqual([]);
});

test('log playback pauses, filters each process during updates, and preserves scroll position', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await page.locator('.demo-log-output').scrollIntoViewIfNeeded();
  await expect(page.locator('.demo-log-line')).toHaveCount(8);
  await page.clock.runFor(2200);
  await expect(page.locator('.demo-log-line')).toHaveCount(9);
  await expect(page.locator('.demo-log-line').last()).toContainText('POST /stock-movements');
  await page.getByRole('button', { name: 'Pause demo log playback' }).click();
  await page.clock.runFor(6600);
  await expect(page.locator('.demo-log-line')).toHaveCount(9);
  await page.getByRole('button', { name: 'Resume demo log playback' }).click();
  await page.clock.runFor(2200);
  await expect(page.locator('.demo-log-line').last()).toContainText('stock cache invalidated');
  for (const source of ['frontend', 'api', 'migrate', 'frontend']) {
    await choose(page, 'Log source', source);
    await expect(page.getByRole('combobox', { name: 'Log source', exact: true })).toHaveText(source);
    await page.clock.runFor(2200 * 6);
    const sources = await page.locator('.demo-log-line > code').allTextContents();
    expect(sources.length).toBeGreaterThan(0);
    expect([...new Set(sources)]).toEqual([source]);
  }
  await page.getByRole('searchbox', { name: 'Search example logs' }).fill('stock-movements');
  await expect(page.locator('.demo-log-output')).toHaveText('No matching output.');
  await choose(page, 'Log source', 'api');
  await expect(page.locator('.demo-log-output')).toContainText('POST /stock-movements');
  await page.getByRole('searchbox', { name: 'Search example logs' }).fill('');
  await choose(page, 'Log source', 'All output');
  await page.clock.runFor(2200 * 65);
  await expect(page.locator('.demo-log-line')).toHaveCount(60);
  await page.locator('.demo-log-output').evaluate(element => { element.scrollTop = 0; });
  await page.clock.runFor(2200);
  expect(await page.locator('.demo-log-output').evaluate(element => element.scrollTop)).toBe(0);
});

test('navigation, source filters and search have clear keyboard focus and useful results', async ({ page }) => {
  await page.goto('/');
  const booking = page.locator('.demo-project-toggle').filter({ hasText: 'booking' });
  const inventory = page.locator('.demo-project-toggle').filter({ hasText: 'inventory' });
  await booking.press('Enter');
  await expect(booking).toHaveAttribute('aria-expanded', 'true');
  await expect(inventory).toHaveAttribute('aria-expanded', 'false');
  await booking.press('Space');
  await expect(booking).toHaveAttribute('aria-expanded', 'false');
  await expect(booking).toBeFocused();
  await inventory.press('Enter');
  const views = page.getByRole('tablist', { name: 'Example product views' });
  await views.getByRole('tab', { name: 'Activity', exact: true }).press('ArrowRight');
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toBeFocused();
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toHaveCSS('outline-style', 'solid');
  await page.getByRole('button', { name: 'Pause demo log playback' }).click();
  await choose(page, 'Log source', 'api');
  const sourcePicker = page.getByRole('combobox', { name: 'Log source', exact: true });
  await sourcePicker.press('Enter');
  await expect(page.getByRole('option', { name: 'api', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: 'migrate', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sourcePicker).toHaveText('migrate');
  await expect(sourcePicker).toBeFocused();
  await expect(page.locator('.demo-log-output')).toContainText('create products and stock_movements');
  await sourcePicker.press('Shift+Tab');
  const search = page.getByRole('searchbox', { name: 'Search example logs' });
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS('outline-style', 'none');
  await expect(page.locator('.demo-search')).toHaveCSS('outline-style', 'solid');
  await search.fill('missing line');
  await expect(page.locator('.demo-log-output')).toHaveText('No matching output.');
  await views.getByRole('tab', { name: 'Logs', exact: true }).press('End');
  await expect(views.getByRole('tab', { name: 'Configuration', exact: true })).toBeFocused();
  await expect(page.locator('.demo-binding-table')).toContainText('NEXT_PUBLIC_API_URL');
  await page.getByText('YAML', { exact: true }).click();
  await expect(page.getByLabel('inventory configuration', { exact: true })).toContainText('command: [python, -m, uvicorn');
  await page.locator('.demo-panel').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await views.getByRole('tab', { name: 'Configuration', exact: true }).press('Home');
  await expect.poll(() => page.locator('.demo-panel').evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'View frontend logs', exact: true }).click();
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toBeFocused();
  await expect(sourcePicker).toHaveText('frontend');
  await expect(search).toHaveValue('');
  await expect(page.locator('.demo-log-output')).toContainText('GET /inventory');
  await selectPreview(page, 'secrets');
  await expect(page.locator('.demo-reference-list li')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search secret references' }).fill('booking');
  await expect(page.locator('.demo-reference-list li')).toHaveCount(1);
  await expect(page.locator('.demo-reference-list')).toContainText('booking/dev/api-token');
  await page.getByRole('searchbox', { name: 'Search secret references' }).fill('missing');
  await expect(page.locator('.demo-empty')).toHaveText('No matching references.');
  await selectPreview(page, 'overview');
  await expect(page.locator('.demo-overview-list button')).toHaveCount(3);
  await page.locator('.demo-overview-list button').first().press('Enter');
  await expect(views.getByRole('tab', { name: 'Activity', exact: true })).toBeFocused();
});

test('source selection, scrollbars and open dropdowns preserve content positions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    const geometry = () => page.evaluate(() => {
      const demo = document.querySelector('.demo-window')!.getBoundingClientRect();
      const content = document.querySelector('.demo-view-content')!.getBoundingClientRect();
      return { demoX: demo.x, demoWidth: demo.width, contentX: content.x, contentWidth: content.width };
    });
    const initial = await geometry();
    await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    await page.getByText('YAML', { exact: true }).click();
    expect(await page.locator('.demo-panel').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await geometry()).toEqual(initial);
    await page.getByRole('tab', { name: 'Logs', exact: true }).click();
    const controls = await page.locator('.demo-log-controls').boundingBox();
    const searchWidth = (await page.locator('.demo-search').boundingBox())!.width;
    for (const source of ['frontend', 'api', 'migrate', 'All output']) {
      await page.getByRole('combobox', { name: 'Log source', exact: true }).click();
      expect(await geometry()).toEqual(initial);
      await page.getByRole('option', { name: source, exact: true }).click();
      expect(await geometry()).toEqual(initial);
      expect(await page.locator('.demo-log-controls').boundingBox()).toEqual(controls);
      expect((await page.locator('.demo-search').boundingBox())!.width).toBe(searchWidth);
    }
    const search = page.getByRole('searchbox', { name: 'Search example logs' });
    await search.fill('Context impl');
    const lineWidth = (await page.locator('.demo-log-line').boundingBox())!.width;
    await search.fill('');
    await page.locator('.demo-log-output').scrollIntoViewIfNeeded();
    await page.clock.runFor(2200 * 20);
    expect(await page.locator('.demo-log-output').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect((await page.locator('.demo-log-line').first().boundingBox())!.width).toBe(lineWidth);
    expect(await geometry()).toEqual(initial);
  }
});

test('all four setup interfaces have correct copyable instructions and links', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page).toHaveTitle('Previewhost | Local previews for full-stack apps');
  await expect(page.locator('h1')).toHaveText('Local previews for full-stack apps.');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.locator('.landing img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy quick install command', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm install -g previewhost');
  await page.getByRole('link', { name: 'Choose your interface', exact: true }).click();
  await expect(page).toHaveURL(/#get-started$/);
  await page.getByRole('button', { name: 'Copy private setup command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('previewhost secrets setup --allow-exec');
  await page.getByRole('button', { name: 'Copy inspect and start commands' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('previewhost inspect\npreviewhost start --allow-exec');
  await page.getByRole('button', { name: 'Copy dashboard command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('previewhost dashboard');
  for (const [name, command] of [['Codex', 'codex mcp add previewhost -- previewhost mcp --allow-exec'], ['Claude Code', 'claude mcp add --scope user previewhost -- previewhost mcp --allow-exec']]) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.getByRole('button', { name: `Copy ${name} MCP command` }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  }
  await page.getByRole('tab', { name: 'Claude Code', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Cursor', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Copy Cursor configuration' }).click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual({ mcpServers: { previewhost: { type: 'stdio', command: 'previewhost', args: ['mcp', '--allow-exec'] } } });
  await page.getByRole('button', { name: 'Copy agent prompt', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Preview this application with Previewhost. Read its instructions and start commands, reuse the project configuration if present, and verify the returned URL in a browser.');
  await page.getByRole('tab', { name: 'Cursor', exact: true }).press('Home');
  await expect(page.getByRole('tab', { name: 'CLI', exact: true })).toBeFocused();
  const localLinks = await page.locator('.landing a[href^="/"]').evaluateAll(elements => [...new Set(elements.map(el => (el as HTMLAnchorElement).pathname))]);
  for (const href of localLinks) expect((await page.request.get(href)).status(), href).toBe(200);
  await page.getByRole('link', { name: 'Docs', exact: true }).click();
  await expect(page).toHaveURL(/\/introduction\/$/);
  await page.getByRole('link', { name: 'Previewhost home', exact: true }).click();
  await expect(page.locator('#hero-heading')).toBeVisible();
  expect(errors).toEqual([]);
});

test('all demo views and setup interfaces fit desktop and mobile in both themes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      if (await page.locator('html').getAttribute('data-site-theme') !== theme) await page.getByRole('button', { name: 'Toggle color theme' }).click();
      await expect(page.locator('#hero-heading, .product-demo')).toHaveCount(2);
      await expect(page.locator('#hero-heading')).toHaveCSS('animation-name', 'none');
      await expect(page.locator('.product-demo')).toHaveCSS('animation-name', 'none');
      const demo = page.locator('.demo-window');
      const height = (await demo.boundingBox())!.height;
      for (const preview of ['inventory-main', 'inventory-stock', 'booking-main'] as const) {
        await selectPreview(page, preview);
        for (const name of ['Activity', 'Logs', 'Configuration']) {
          await page.getByRole('tab', { name, exact: true }).click();
          expect((await demo.boundingBox())!.height).toBe(height);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width} ${preview} ${name}`).toBe(true);
        }
        await page.getByRole('tab', { name: 'Logs', exact: true }).click();
        const source = page.getByRole('combobox', { name: 'Log source', exact: true });
        await source.click();
        await expect(page.getByRole('listbox')).toBeVisible();
        const bounds = (await page.getByRole('listbox').boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await page.keyboard.press('Escape');
        await expect(source).toBeFocused();
      }
      await selectPreview(page, 'secrets');
      await expect(page.getByRole('searchbox', { name: 'Search secret references' })).toBeVisible();
      await selectPreview(page, 'overview');
      await expect(page.locator('.demo-overview-list button')).toHaveCount(3);
      for (const name of ['CLI', 'Codex', 'Claude Code', 'Cursor']) {
        await page.getByRole('tab', { name, exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width} setup ${name}`).toBe(true);
      }
    }
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-site-theme', 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await page.getByRole('link', { name: 'Why Previewhost' }).click();
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#workflow-heading')).toBeInViewport();
});

test('copy failure and JavaScript-free reading remain useful', async ({ page, browser }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Clipboard denied')) } }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy quick install command' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copy failed.' })).toHaveText('Copy failed. Select the text and copy it manually.');
  await page.getByRole('button', { name: 'Copy project folder', exact: true }).click();
  await expect(page.locator('.demo-project-path [role="status"]')).toHaveText('Copy failed. Select and copy the text.');
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await context.newPage();
  await staticPage.goto('http://127.0.0.1:4173/');
  await expect(staticPage.locator('h1')).toContainText('Local previews');
  await expect(staticPage.locator('.demo-noscript')).toContainText('Enable JavaScript');
  await expect(staticPage.locator('.product-demo button:visible')).toHaveCount(0);
  await staticPage.getByRole('link', { name: 'Choose your interface', exact: true }).click();
  await expect(staticPage.locator('#start-heading')).toBeInViewport();
  await staticPage.locator('#get-started').getByRole('link', { name: 'Follow the CLI quickstart' }).click();
  await expect(staticPage.locator('h1')).toHaveText('First preview with the CLI');
  await context.close();
});

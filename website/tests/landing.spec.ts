import { expect, test, type Page } from '@playwright/test';

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function selectPreview(page: Page, id: 'notes-main' | 'notes-styleguide' | 'notes-export' | 'docs-main' | 'overview' | 'secrets') {
  if (await page.getByRole('combobox', { name: 'Choose preview', exact: true }).isVisible()) {
    const labels = { 'notes-main': 'shared-notes / main · shared-notes', 'notes-styleguide': 'shared-notes / main · styleguide', 'notes-export': 'shared-notes / feature/export', 'docs-main': 'docs-site / main', overview: 'Overview', secrets: 'Secret Manager' };
    await choose(page, 'Choose preview', labels[id]);
  } else {
    const names = { 'notes-main': 'shared-notes main · shared-notes Ready', 'notes-styleguide': 'shared-notes main · styleguide Ready', 'notes-export': 'shared-notes feature/export Update failed', 'docs-main': 'docs-site main Ready', overview: 'Overview', secrets: 'Secret Manager' };
    if (id !== 'overview' && id !== 'secrets') {
      const group = page.locator('.demo-project-toggle').filter({ hasText: id === 'docs-main' ? 'docs-site' : 'shared-notes' });
      if (await group.getAttribute('aria-expanded') === 'false') await group.click();
    }
    await page.getByRole('button', { name: names[id], exact: id !== 'overview' }).click();
  }
}

test('previews expose separate stacks without app launch or tutorial controls', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.demo-services tbody tr')).toHaveCount(5);
  await expect(page.locator('.demo-job')).toContainText('Succeeded');
  await expect(page.locator('.demo-address')).toContainText(':49837');
  await expect(page.getByRole('button', { name: /Open app|Play startup|Start demo/ })).toHaveCount(0);
  await expect(page.locator('.product-demo a, .product-demo dialog, .product-demo select:visible')).toHaveCount(0);
  await expect(page.locator('.demo-project-toggle').filter({ hasText: 'shared-notes' })).toHaveText('shared-notes3');
  await page.getByRole('button', { name: 'Copy hostname URL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('http://shared-notes--frontend.localhost:49837');
  await page.getByRole('button', { name: 'Copy localhost URL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('http://127.0.0.1:49837');
  await selectPreview(page, 'notes-styleguide');
  await expect(page.locator('.demo-identity')).toContainText('styleguide');
  await expect(page.locator('.demo-project-path code')).toHaveText('~/code/shared-notes');
  await expect(page.locator('.demo-localhost code')).toHaveText('127.0.0.1:49838');
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await page.getByText('YAML', { exact: true }).click();
  await expect(page.getByLabel('styleguide configuration', { exact: true })).toContainText('directory: ./storybook-static');
  await selectPreview(page, 'notes-export');
  await expect(page.locator('.demo-identity')).toContainText('feature/export');
  await expect(page.locator('.demo-address')).toContainText(':49902');
  await expect(page.locator('.demo-attempts')).toContainText('Previous preview still serving.');
  await expect(page.locator('.demo-services [data-tone="success"]')).toHaveCount(5);
  await selectPreview(page, 'docs-main');
  await expect(page.locator('.demo-localhost code')).toHaveText('127.0.0.1:49961');
  await expect(page.locator('.demo-services')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await expect(page.locator('.demo-log-output')).toHaveText('No process output.');
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await page.getByText('YAML', { exact: true }).click();
  await expect(page.getByLabel('docs-site configuration', { exact: true })).toContainText('type: static');
  expect(writes).toEqual([]);
});

test('demo logs update, pause, filter and remain bounded without changing failed attempts', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await page.locator('.demo-log-output').scrollIntoViewIfNeeded();
  await expect(page.locator('.demo-log-line')).toHaveCount(7);
  await page.clock.runFor(2200);
  await expect(page.locator('.demo-log-line')).toHaveCount(8);
  await page.getByRole('button', { name: 'Pause demo log playback' }).click();
  await page.clock.runFor(6600);
  await expect(page.locator('.demo-log-line')).toHaveCount(8);
  await page.getByRole('button', { name: 'Resume demo log playback' }).click();
  await page.clock.runFor(2200);
  await expect(page.locator('.demo-log-line')).toHaveCount(9);
  await page.clock.runFor(2200);
  await expect(page.locator('.demo-log-line').last()).toContainText('note saved; cache updated');
  await expect(page.locator('.demo-log-line time').last()).toHaveText('09:41:20');
  await choose(page, 'Log source', 'api');
  await expect(page.locator('.demo-log-output')).toContainText('POST /notes 201');
  await expect(page.locator('.demo-log-output')).not.toContainText('frontend');
  await page.getByRole('searchbox', { name: 'Search example logs' }).fill('POST');
  await expect(page.locator('.demo-log-line')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search example logs' }).fill('');
  await choose(page, 'Log source', 'All output');
  await page.clock.runFor(2200 * 65);
  await expect(page.locator('.demo-log-line')).toHaveCount(60);
  await page.locator('.demo-log-output').evaluate(element => { element.scrollTop = 0; });
  await page.clock.runFor(2200);
  expect(await page.locator('.demo-log-output').evaluate(element => element.scrollTop)).toBe(0);
  await selectPreview(page, 'notes-export');
  await page.getByRole('button', { name: 'Migration logs', exact: true }).click();
  await page.clock.runFor(6600);
  await expect(page.locator('.demo-log-line')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Pause demo log playback' })).toHaveCount(0);
});

test('logs, configuration, overview and reference search have meaningful keyboard behavior', async ({ page }) => {
  await page.goto('/');
  const docs = page.locator('.demo-project-toggle').filter({ hasText: 'docs-site' });
  const notes = page.locator('.demo-project-toggle').filter({ hasText: 'shared-notes' });
  await docs.press('Enter');
  await expect(docs).toHaveAttribute('aria-expanded', 'true');
  await expect(notes).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'docs-site main Ready', exact: true })).toBeVisible();
  await docs.press('Space');
  await expect(docs).toHaveAttribute('aria-expanded', 'false');
  await expect(docs).toBeFocused();
  await notes.press('Enter');
  await expect(notes).toHaveAttribute('aria-expanded', 'true');
  const views = page.getByRole('tablist', { name: 'Example product views' });
  await views.getByRole('tab', { name: 'Activity', exact: true }).press('ArrowRight');
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toBeFocused();
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toHaveCSS('outline-style', 'solid');
  await page.getByRole('button', { name: 'Pause demo log playback' }).click();
  await choose(page, 'Log source', 'api');
  await expect(page.locator('.demo-log-line')).toHaveCount(2);
  await expect(page.locator('.demo-log-output')).toContainText('api v1: ready for HTTP requests.');
  const sourcePicker = page.getByRole('combobox', { name: 'Log source', exact: true });
  await sourcePicker.press('Enter');
  await expect(page.getByRole('option', { name: 'api', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: 'migrate', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sourcePicker).toHaveText('migrate');
  await expect(sourcePicker).toBeFocused();
  await expect(page.locator('.demo-log-output')).toContainText('Notes schema ready.');
  await choose(page, 'Log source', 'api');
  await page.getByRole('searchbox', { name: 'Search example logs' }).fill('missing line');
  await expect(page.locator('.demo-log-output')).toHaveText('No matching output.');
  await views.getByRole('tab', { name: 'Logs', exact: true }).press('End');
  await expect(views.getByRole('tab', { name: 'Configuration', exact: true })).toBeFocused();
  await expect(page.locator('.demo-binding-table')).toContainText('Browser URL');
  await page.getByText('YAML', { exact: true }).click();
  await expect(page.getByLabel('shared-notes configuration', { exact: true })).toContainText('REPORTING_URL: { service: reporting }');
  await page.locator('.demo-panel').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await views.getByRole('tab', { name: 'Configuration', exact: true }).press('Home');
  await expect.poll(() => page.locator('.demo-panel').evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'View reporting logs', exact: true }).click();
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Log source', exact: true })).toHaveText('reporting');
  await expect(page.getByRole('searchbox', { name: 'Search example logs' })).toHaveValue('');

  await selectPreview(page, 'notes-export');
  await page.getByRole('button', { name: 'Migration logs', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Log attempt', exact: true })).toHaveText('Latest update');
  await expect(page.locator('.demo-log-output')).toContainText('Migration failed.');
  await choose(page, 'Log attempt', 'Serving');
  await expect(page.locator('.demo-log-output')).toContainText('Notes schema ready.');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'View api logs', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Log attempt', exact: true })).toHaveText('Serving');
  await expect(page.locator('.demo-log-output')).toContainText('api v1: ready');

  await selectPreview(page, 'secrets');
  await expect(page.locator('.demo-reference-list li')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search secret references' }).fill('export');
  await expect(page.locator('.demo-reference-list li')).toHaveCount(1);
  await expect(page.locator('.demo-reference-list')).toContainText('notes/export/api-token');
  await page.getByRole('searchbox', { name: 'Search secret references' }).fill('missing');
  await expect(page.locator('.demo-empty')).toHaveText('No matching references.');
  await expect(page.locator('.demo-secret-manager input:not([type="search"])')).toHaveCount(0);
  await selectPreview(page, 'overview');
  await expect(page.locator('.demo-overview-list button')).toHaveCount(4);
  await page.locator('.demo-overview-list button').first().press('Enter');
  await expect(views.getByRole('tab', { name: 'Activity', exact: true })).toBeFocused();
});

test('demo scrollbars and open dropdowns preserve content positions', async ({ page }) => {
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
    expect(await geometry()).toEqual(initial);
    await page.getByRole('combobox', { name: 'Log source', exact: true }).click();
    await expect(page.getByRole('listbox')).toBeVisible();
    expect(await geometry()).toEqual(initial);
    await page.keyboard.press('Escape');
    const search = page.getByRole('searchbox', { name: 'Search example logs' });
    await search.fill('Notes schema ready.');
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
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Preview this application with Previewhost. Read its instructions and start commands,\nreuse the project configuration if present, and verify the returned URL in a browser.');
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
      for (const preview of ['notes-main', 'notes-styleguide', 'notes-export', 'docs-main'] as const) {
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
      await expect(page.locator('.demo-overview-list button')).toHaveCount(4);
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

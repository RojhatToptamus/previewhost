import { expect, test, type Page } from '@playwright/test';

async function selectPreview(page: Page, id: 'notes-main' | 'notes-export' | 'docs-main' | 'overview' | 'secrets') {
  const picker = page.getByLabel('Choose example preview', { exact: true });
  if (await picker.isVisible()) {
    await picker.selectOption(id);
  } else {
    const names = { 'notes-main': 'shared-notes main Ready', 'notes-export': 'shared-notes feature/export Update failed', 'docs-main': 'docs-site main Ready', overview: 'Overview', secrets: 'Secret Manager' };
    await page.getByRole('button', { name: names[id], exact: id !== 'overview' }).click();
  }
}

test('populated previews keep worktree data separate and expose the static app', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.demo-identity')).toContainText('shared-notes');
  await expect(page.locator('.demo-services tbody tr')).toHaveCount(5);
  await expect(page.locator('.demo-job')).toContainText('Succeeded');
  await expect(page.getByRole('button', { name: /Play startup|Start demo/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open app', exact: true }).click();
  const app = page.getByRole('dialog', { name: 'Shared notes', exact: true });
  await expect(app.getByRole('region', { name: 'Recent notes' })).toContainText('A note from the main worktree.');
  await app.getByLabel('Add a note', { exact: true }).fill('Only the main worktree should contain this');
  await app.getByRole('button', { name: 'Save note' }).click();
  await expect(app.getByRole('status')).toHaveText('Saved in this example worktree.');
  await expect(app.getByRole('region', { name: 'Shared data check' })).toContainText('Only the main worktree should contain this');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open app', exact: true })).toBeFocused();

  await selectPreview(page, 'notes-export');
  await expect(page.locator('.demo-identity')).toContainText('feature/export');
  await expect(page.locator('.demo-address')).toContainText(':49902');
  await expect(page.locator('.demo-attempts')).toContainText('Previous preview still serving.');
  await expect(page.locator('.demo-services [data-tone="success"]')).toHaveCount(5);
  await page.getByRole('button', { name: 'Open app', exact: true }).click();
  await expect(app.getByRole('region', { name: 'Recent notes' })).toContainText('Export worktree: try the new report.');
  await expect(app).not.toContainText('Only the main worktree should contain this');
  await page.keyboard.press('Escape');
  await selectPreview(page, 'notes-main');
  await page.getByRole('button', { name: 'Open app', exact: true }).click();
  await expect(app).toContainText('Only the main worktree should contain this');
  await page.keyboard.press('Escape');

  await selectPreview(page, 'docs-main');
  await expect(page.locator('.demo-identity')).toContainText('docs-site');
  await expect(page.locator('.demo-metadata')).toContainText('Localhost');
  await expect(page.locator('.demo-address')).toHaveText('127.0.0.1:49961');
  await expect(page.locator('.demo-services')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await expect(page.locator('.demo-log-output')).toContainText('Static previews have no process output.');
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await page.getByText('View complete YAML', { exact: true }).click();
  await expect(page.getByLabel('docs-site configuration', { exact: true })).toContainText('type: static');
  await page.getByRole('button', { name: 'Open app', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Prepared HTML and assets');
  await page.keyboard.press('Escape');
  expect(writes).toEqual([]);
});

test('logs, configuration, overview and reference search have meaningful keyboard behavior', async ({ page }) => {
  await page.goto('/');
  const views = page.getByRole('tablist', { name: 'Example product views' });
  await views.getByRole('tab', { name: 'Activity', exact: true }).press('ArrowRight');
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toBeFocused();
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('.demo-log-line')).toHaveCount(4);
  await page.getByLabel('Log source', { exact: true }).selectOption('api');
  await expect(page.locator('.demo-log-line')).toHaveCount(1);
  await expect(page.locator('.demo-log-output')).toContainText('api v1: ready for HTTP requests.');
  await page.getByRole('searchbox', { name: 'Search example logs' }).fill('missing line');
  await expect(page.locator('.demo-log-output')).toHaveText('No output matches these filters.');
  await views.getByRole('tab', { name: 'Logs', exact: true }).press('End');
  await expect(views.getByRole('tab', { name: 'Configuration', exact: true })).toBeFocused();
  await expect(page.locator('.demo-binding-table')).toContainText('{browserUrl: api}');
  await page.getByText('View complete YAML', { exact: true }).click();
  await expect(page.getByLabel('shared-notes configuration', { exact: true })).toContainText('REPORTING_URL: { service: reporting }');
  await page.locator('.demo-panel').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await views.getByRole('tab', { name: 'Configuration', exact: true }).press('Home');
  await expect.poll(() => page.locator('.demo-panel').evaluate(element => element.scrollTop)).toBe(0);
  await page.getByRole('button', { name: 'View reporting logs', exact: true }).click();
  await expect(views.getByRole('tab', { name: 'Logs', exact: true })).toBeFocused();
  await expect(page.getByLabel('Log source', { exact: true })).toHaveValue('reporting');
  await expect(page.getByRole('searchbox', { name: 'Search example logs' })).toHaveValue('');

  await selectPreview(page, 'notes-export');
  await page.getByRole('button', { name: 'View failed migration logs', exact: true }).click();
  await expect(page.getByLabel('Log attempt', { exact: true })).toHaveValue('latest');
  await expect(page.locator('.demo-log-output')).toContainText('Migration failed.');
  await page.getByLabel('Log attempt', { exact: true }).selectOption('serving');
  await expect(page.locator('.demo-log-output')).toContainText('Notes schema ready.');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'View api logs', exact: true }).click();
  await expect(page.getByLabel('Log attempt', { exact: true })).toHaveValue('serving');
  await expect(page.locator('.demo-log-output')).toContainText('api v1: ready');

  await selectPreview(page, 'secrets');
  await expect(page.locator('.demo-reference-list li')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search secret references' }).fill('export');
  await expect(page.locator('.demo-reference-list li')).toHaveCount(1);
  await expect(page.locator('.demo-reference-list')).toContainText('notes/export/api-token');
  await page.getByRole('searchbox', { name: 'Search secret references' }).fill('missing');
  await expect(page.locator('.demo-empty')).toHaveText('No references match your search.');
  await expect(page.locator('.demo-secret-manager input:not([type="search"])')).toHaveCount(0);
  await selectPreview(page, 'overview');
  await expect(page.locator('.demo-overview-list button')).toHaveCount(3);
  await page.locator('.demo-overview-list button').first().press('Enter');
  await expect(views.getByRole('tab', { name: 'Activity', exact: true })).toBeFocused();
});

test('all four setup interfaces have correct copyable instructions and links', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page).toHaveTitle('Previewhost — Local app stacks for Git worktrees');
  await expect(page.locator('h1')).toHaveText('Run local app stacksfrom your Git worktrees.');
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
      await expect(page.locator('.landing-hero-copy')).toHaveCSS('animation-name', 'none');
      const demo = page.locator('.demo-window');
      const height = (await demo.boundingBox())!.height;
      for (const preview of ['notes-main', 'notes-export', 'docs-main'] as const) {
        await selectPreview(page, preview);
        for (const name of ['Activity', 'Logs', 'Configuration']) {
          await page.getByRole('tab', { name, exact: true }).click();
          expect((await demo.boundingBox())!.height).toBe(height);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width} ${preview} ${name}`).toBe(true);
        }
        await page.getByRole('button', { name: 'Open app', exact: true }).click();
        expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Open app', exact: true })).toBeFocused();
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
  await expect(page.getByRole('status').filter({ hasText: 'Copy failed.' })).toHaveText('Copy failed. Select the command and copy it manually.');
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await context.newPage();
  await staticPage.goto('http://127.0.0.1:4173/');
  await expect(staticPage.locator('h1')).toContainText('Run local app stacks');
  await expect(staticPage.locator('.demo-noscript')).toContainText('Enable JavaScript');
  await expect(staticPage.getByRole('button', { name: 'Open app', exact: true })).toBeHidden();
  await staticPage.getByRole('link', { name: 'Choose your interface', exact: true }).click();
  await expect(staticPage.locator('#start-heading')).toBeInViewport();
  await staticPage.locator('#get-started').getByRole('link', { name: 'Follow the CLI quickstart' }).click();
  await expect(staticPage.locator('h1')).toHaveText('First preview with the CLI');
  await context.close();
});

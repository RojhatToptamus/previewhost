import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const { createPreviewRuntime } = await import(new URL('../../dist/runtime.js', import.meta.url).href) as typeof import('../../src/runtime');
const { startDaemon } = await import(new URL('../../dist/daemon.js', import.meta.url).href) as typeof import('../../src/daemon');
const { startDashboard } = await import(new URL('../../dist/dashboard.js', import.meta.url).href) as typeof import('../../src/dashboard');
const { SecretSetup } = await import(new URL('../../dist/secrets-setup.js', import.meta.url).href) as typeof import('../../src/secrets-setup');

test('manual private setup survives review dismissal and reload without reading a recipe or starting on save', async ({ page, context }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-resume-ui-')));
  const project = join(root, 'orchard'); await mkdir(project);
  await writeFile(join(project, 'app.cjs'), "require('http').createServer((q,r)=>r.end(process.env.TOKEN ? 'private input available' : 'missing')).listen(+process.env.PORT,process.env.HOST)");
  const runtime = await createPreviewRuntime({ allowedRoots: [project], authorize: () => true });
  Object.defineProperty(runtime.keystore, 'directory', { value: join(root, 'vault') });
  await runtime.keystore.unlock({ password: 'FAKE_fixture_password', confirmation: 'FAKE_fixture_password', create: true });
  const tokenFile = join(root, 'owner/token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0, owner: { projectDirectory: project, pid: process.pid, allowedRoots: [project], allowExec: true, inputKeys: [], secretIds: [] } });
  const id = createHash('sha256').update(project).digest('hex');
  let launch = '', privateUrl = '';
  const open = SecretSetup.prototype.openBrowser;
  SecretSetup.prototype.openBrowser = async url => { privateUrl = url; };
  const dashboard = await startDashboard({ discover: async () => [{ id, tokenFile, connection: { endpoint: daemon.endpoint, pid: process.pid, projectDirectory: project } }], openBrowser: async url => { launch = url; } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await dashboard.open(); await page.goto(launch);
    await page.setViewportSize({ width: 390, height: 844 });
    const sidebarTrigger = page.getByRole('button', { name: 'Toggle Sidebar', exact: true });
    await sidebarTrigger.click();
    await page.getByRole('navigation', { name: 'Dashboard', exact: true }).getByRole('button', { name: 'New preview', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Project folder', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sidebarTrigger).toBeFocused();
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.getByRole('navigation', { name: 'Dashboard', exact: true }).getByRole('button', { name: 'New preview', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Absolute project folder' }).fill(project);
    await dialog.getByRole('combobox', { name: 'Configuration', exact: true }).click();
    await page.getByRole('option', { name: 'YAML or JSON without a file', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Preview configuration', exact: true }).fill(`name: orchard\ntype: command\ncwd: .\ncommand: [${JSON.stringify(process.execPath)}, app.cjs]\nenv:\n  TOKEN: {secret: orchard/dev/api}\n`);
    await page.screenshot({ path: '/tmp/previewhost-new-preview-help.png', animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Review preview', exact: true }).click();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Continue to private setup', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Check setup', exact: true })).toBeVisible();
    const form = await context.newPage(); await form.goto(privateUrl);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form.getByRole('heading', { name: 'Secret setup canceled', exact: true })).toBeVisible();
    await form.close(); await page.bringToFront();
    await delay(1050); // Private-form launches deliberately have a one-second cooldown.
    await page.reload();
    await page.getByRole('main').getByRole('button', { name: 'orchard', exact: true }).click();
    await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    await expect(page.getByText('Configuration awaits review', { exact: true })).toBeVisible();
    await expect(page.getByText('Cannot read the preview spec file.', { exact: false })).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await expect(dialog.getByText('Private setup canceled', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue to private setup', exact: true })).toBeDisabled();
    expect(await runtime.list()).toEqual([]);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Continue to private setup', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Check setup', exact: true })).toBeVisible();
    const resumed = await context.newPage(); await resumed.goto(privateUrl);
    await resumed.getByRole('button', { name: 'Allow names', exact: true }).click();
    // Lose the original review while private entry remains pending.
    await page.reload();
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Check setup', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Check setup', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Check setup', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Open private form', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await resumed.getByLabel('orchard/dev/api', { exact: true }).fill('FAKE_disposable_value');
    await resumed.getByRole('button', { name: 'Save secrets', exact: true }).click();
    await expect(resumed.getByRole('heading', { name: 'Secret setup complete', exact: true })).toBeVisible();
    expect(await runtime.list()).toEqual([]);
    await resumed.close(); await page.bringToFront();
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await expect(dialog.getByText('Private setup complete', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Start preview', exact: true })).toBeDisabled();
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
        await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
      }
      for (const width of [1360, 390]) {
        await page.setViewportSize({ width, height: 740 });
        await expect(dialog.getByRole('button', { name: 'Start preview', exact: true })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await dialog.getByText('Private setup complete', { exact: true }).locator('..').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/previewhost-recovery-${width}-${theme}.png`, animations: 'disabled' });
      }
    }
    await dialog.getByRole('checkbox').focus(); await page.keyboard.press('Space');
    await dialog.getByRole('button', { name: 'Start preview', exact: true }).press('Enter');
    await expect(page.getByRole('link', { name: 'Open app', exact: true })).toBeVisible();
    expect(await (await fetch((await runtime.get('orchard')).url!)).text()).toBe('private input available');
    await expect(readFile(join(project, 'preview.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(project, 'preview.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(errors).toEqual([]);
  } finally {
    SecretSetup.prototype.openBrowser = open;
    await dashboard.close(); await daemon.close(); await runtime.close(); await rm(root, { recursive: true, force: true });
  }
});

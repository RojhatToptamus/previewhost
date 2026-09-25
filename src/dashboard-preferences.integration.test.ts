import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { startDashboard } from './dashboard.js';

test('dashboard pin preferences persist across origins without touching projects and failed saves preserve the list', async t => {
  const directory = await mkdtemp(join(os.tmpdir(), 'previewhost-navigation-'));
  const home = t.mock.method(os, 'homedir', () => directory);
  syncBuiltinESMExports();
  const dashboards: Array<Awaited<ReturnType<typeof startDashboard>>> = [];
  t.after(async () => {
    await Promise.all(dashboards.map(dashboard => dashboard.close()));
    home.mock.restore(); syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  });
  let discoveries = 0;
  async function session() {
    let launch = '';
    const dashboard = await startDashboard({
      discover: async () => { discoveries++; return []; },
      openBrowser: async url => { launch = url; },
    });
    dashboards.push(dashboard);
    await dashboard.open();
    return { endpoint: dashboard.endpoint, close: dashboard.close, async api(body: object, headers = {}) {
      const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: {
        'content-type': 'application/json', origin: dashboard.endpoint,
        authorization: 'Bearer ' + new URL(launch).hash.slice(1), ...headers,
      }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { result?: { pinnedProjects: string[] }; error?: { code: string } } };
    } };
  }
  const first = await session();
  assert.deepEqual((await first.api({ action: 'navigationPreferences' })).body.result, { pinnedProjects: [] });
  const preferencesDirectory = join(directory, '.local', 'share', 'previewhost', 'dashboard');
  await assert.rejects(readFile(join(preferencesDirectory, 'navigation.json')), { code: 'ENOENT' });
  const project = join(directory, 'unchanged-project');
  await writeFile(project, 'Project contents are not navigation state.');
  const pinnedProjects = [project, 'a'.repeat(64), join(directory, 'missing-project', '.git')];
  const save = (ids: string[]) => ({ action: 'saveNavigationPreferences', pinnedProjects: ids });
  assert.equal((await first.api(save(pinnedProjects), { origin: 'http://example.invalid' })).status, 401);
  assert.equal((await first.api(save(pinnedProjects), { authorization: 'Bearer invalid' })).status, 401);
  assert.deepEqual((await first.api(save(pinnedProjects))).body.result, { pinnedProjects });
  for (const invalid of [[project, project], ['relative/path'], Array(257).fill(project)]) {
    assert.equal((await first.api(save(invalid))).body.error?.code, 'INVALID_INPUT');
  }
  const second = await session();
  assert.notEqual(first.endpoint, second.endpoint);
  await first.close();
  assert.deepEqual((await second.api({ action: 'navigationPreferences' })).body.result, { pinnedProjects });
  const reordered = [pinnedProjects[2], pinnedProjects[0]];
  assert.deepEqual((await second.api(save(reordered))).body.result, { pinnedProjects: reordered });
  const backup = preferencesDirectory + '-backup';
  await rename(preferencesDirectory, backup);
  await writeFile(preferencesDirectory, 'Blocked path');
  assert.equal((await second.api(save([]))).body.error?.code, 'INVALID_INPUT');
  assert.deepEqual(JSON.parse(await readFile(join(backup, 'navigation.json'), 'utf8')), { pinnedProjects: reordered });
  await rm(preferencesDirectory); await rename(backup, preferencesDirectory);
  assert.deepEqual((await second.api({ action: 'navigationPreferences' })).body.result, { pinnedProjects: reordered });
  const third = await session();
  const lists = [[project], ['a'.repeat(64)]];
  const writes = await Promise.all([second.api(save(lists[0])), third.api(save(lists[1]))]);
  assert.ok(writes.every(result => result.status === 200));
  const final = (await third.api({ action: 'navigationPreferences' })).body.result!.pinnedProjects;
  assert.ok(lists.some(list => JSON.stringify(list) === JSON.stringify(final)), 'Concurrent saves publish one complete list');
  assert.deepEqual((await third.api(save([]))).body.result, { pinnedProjects: [] });
  assert.equal(await readFile(project, 'utf8'), 'Project contents are not navigation state.');
  assert.equal(discoveries, 0, 'Preferences do not discover or connect to owners');
  await writeFile(join(preferencesDirectory, 'navigation.json'), '{broken');
  assert.equal((await third.api({ action: 'navigationPreferences' })).body.error?.code, 'INVALID_INPUT');
  assert.equal(await readFile(join(preferencesDirectory, 'navigation.json'), 'utf8'), '{broken');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from './dashboard.js';
import { createPreviewRuntime } from './runtime.js';
import { startDaemon } from './daemon.js';
import type { PreviewStatus } from './contracts.js';
import type { ConfigurationView, PreviewReview } from './dashboard-workflows.js';

test('dashboard edits recipes and direct bindings without leaking literals, racing saves or replacing newer work', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-config-ui-')));
  t.after(() => rm(project, { recursive: true, force: true }));
  const backend = join(project, 'backend'); await mkdir(backend);
  await writeFile(join(backend, 'app.mjs'), `import http from 'node:http'; http.createServer((q,r)=>r.end(process.env.LABEL+':'+process.env.HIDDEN)).listen(+process.env.PORT,process.env.HOST);`);
  const file = join(project, 'preview.yml');
  const recipe = `# retained comment\nname: app\ntype: command\ncwd: ./backend\ncommand: [${JSON.stringify(process.execPath)}, app.mjs]\nenv:\n  LABEL: original\n  HIDDEN: PRIVATE_fixture_literal\n`;
  await writeFile(file, recipe);
  const runtime = await createPreviewRuntime({ allowedRoots: [project], authorize: () => true });
  const owner = { projectDirectory: project, pid: process.pid, allowedRoots: [project], allowExec: true, inputKeys: [], secretIds: [] };
  const tokenFile = join(project, '.owner', 'token');
  const daemon = await startDaemon({ runtime, owner, tokenFile, port: 0 });
  t.after(() => daemon.close());
  const id = createHash('sha256').update(project).digest('hex');
  let launch = '';
  const dashboard = await startDashboard({ discover: async () => [{ id, connection: { projectDirectory: project, pid: process.pid, endpoint: daemon.endpoint }, tokenFile }], openBrowser: async url => { launch = url; } });
  t.after(() => dashboard.close()); await dashboard.open();
  async function api<T>(input: object) {
    const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: { 'content-type': 'application/json', origin: dashboard.endpoint, authorization: `Bearer ${new URL(launch).hash.slice(1)}` }, body: JSON.stringify(input) });
    const value = await response.json() as { result: T; error?: { code: string } };
    assert.ok(!JSON.stringify(value).includes('PRIVATE_fixture_literal'));
    return value;
  }
  const prepared = (await api<PreviewReview>({ action: 'previewPrepare', project })).result;
  assert.equal((await runtime.list()).length, 0); // Inspection starts nothing.
  assert.equal(prepared.file, file);
  assert.equal((await api({ action: 'previewLaunch', id: prepared.id, approved: false })).error?.code, 'INVALID_INPUT');
  const started = (await api<{ status: PreviewStatus }>({ action: 'previewLaunch', id: prepared.id, approved: true })).result.status;
  assert.equal((await runtime.wait('app', started.candidate!.id)).state, 'ready');
  const initial = await runtime.get('app');
  assert.equal(await (await fetch(initial.url!)).text(), 'original:PRIVATE_fixture_literal');
  const open = () => api<ConfigurationView>({ action: 'configurationOpen', owner: id, name: 'app', attemptId: initial.active!.id });
  const first = (await open()).result, stale = (await open()).result;
  const saved = await api<ConfigurationView>({ action: 'configurationSave', id: first.id, changes: [{ key: 'LABEL', value: 'edited' }] });
  assert.ok(saved.result);
  assert.equal(await (await fetch(initial.url!)).text(), 'original:PRIVATE_fixture_literal');
  const written = await readFile(file, 'utf8');
  assert.ok(written.includes('# retained comment') && written.includes('./backend') && written.includes('PRIVATE_fixture_literal'));
  assert.equal((await api({ action: 'configurationSave', id: stale.id, changes: [{ key: 'LABEL', value: 'lost' }] })).error?.code, 'STALE_ATTEMPT');
  const review = (await api<PreviewReview>({ action: 'configurationReview', id: first.id, changes: [] })).result;
  const update = (await api<{ status: PreviewStatus }>({ action: 'previewLaunch', id: review.id, approved: true })).result.status;
  assert.equal((await runtime.wait('app', update.candidate!.id)).state, 'ready');
  assert.equal(await (await fetch(initial.url!)).text(), 'edited:PRIVATE_fixture_literal');
  assert.equal((await api({ action: 'previewLaunch', id: stale.id, approved: true })).error?.code, 'STALE_ATTEMPT');
  // Concurrent editors cannot both publish against the same baseline.
  const current = await runtime.get('app');
  const editors = await Promise.all([1, 2].map(() => api<ConfigurationView>({ action: 'configurationOpen', owner: id, name: 'app', attemptId: current.active!.id })));
  const saves = await Promise.all(editors.map((view, i) => api({ action: 'configurationSave', id: view.result.id, changes: [{ key: 'LABEL', value: `writer-${i}` }] })));
  assert.equal(saves.filter(value => !value.error).length, 1);
  // An external edit after review blocks execution, including a newly invalid recipe.
  const next = (await api<PreviewReview>({ action: 'previewPrepare', project })).result;
  await writeFile(file, 'broken: [');
  assert.ok((await api({ action: 'previewLaunch', id: next.id, approved: true })).error);
  assert.equal((await runtime.get('app')).active!.id, current.active!.id);
  assert.ok((await api({ action: 'previewPrepare', project })).error);
  // Explicit direct input never silently reads the broken recipe and does not rewrite it.
  const direct = (await api<PreviewReview>({ action: 'previewPrepare', project, format: 'json', text: JSON.stringify({ name: 'direct', type: 'command', cwd: backend, command: [process.execPath, 'app.mjs'], env: { LABEL: 'direct', HIDDEN: 'PRIVATE_fixture_literal' } }) })).result;
  const directStart = (await api<{ status: PreviewStatus }>({ action: 'previewLaunch', id: direct.id, approved: true })).result.status;
  assert.equal((await runtime.wait('direct', directStart.candidate!.id)).state, 'ready');
  const directView = (await api<ConfigurationView>({ action: 'configurationOpen', owner: id, name: 'direct', attemptId: (await runtime.get('direct')).active!.id })).result;
  assert.equal(directView.file, undefined);
  await api({ action: 'configurationReview', id: directView.id, changes: [{ key: 'LABEL', value: 'unsaved' }] });
  const directApply = (await api<{ status: PreviewStatus }>({ action: 'previewLaunch', id: directView.id, approved: true })).result.status;
  assert.equal((await runtime.wait('direct', directApply.candidate!.id)).state, 'ready');
  assert.equal(await (await fetch((await runtime.get('direct')).url!)).text(), 'unsaved:PRIVATE_fixture_literal');
  assert.equal(await readFile(file, 'utf8'), 'broken: [');
});

test('project discovery merges directory aliases while retaining branches and missing folders', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-project-alias-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), alias = join(root, 'alias'), linked = join(root, 'linked'), missing = join(root, 'missing');
  await mkdir(project);
  await symlink(project, alias, 'dir');
  const git = (...args: string[]) => promisify(execFile)('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', project, ...args]);
  await git('init', '-b', 'main');
  await git('-c', 'user.name=Previewhost Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  await git('worktree', 'add', '-b', 'feature', linked);
  let launch = '';
  const dashboard = await startDashboard({
    discover: async () => [alias, project, linked, missing].map(directory => ({
      id: createHash('sha256').update(directory).digest('hex'), tokenFile: join(root, 'unused-token'),
      connection: { projectDirectory: directory, pid: process.pid, endpoint: 'http://127.0.0.1:1' },
    })),
    openBrowser: async url => { launch = url; },
  });
  t.after(() => dashboard.close());
  await dashboard.open();
  const response = await fetch(dashboard.endpoint + '/api', { method: 'POST', headers: {
    'content-type': 'application/json', origin: dashboard.endpoint, authorization: `Bearer ${new URL(launch).hash.slice(1)}`,
  }, body: JSON.stringify({ action: 'previewProjects' }) });
  assert.equal(response.status, 200);
  const { result } = await response.json() as { result: { projects: Array<{ directory: string; branch?: string }> } };
  assert.deepEqual(result.projects, [
    { directory: linked, branch: 'feature' }, { directory: missing }, { directory: project, branch: 'main' },
  ]);
});

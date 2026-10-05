import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testKeystore } from './testSupport/keystore.js';
import { startDashboard } from './dashboard.js';
import { createPreviewRuntime } from './runtime.js';
import { startDaemon } from './daemon.js';
import type { PreviewStatus } from './contracts.js';
import type { ConfigurationView, PreviewReview } from './dashboard-workflows.js';

test('dashboard edits recipes and direct bindings without leaking literals, racing saves or replacing newer work', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-config-ui-')));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  t.after(async () => {
    try { await dashboard?.close(); }
    finally { try { await daemon?.close(); } finally { await rm(project, { recursive: true, force: true }); } }
  });
  const backend = join(project, 'backend'); await mkdir(backend);
  await writeFile(join(backend, 'app.mjs'), `import http from 'node:http'; http.createServer((q,r)=>r.end(process.env.LABEL+':'+process.env.HIDDEN)).listen(+process.env.PORT,process.env.HOST);`);
  const file = join(project, 'preview.yml');
  const recipe = `# retained comment\nname: app\ntype: command\ncwd: ./backend\ncommand: [${JSON.stringify(process.execPath)}, app.mjs]\nenv:\n  LABEL: original\n  HIDDEN: PRIVATE_fixture_literal\n`;
  await writeFile(file, recipe);
  const runtime = await createPreviewRuntime({ allowedRoots: [project], authorize: () => true });
  const owner = { projectDirectory: project, pid: process.pid, allowedRoots: [project], allowExec: true, inputKeys: [], secretIds: [] };
  const tokenFile = join(project, '.owner', 'token');
  daemon = await startDaemon({ runtime, owner, tokenFile, port: 0 });
  const endpoint = daemon.endpoint;
  const id = createHash('sha256').update(project).digest('hex');
  let launch = '';
  dashboard = await startDashboard({ discover: async () => [{ id, connection: { projectDirectory: project, pid: process.pid, endpoint }, tokenFile }], openBrowser: async url => { launch = url; } });
  const dashboardEndpoint = dashboard.endpoint;
  await dashboard.open();
  async function api<T>(input: object) {
    const response = await fetch(dashboardEndpoint + '/api', { method: 'POST', headers: { 'content-type': 'application/json', origin: dashboardEndpoint, authorization: `Bearer ${new URL(launch).hash.slice(1)}` }, body: JSON.stringify(input) });
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
  const discarded = (await api<PreviewReview>({ action: 'configurationReview', id: directView.id, changes: [{ key: 'LABEL', value: 'discarded' }] })).result;
  const continuing = (await api<PreviewReview>({ action: 'previewPrepare', project, format: 'json', text: JSON.stringify({ name: 'independent', type: 'static', directory: backend }) })).result;
  // Retrying after a lost response must still let the editor review fresh changes.
  await api({ action: 'configurationDiscard', id: discarded.id });
  assert.equal((await api({ action: 'configurationDiscard', id: discarded.id })).error, undefined);
  const remaining = (await api<{ reviews: Array<{ id: string }> }>({ action: 'previewProjects' })).result.reviews;
  assert.ok(!remaining.some(item => item.id === discarded.id));
  assert.ok(remaining.some(item => item.id === continuing.id));
  assert.equal((await api({ action: 'previewResume', id: discarded.id })).error?.code, 'NOT_FOUND');
  assert.equal((await api({ action: 'previewLaunch', id: discarded.id, approved: true })).error?.code, 'INVALID_INPUT');
  assert.equal(await (await fetch((await runtime.get('direct')).url!)).text(), 'direct:PRIVATE_fixture_literal');
  const olderWindow = (await api<PreviewReview>({ action: 'configurationReview', id: discarded.id, changes: [{ key: 'LABEL', value: 'older-review' }] })).result;
  const revised = (await api<PreviewReview>({ action: 'configurationReview', id: olderWindow.id, changes: [{ key: 'LABEL', value: 'unsaved' }] })).result;
  assert.equal((await api({ action: 'previewLaunch', id: olderWindow.id, approved: true })).error?.code, 'NOT_FOUND');
  assert.equal((await api({ action: 'previewLaunch', id: discarded.id, approved: true })).error?.code, 'NOT_FOUND');
  // A failed edit must not change the inputs authorized by the still-open successful review.
  assert.equal((await api({ action: 'configurationReview', id: revised.id, changes: [{ key: 'LABEL', value: 'unseen' }, { service: 'missing', key: 'TOKEN', value: 'invalid' }] })).error?.code, 'INVALID_INPUT');
  const directApply = (await api<{ status: PreviewStatus }>({ action: 'previewLaunch', id: revised.id, approved: true })).result.status;
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


test('dashboard creates an execution-authorized owner for a reviewed Compose application', {
  skip: !process.env.PREVIEWHOST_TEST_DOCKER_SOCKET, timeout: 45000,
}, async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-dashboard-compose-')));
  const keystore = await testKeystore(t);
  const hook = join(keystore.directory, 'preload.mjs');
  await writeFile(hook, keystore.installSource);
  await writeFile(join(project, 'compose.json'), JSON.stringify({ services: { web: {
    image: 'busybox:1.37', command: ['sh', '-c', 'mkdir /www; printf dashboard > /www/index.html; exec httpd -f -p 8080 -h /www'], expose: [8080],
  } } }));
  t.after(() => rm(project, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import {rm} from 'node:fs/promises';
    const {DashboardWorkflows} = await import(${JSON.stringify(new URL('./dashboard-workflows.js', import.meta.url).href)});
    const {connectProject, projectOwnerDirectory, lockProject, writeProjectRecord} = await import(${JSON.stringify(new URL('./project.js', import.meta.url).href)});
    const {join} = await import('node:path');
    const {createDataOwner} = await import(${JSON.stringify(new URL('./data.js', import.meta.url).href)});
    const project = ${JSON.stringify(project)};
    const workflows = new DashboardWorkflows(async () => [], async () => { throw Error('No existing owner'); });
    const client = connectProject({projectDirectory:project,dockerSocket:process.env.PREVIEWHOST_TEST_DOCKER_SOCKET});
    try {
      // Retain the explicit test engine without pre-launching an execution-authorized owner.
      const directory = projectOwnerDirectory(project);
      const lock = await lockProject(directory);
      try {
        const dataDirectory = join(directory,'data');
        await (await createDataOwner({directory:dataDirectory})).close();
        await writeProjectRecord(directory,{projectDirectory:project,dataDirectory,dockerSocket:process.env.PREVIEWHOST_TEST_DOCKER_SOCKET});
      } finally {await lock.close();}
      await assert.rejects(client.info(),{code:'DAEMON_UNAVAILABLE'});
      const spec = {name:'dashboard',type:'compose',cwd:project,files:['compose.json'],rootServices:['web'],
        services:[{id:'web',ports:{http:{target:8080}},ready:{type:'http',port:'http',path:'/',timeoutMs:5000}}],primary:{service:'web',port:'http'}};
      const signal = new AbortController().signal;
      const prepared = await workflows.dispatch({action:'previewPrepare',project,format:'json',text:JSON.stringify(spec)},signal);
      const launched = await workflows.dispatch({action:'previewLaunch',id:prepared.result.id,approved:true},signal);
      assert.equal((await client.info()).allowExec,true);
      const ready = await client.wait('dashboard',launched.result.status.candidate.id);
      assert.equal(ready.state,'ready',JSON.stringify({ready,logs:await client.logs('dashboard',ready.id)}));
      assert.equal((await (await fetch(ready.url)).text()).trim(),'dashboard');
    } finally {
      workflows.close();
      try {
        for(const item of await client.list()) {await client.stop(item.name);if(item.data?.resources.length)await client.deleteData(item.name);}
        await client.shutdown();
      } catch(error) {if(error.code!=='DAEMON_UNAVAILABLE')throw error;}
      await client.close();
      await rm(projectOwnerDirectory(project),{recursive:true,force:true});
    }
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` }, timeout: 40000,
  });
});

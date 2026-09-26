import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startDashboard } from './dashboard.js';
import { startDaemon } from './daemon.js';
import { createPreviewRuntime } from './runtime.js';
import { SecretSetup } from './secrets-setup.js';
import { testKeystore } from './testSupport/keystore.js';
import type { PreviewStatus, RuntimeOptions, SecretSetupStatus } from './contracts.js';
import type { ConfigurationView, PreviewReview, PreviewReviewSummary } from './dashboard-workflows.js';

async function fixture(t: TestContext, authorize: RuntimeOptions['authorize'] = () => true) {
  const isolated = await testKeystore(t);
  const project = await realpath(isolated.directory);
  const runtime = await createPreviewRuntime({ allowedRoots: [project], authorize });
  const tokenFile = join(project, 'control', 'token');
  const owner = { projectDirectory: project, pid: process.pid, allowedRoots: [project], allowExec: true, inputKeys: [], secretIds: [] };
  const daemon = await startDaemon({ runtime, owner, tokenFile, port: 0 });
  const id = createHash('sha256').update(project).digest('hex');
  const privateUrls: string[] = [];
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { privateUrls.push(url); });
  let launch = '';
  const dashboard = await startDashboard({ discover: async () => [{ id, connection: { projectDirectory: project, pid: process.pid, endpoint: daemon.endpoint }, tokenFile }], openBrowser: async url => { launch = url; } });
  await dashboard.open();
  t.after(async () => { await dashboard.close(); await daemon.close(); });
  async function api<T = unknown>(input: object, signal?: AbortSignal) {
    const response = await fetch(`${dashboard.endpoint}/api`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', origin: dashboard.endpoint, authorization: `Bearer ${new URL(launch).hash.slice(1)}` }, body: JSON.stringify(input) });
    const text = await response.text();
    assert.ok(!text.includes('FAKE_private_value'));
    for (const url of privateUrls) assert.ok(!text.includes(new URL(url).hash.slice(1)));
    return JSON.parse(text) as { result: T; error?: { code: string } };
  }
  async function privateCall(operation: string, body: object = {}) {
    const url = new URL(privateUrls.at(-1)!);
    const response = await fetch(`${daemon.endpoint}/secrets/${operation}`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: daemon.endpoint, authorization: `Bearer ${url.hash.slice(1)}` }, body: JSON.stringify(body) });
    return await response.json() as { result: SecretSetupStatus; error?: { code: string } };
  }
  return { ...isolated, project, runtime, daemon, tokenFile, id, privateUrls, api, privateCall };
}

test('canceling dashboard direct binding setup reaches owner authorization and late approval starts nothing', { timeout: 10_000 }, async t => {
  let approve!: (value: boolean) => void;
  let entered!: () => void;
  let aborted!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const canceled = new Promise<void>(resolve => { aborted = resolve; });
  const f = await fixture(t, request => {
    if (request.operation === 'allow-sources') return true;
    if (request.operation !== 'secrets-setup') return false;
    request.signal.addEventListener('abort', aborted, { once: true });
    entered();
    return new Promise<boolean>(resolve => { approve = resolve; });
  });
  const started = await f.runtime.start({ name: 'direct', type: 'command', cwd: f.project, command: [process.execPath, '-e', 'process.exit(1)'] });
  const retained = await f.runtime.wait('direct', started.candidate!.id);
  assert.equal(retained.error?.code, 'EXECUTION_DENIED');
  const view = (await f.api<ConfigurationView>({ action: 'configurationOpen', owner: f.id, name: 'direct', attemptId: retained.id })).result;
  const review = await f.api<PreviewReview>({ action: 'configurationReview', id: view.id, changes: [{ key: 'TOKEN', value: { secret: 'test/direct' } }] });
  assert.deepEqual(review.result.secretIds, ['test/direct']);
  const controller = new AbortController();
  const pending = f.api({ action: 'previewSecrets', id: review.result.id, approved: true }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await preparing;
  controller.abort();
  await rejected;
  await canceled;
  approve(true);
  assert.deepEqual(await f.runtime.inspect({ name: 'check', type: 'command', cwd: f.project, command: ['false'], env: { TOKEN: { secret: 'test/direct' } } }).then(result => result.secrets?.map(item => item.selected)), [false]);
  assert.equal(await f.store.has('user', 'test/direct'), false);
  assert.equal((await f.runtime.get('direct')).latest!.id, retained.id);
  assert.deepEqual(f.privateUrls, []);
});

test('dashboard restores exact direct reviews after canceled or delayed private setup without starting or saving a recipe', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'app.mjs'), `import fs from 'node:fs'; import http from 'node:http'; fs.writeFileSync('started','yes'); http.createServer((q,r)=>r.end(process.env.LABEL+':'+(process.env.TOKEN?'present':'absent'))).listen(+process.env.PORT,process.env.HOST);`);
  const text = `name: app\ntype: command\ncwd: .\ncommand: [${JSON.stringify(process.execPath)}, app.mjs]\nenv:\n  LABEL: original\n  TOKEN: {secret: test/app}\n`;
  const review = (await f.api<PreviewReview>({ action: 'previewPrepare', project: f.project, format: 'yaml', text })).result;
  const other = (await f.api<PreviewReview>({ action: 'previewPrepare', project: f.project, format: 'json', text: JSON.stringify({ name: 'app', type: 'command', cwd: '.', command: [process.execPath, 'app.mjs'], env: { LABEL: 'alternate' } }) })).result;
  const reviews = async () => {
    const result = (await f.api<{ reviews: PreviewReviewSummary[] }>({ action: 'previewProjects' })).result;
    assert.ok(Array.isArray(result.reviews), 'Reviewed configurations must remain discoverable after closing the form');
    return result.reviews;
  };
  assert.deepEqual((await reviews()).map(item => item.id).sort(), [review.id, other.id].sort());
  assert.equal(review.file, undefined);
  // Choosing a file still reports a genuine read failure; it cannot substitute a direct review.
  assert.ok((await f.api({ action: 'previewPrepare', project: f.project })).error);
  assert.equal((await f.api({ action: 'previewLaunch', id: review.id, approved: true })).error?.code, 'SECRET_REQUIRED');
  const first = (await f.api<SecretSetupStatus>({ action: 'previewSecrets', id: review.id, approved: true })).result;
  assert.equal(first.state, 'pending');
  assert.equal((await f.privateCall('cancel')).result.state, 'canceled');
  assert.equal((await f.api({ action: 'previewLaunch', id: review.id, approved: true })).error?.code, 'SECRET_REQUIRED');
  const beforePoll = (await reviews()).find(item => item.id === review.id)!.expiresAt;
  assert.equal((await f.api<SecretSetupStatus>({ action: 'previewSetupStatus', id: review.id })).result.state, 'canceled');
  assert.equal((await reviews()).find(item => item.id === review.id)!.expiresAt, beforePoll);
  const canceled = (await f.api<PreviewReview>({ action: 'previewResume', id: review.id })).result;
  assert.equal(canceled.id, review.id);
  assert.equal(canceled.setup?.id, first.id);
  assert.equal(canceled.setup?.state, 'canceled');
  assert.equal((await f.api<PreviewReview>({ action: 'previewResume', id: other.id })).result.setup, undefined);
  assert.equal((await f.api({ action: 'previewSetupStatus', id: other.id })).error?.code, 'NOT_FOUND');
  assert.equal(f.privateUrls.length, 1);
  assert.deepEqual(await f.runtime.list(), []);
  await delay(1050); // Real private-form launch cooldown.
  const resumed = (await f.api<SecretSetupStatus>({ action: 'previewSecrets', id: review.id, approved: true, reopen: true })).result;
  assert.equal(resumed.state, 'pending');
  assert.equal(f.privateUrls.length, 2);
  assert.equal((await f.api<PreviewReview>({ action: 'previewResume', id: review.id })).result.setup?.id, resumed.id);
  assert.equal((await f.privateCall('approve')).result.requirements[0].selected, true);
  assert.equal((await f.api({ action: 'previewLaunch', id: review.id, approved: true })).error?.code, 'SECRET_REQUIRED');
  const saved = await f.privateCall('save', { values: { 'test/app': 'FAKE_private_value' } });
  assert.equal(saved.result.state, 'complete');
  assert.equal((await f.api<PreviewReview>({ action: 'previewResume', id: review.id })).result.setup?.state, 'complete');
  assert.deepEqual(await f.runtime.list(), []);
  await assert.rejects(readFile(join(f.project, 'started')), { code: 'ENOENT' });
  const launched = (await f.api<{ status: PreviewStatus }>({ action: 'previewLaunch', id: review.id, approved: true })).result.status;
  const ready = await f.runtime.wait('app', launched.candidate!.id);
  assert.equal(ready.state, 'ready');
  assert.equal(await (await fetch(ready.url!)).text(), 'original:present');
  assert.deepEqual((await reviews()).map(item => item.id), [other.id]);
  assert.equal((await f.api({ action: 'previewResume', id: review.id })).error?.code, 'NOT_FOUND');
  assert.equal((await f.api({ action: 'previewResume', id: other.id })).error?.code, 'STALE_ATTEMPT');
  assert.equal((await f.api({ action: 'previewLaunch', id: other.id, approved: true })).error?.code, 'STALE_ATTEMPT');
  assert.equal((await f.runtime.get('app')).active!.id, ready.id);
  for (const file of ['preview.yml', 'preview.yaml']) await assert.rejects(readFile(join(f.project, file)), { code: 'ENOENT' });
});

test('CLI and MCP selected files reach dashboard configuration while direct replacements clear the origin', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'index.html'), 'adapter preview');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const common = ['--endpoint', f.daemon.endpoint, '--token-file', f.tokenFile];
  const execute = promisify(execFile);
  const run = async (args: string[], input = '') => {
    const child = execute(process.execPath, [cli, ...args, ...common], { cwd: f.project });
    child.child.stdin!.end(input);
    return JSON.parse((await child).stdout);
  };
  const mcp = new Client({ name: 'previewhost-origin-contract', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...common], cwd: f.project, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await mcp.connect(transport);
  t.after(() => mcp.close());
  for (const adapter of ['CLI', 'MCP']) {
    const name = adapter.toLowerCase();
    const rootFile = join(f.project, 'preview.yaml'), selected = join(f.project, 'selected.yml');
    await writeFile(rootFile, `name: ${name}\ntype: static\ndirectory: .\n`);
    await writeFile(selected, `name: ${name}\ntype: static\ndirectory: .\n`);
    for (const [operation, file] of [['start', rootFile], ['replace', selected], ['replace', undefined]] as const) {
      const spec = { name, type: 'static', directory: f.project };
      if (adapter === 'CLI') await run([operation, ...(file === rootFile ? [] : ['--file', file ?? '-'])], file ? '' : JSON.stringify(spec));
      else {
        const response = await mcp.callTool({ name: `preview_${operation}`, arguments: { ...(operation === 'replace' ? { name } : {}), ...(file === rootFile ? {} : file ? { file } : { spec }) } });
        assert.equal(response.isError, undefined);
        const status = (response.structuredContent as { result: PreviewStatus }).result;
        assert.equal((await f.runtime.wait(name, status.candidate!.id)).state, 'ready');
      }
      const status = await f.runtime.get(name);
      const opened = (await f.api<ConfigurationView>({ action: 'configurationOpen', owner: f.id, name, attemptId: status.active!.id })).result;
      assert.equal(opened.file, file, `${adapter} ${operation} source`);
    }
  }
});

test('canceling cold owner startup prevents preview admission after its project lock is released', { timeout: 15_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-cold-cancel-')));
  const isolatedHome = join(directory, 'home'), project = join(directory, 'project');
  await mkdir(isolatedHome); await mkdir(project);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const {DashboardWorkflows} = await import(${JSON.stringify(new URL('./dashboard-workflows.js', import.meta.url).href)});
    const {connectProject, lockProject, projectOwnerDirectory} = await import(${JSON.stringify(new URL('./project.js', import.meta.url).href)});
    const project = ${JSON.stringify(project)};
    const lock = await lockProject(projectOwnerDirectory(project));
    let busy;
    const ownerBlocked = new Promise(resolve => { busy = resolve; });
    const fork = childProcess.fork;
    childProcess.fork = (...args) => {
      const child = fork(...args);
      child.once('message', message => { if (message.busy) busy(); });
      return child;
    };
    syncBuiltinESMExports();
    const workflows = new DashboardWorkflows(async () => [], async () => { throw new Error('No owner exists'); });
    const controller = new AbortController();
    const client = connectProject({projectDirectory:project});
    try {
      const prepared = await workflows.dispatch({action:'previewPrepare', project, format:'json', text:JSON.stringify({name:'cold',type:'static',directory:project})}, controller.signal);
      const launching = workflows.dispatch({action:'previewLaunch',id:prepared.result.id,approved:true}, controller.signal);
      const rejected = assert.rejects(launching, {code:'CLOSED'});
      await ownerBlocked;
      controller.abort();
      await lock.close();
      await rejected;
      await assert.rejects(client.list(), {code:'DAEMON_UNAVAILABLE'});
    } finally {
      await lock.close();
      try { await client.shutdown(); } catch (error) { if (error.code !== 'DAEMON_UNAVAILABLE') throw error; }
      await client.close();
      workflows.close();
    }
  `;
  const execute = promisify(execFile);
  await execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: isolatedHome }, timeout: 12_000 });
});

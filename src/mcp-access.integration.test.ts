import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectProject, projectOwnerDirectory } from './project.js';
import type { AttemptResult, PreviewStatus } from './contracts.js';

for (const version of ['2025-11-25', '2026-07-28'] as const) test(`global project approval and isolation over real stdio (${version})`, { skip: process.platform !== 'darwin', timeout: 60_000 }, async t => {
  const projects = await Promise.all([1, 2, 3].map(async () => realpath(await mkdtemp(join(tmpdir(), 'previewhost-access-')))));
  const [front, other, backend] = projects;
  for (const [i, project] of projects.entries()) await writeFile(join(project, 'index.html'), `project ${i}`);
  const adapters: Client[] = [];
  t.after(async () => {
    await Promise.all(adapters.map(c => c.close()));
    for (const project of projects) {
      const c = connectProject({ projectDirectory: project });
      try { await c.shutdown(); } catch (error) { if ((error as { code: string }).code !== 'DAEMON_UNAVAILABLE') throw error; }
      finally { await c.close(); }
      await rm(projectOwnerDirectory(project), { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
  let decision: 'accept' | 'decline' | 'cancel' = 'accept';
  let confirmations = 0;
  async function adapter(execute = true) {
    const c = new Client({ name: 'access-test', version: '1' }, { capabilities: { elicitation: { form: {} } }, ...(version === '2026-07-28' ? { versionNegotiation: { mode: { pin: version } } } : {}) });
    c.setRequestHandler('elicitation/create', async () => { confirmations++; return decision === 'accept' ? { action: decision, content: { allow: true } } : { action: decision }; });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'mcp', ...(execute ? ['--allow-exec'] : [])], stderr: 'pipe' }));
    adapters.push(c); return c;
  }
  const c = await adapter();
  async function call(name: string, project = front, args: object = {}, client = c): Promise<any> {
    const r = await client.callTool({ name, arguments: { project, ...args } });
    return r.structuredContent;
  }
  assert.equal((await call('preview_list')).error.code, 'SOURCE_DENIED');
  assert.equal((await call('preview_access', homedir())).error.code, 'SOURCE_DENIED');
  for (const action of ['decline', 'cancel'] as const) {
    decision = action;
    assert.equal((await call('preview_access')).error.code, 'SOURCE_DENIED');
    assert.equal((await call('preview_list')).error.code, 'SOURCE_DENIED');
  }
  decision = 'accept';
  const granted = await call('preview_access'); assert.equal(granted.result.project, front);
  const count = confirmations;
  await call('preview_access'); assert.equal(confirmations, count);
  const first = (await call('preview_start', front, { spec: { name: 'app', type: 'static', directory: front } })).result as PreviewStatus;
  const ready = (await call('preview_wait', front, { name: 'app', attemptId: first.candidate!.id })).result as AttemptResult;
  assert.equal(await (await fetch(ready.url!)).text(), 'project 0');
  await assert.rejects(import('node:fs/promises').then(fs => fs.stat(join(front, 'preview.yml'))), { code: 'ENOENT' });
  const spec = { name: 'app', type: 'environment', primary: 'web', services: { web: { type: 'static', directory: front }, api: { type: 'static', directory: backend } } };
  assert.equal((await call('preview_inspect', front, { spec })).error.code, 'SOURCE_DENIED');
  assert.ok((await call('preview_access', front, { sources: [backend] })).result);
  assert.equal((await call('preview_get', front, { name: 'app' })).result.active.id, ready.id);
  assert.ok((await call('preview_inspect', front, { spec })).result);
  await symlink(other, join(front, 'escape'));
  assert.equal((await call('preview_inspect', front, { spec: { name: 'escape', type: 'static', directory: join(front, 'escape') } })).error.code, 'SOURCE_DENIED');
  await call('preview_access', other);
  const second = (await call('preview_start', other, { spec: { name: 'app', type: 'static', directory: other } })).result;
  const ready2 = (await call('preview_wait', other, { name: 'app', attemptId: second.candidate.id })).result;
  assert.notEqual(ready.url, ready2.url);
  await call('preview_stop', front, { name: 'app' });
  assert.equal(await (await fetch(ready2.url)).text(), 'project 1');
  assert.ok((await call('preview_save_config', front, { spec })).result);
  await writeFile(join(front, 'preview.yml'), 'name: app\nservices: [\n');
  const broken = await call('preview_start');
  assert.equal(broken.error.code, 'INVALID_INPUT'); assert.match(broken.error.message, /preview.yml.*line/);
  const reconnect = await adapter();
  assert.equal((await call('preview_get', other, { name: 'app' }, reconnect)).error.code, 'SOURCE_DENIED');
  assert.ok((await call('preview_access', other, {}, reconnect)).result);
  assert.equal((await call('preview_get', other, { name: 'app' }, reconnect)).result.active.id, ready2.id);
  await call('preview_shutdown');
  const beforeRecovery = confirmations;
  // Startup restores existing connection grants after owner shutdown without another prompt.
  const restarted = (await call('preview_start', front, { spec })).result;
  assert.ok(restarted, 'direct startup must restore approved external sources');
  assert.equal((await call('preview_wait', front, { name: 'app', attemptId: restarted.candidate.id })).result.state, 'ready');
  await call('preview_shutdown');
  assert.ok((await call('preview_secrets_setup', front, { spec })).result, 'private setup must restore approved external sources');
  assert.equal(confirmations, beforeRecovery);
  assert.ok((await call('preview_inspect', front, { spec })).result);
  // Approval grants sources, never command execution when --allow-exec is absent.
  const staticOnly = await adapter(false);
  assert.ok((await call('preview_access', backend, {}, staticOnly)).result);
  const staticStart = (await call('preview_start', backend, { spec: { name: 'static-only', type: 'static', directory: backend } }, staticOnly)).result;
  assert.equal((await call('preview_wait', backend, { name: 'static-only', attemptId: staticStart.candidate.id }, staticOnly)).result.state, 'ready');
  const command = (await call('preview_start', backend, { spec: { name: 'denied', type: 'command', cwd: backend, command: [process.execPath, '-e', 'process.exit(0)'] } }, staticOnly)).result;
  const rejected = (await call('preview_wait', backend, { name: 'denied', attemptId: command.candidate.id }, staticOnly)).result;
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.error.code, 'EXECUTION_DENIED');
  const database = (await call('preview_start', backend, { spec: { name: 'denied-database', type: 'environment', primary: 'web',
    services: { web: { type: 'static', directory: backend }, db: { type: 'postgres' } } } }, staticOnly)).result;
  const databaseDenied = (await call('preview_wait', backend, { name: 'denied-database', attemptId: database.candidate.id }, staticOnly)).result;
  assert.equal(databaseDenied.error.code, 'EXECUTION_DENIED');
});

test('access confirmation cannot authorize changed paths, forged state, or a closed connection', async t => {
  const { McpAccess } = await import('./mcp-access.js');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-access-state-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const access = new McpAccess({});
  t.after(() => access.close());
  const context = (state?: unknown, action = 'accept') => ({ mcpReq: {
    signal: new AbortController().signal, requestState: () => state,
    inputResponses: { access: { action, content: { allow: true } } },
  } } as unknown as import('@modelcontextprotocol/server').ServerContext);
  const input = { project: directory, sources: [] };
  const pending = await access.request(input, context());
  assert.equal(pending.resultType, 'input_required');
  const state = pending.requestState;
  for (const result of [
    await access.request(input, context('forged')),
    await access.request({ ...input, sources: [await realpath(tmpdir())] }, context(state)),
  ]) assert.equal((result.structuredContent as any).error.code, 'SOURCE_DENIED');
  await assert.rejects(access.roots(directory), { code: 'SOURCE_DENIED' });
  const canceled = await access.request(input, context(state, 'cancel'));
  assert.equal((canceled.structuredContent as any).error.code, 'SOURCE_DENIED');
  const replayed = await access.request(input, context(state));
  assert.equal((replayed.structuredContent as any).error.code, 'SOURCE_DENIED');
  access.close();
  const closed = await access.request(input, context());
  assert.equal((closed.structuredContent as any).error.code, 'CLOSED');
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectProject, projectOwnerDirectory } from './project.js';
import { isPrivate } from './private-files.js';
import type { AttemptResult, PreviewSpec, PreviewStatus, SecretSetupStatus } from './contracts.js';
import { testKeystore } from './testSupport/keystore.js';

const cli = resolve('dist/cli.js');
const executeFile = promisify(execFile);
function execute(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = executeFile(file, args, options);
  result.child.stdin?.end();
  return result;
}
const enabled = { timeout: 60_000 };

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-project-')));
  const client = connectProject({ projectDirectory: directory });
  const projects = [directory];
  t.after(async () => {
    for (const project of projects) {
      const cleanup = connectProject({ projectDirectory: project });
      try {
        for (const preview of await cleanup.list()) {
          await cleanup.stop(preview.name);
          if (preview.data) await cleanup.deleteData(preview.name);
        }
        await cleanup.shutdown();
      }
      catch (error) { if ((error as { code?: string }).code !== 'DAEMON_UNAVAILABLE') throw error; }
      finally { await cleanup.close(); }
    }
    await client.close();
    await delay(100);
    for (const project of projects) await rm(projectOwnerDirectory(project), { recursive: true, force: true });
    for (const project of projects) await rm(project, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'index.html'), 'project preview');
  return { directory, client, projects };
}

test('CLI and real stdio MCP share an automatically started owner, optional root file, direct spec and explicit saving', enabled, async t => {
  const { directory, client } = await fixture(t);
  const keystore = await testKeystore(t);
  const hook = join(keystore.directory, 'preload.mjs');
  await writeFile(hook, keystore.installSource.replaceAll('/.local/test-build/', '/dist/'));
  await assert.rejects(client.list(), { code: 'DAEMON_UNAVAILABLE' });
  const mcp = new Client({ name: 'project-workflow', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--project', directory, '--allow-exec'], stderr: 'pipe',
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` } });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  t.after(() => mcp.close());
  await mcp.connect(transport);
  const spec: PreviewSpec = { name: 'site', type: 'static', directory };
  const outside = await mkdtemp(join(tmpdir(), 'previewhost-outside-config-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, 'spec.json');
  await writeFile(outsideFile, JSON.stringify(spec));
  await symlink(outsideFile, join(directory, 'escape.json'));
  for (const name of ['preview_inspect', 'preview_start', 'preview_replace', 'preview_secrets_setup']) {
    for (const file of [outsideFile, 'escape.json']) {
      const result = await mcp.callTool({ name, arguments: { file, ...(name === 'preview_replace' ? { name: 'site' } : {}) } });
      assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'SOURCE_DENIED');
    }
  }
  await client.inspect(spec);
  await assert.rejects(stat(projectOwnerDirectory(directory)), { code: 'ENOENT' });
  await assert.rejects(client.info(), { code: 'DAEMON_UNAVAILABLE' });
  const started = (await mcp.callTool({ name: 'preview_start', arguments: { spec } })).structuredContent as { result: PreviewStatus };
  const ready = (await mcp.callTool({ name: 'preview_wait', arguments: { name: 'site', attemptId: started.result.candidate!.id } })).structuredContent as { result: AttemptResult };
  assert.equal(ready.result.state, 'ready');
  assert.deepEqual(ready.result.sources, [directory]);
  assert.equal(await (await fetch(ready.result.url!)).text(), 'project preview');
  await assert.rejects(readFile(join(directory, 'preview.yaml')), { code: 'ENOENT' });
  const info = await client.info(); assert.equal(info?.allowExec, true); assert.equal(info?.projectDirectory, directory);
  assert.equal(info?.dataDirectory, join(projectOwnerDirectory(directory), 'data'));
  const permissions = await stat(info!.dataDirectory!);
  if (process.platform === 'win32') assert.ok(isPrivate(info!.dataDirectory!, permissions));
  else assert.equal(permissions.mode & 0o777, 0o700);
  const listed = JSON.parse((await execute(process.execPath, [cli, 'list', '--project', directory])).stdout);
  assert.equal(listed[0].active.id, ready.result.id);
  const saved = (await mcp.callTool({ name: 'preview_save_config', arguments: { spec } })).structuredContent as { result: { file: string } };
  assert.equal(saved.result.file, join(directory, 'preview.yaml'));
  assert.equal((await mcp.callTool({ name: 'preview_inspect', arguments: { file: 'preview.yaml' } })).isError, undefined);
  const duplicate = await mcp.callTool({ name: 'preview_save_config', arguments: { spec } });
  assert.equal((duplicate.structuredContent as { error: { code: string } }).error.code, 'ALREADY_EXISTS');
  assert.equal((await mcp.callTool({ name: 'preview_inspect', arguments: { file: 'preview.yaml', spec } })).isError, true);
  const contents = await readFile(saved.result.file, 'utf8');
  await rm(saved.result.file);
  await writeFile(join(directory, 'preview.yml'), contents);
  assert.equal((await mcp.callTool({ name: 'preview_inspect', arguments: {} })).isError, undefined);
  assert.equal((await mcp.callTool({ name: 'preview_secrets_setup', arguments: {} })).isError, undefined);
  const fallback = (await mcp.callTool({ name: 'preview_replace', arguments: { name: 'site' } })).structuredContent as { result: PreviewStatus };
  assert.equal((await client.wait('site', fallback.result.candidate!.id)).state, 'ready');
  const existingYml = await mcp.callTool({ name: 'preview_save_config', arguments: { spec } });
  assert.equal((existingYml.structuredContent as { error: { code: string } }).error.code, 'ALREADY_EXISTS');
  await assert.rejects(readFile(saved.result.file), { code: 'ENOENT' });
  await writeFile(saved.result.file, contents);
  const active = (await client.get('site')).active!.id;
  for (const name of ['preview_inspect', 'preview_start', 'preview_replace', 'preview_secrets_setup']) {
    const result = await mcp.callTool({ name, arguments: name === 'preview_replace' ? { name: 'site' } : {} });
    const error = (result.structuredContent as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /Both preview.yaml and preview.yml exist/);
  }
  assert.equal((await client.get('site')).active!.id, active);
  assert.equal((await mcp.callTool({ name: 'preview_inspect', arguments: { spec } })).isError, undefined);
  for (const file of ['preview.yaml', 'preview.yml']) {
    assert.equal((await mcp.callTool({ name: 'preview_inspect', arguments: { file } })).isError, undefined);
    const replacement = (await mcp.callTool({ name: 'preview_replace', arguments: { name: 'site', file } })).structuredContent as { result: PreviewStatus };
    assert.equal((await client.wait('site', replacement.result.candidate!.id)).state, 'ready');
  }
  await rm(join(directory, 'preview.yml'));
  await mcp.close();
  assert.equal(await (await fetch(ready.result.url!)).text(), 'project preview');
  await client.stop('site');
  const fromFile = JSON.parse((await execute(process.execPath, [cli, 'start', '--project', directory])).stdout);
  assert.equal(fromFile.state, 'ready');
  assert.equal((await client.info())?.pid, info!.pid);
  await writeFile(join(directory, 'preview.yaml'), 'invalid: yaml\n');
  const invalid = await execute(process.execPath, [cli, 'replace', '--project', directory]).catch(error => error);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_INPUT');
  assert.equal((await client.get('site')).active!.id, fromFile.id);
  const alternative = join(directory, 'alternate.yml');
  await writeFile(alternative, 'name: alternate\ntype: static\ndirectory: .\n');
  assert.equal(JSON.parse((await execute(process.execPath, [cli, 'start', '--project', directory, '--file', alternative])).stdout).state, 'ready');
  await client.shutdown();
  await assert.rejects(client.secretsStatus('00000000-0000-4000-8000-000000000000'), { code: 'DAEMON_UNAVAILABLE' });
  const restarted = await client.start(spec);
  assert.equal((await client.wait('site', restarted.candidate!.id)).state, 'ready');
  assert.equal((await client.info())?.allowExec, false);
  assert.notEqual((await client.info())?.pid, info!.pid);
  assert.equal(stderr, '');
});

test('real Git worktrees and an unrelated project share exact keystore names with separate private approvals and distinct overrides', enabled, async t => {
  const { directory, projects } = await fixture(t);
  const keystore = await testKeystore(t);
  const capture = join(keystore.directory, 'private-urls');
  const hook = join(keystore.directory, 'preload.mjs');
  const dataDirectory = join(keystore.directory, 'data');
  await writeFile(hook, keystore.installSource.replaceAll('/.local/test-build/', '/dist/') + `
    import {SecretSetup} from ${JSON.stringify(new URL('../../dist/secrets-setup.js', import.meta.url).href)};
    import {appendFile} from 'node:fs/promises';
    SecretSetup.prototype.openBrowser = async url => { await appendFile(${JSON.stringify(capture)}, url + '\\n', {mode: 0o600}); };
  `, { mode: 0o600 });
  const shared = `disposable/worktrees/${basename(directory)}`;
  const distinct = `${shared}/variant`;
  await keystore.store.add('user', shared, 'FAKE_SHARED');
  const yaml = (id: string) => `name: tree\ntype: command\ncwd: .\ncommand: [${JSON.stringify(process.execPath)}, app.mjs]\nenv:\n  TOKEN: {secret: ${id}}\n`;
  await writeFile(join(directory, 'app.mjs'), `import http from 'node:http'; http.createServer((req,res) => res.end(process.env.TOKEN)).listen(Number(process.env.PORT), process.env.HOST);`);
  await writeFile(join(directory, 'preview.yaml'), yaml(shared));
  await execute('git', ['init', directory]);
  await execute('git', ['-C', directory, 'add', 'app.mjs', 'preview.yaml']);
  await execute('git', ['-C', directory, '-c', 'user.name=Previewhost Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'disposable fixture']);
  const worktree = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-linked-tree-')));
  const unrelated = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-unrelated-')));
  projects.push(worktree, unrelated);
  await execute('git', ['-C', directory, 'worktree', 'add', '--detach', worktree]);
  await copyFile(join(directory, 'app.mjs'), join(unrelated, 'app.mjs'));
  await writeFile(join(unrelated, 'preview.yaml'), yaml(shared));
  const adapters: Client[] = [];
  const wire: string[] = [];
  async function adapter(root: string) {
    const mcp = new Client({ name: 'worktree-secret-test', version: '1' }); adapters.push(mcp);
    await mcp.connect(new StdioClientTransport({ command: process.execPath,
      args: [cli, 'mcp', '--project', root, '--allow-exec', ...(root === directory ? ['--data-dir', dataDirectory] : [])],
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` } as Record<string, string>, stderr: 'pipe' }));
    return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const response = await mcp.callTool({ name, arguments: args }); wire.push(JSON.stringify(response));
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      return (response.structuredContent as { result: T }).result;
    };
  }
  const capabilities: string[] = [];
  async function privateCall(operation: string, body: unknown = {}) {
    const url = new URL((await readFile(capture, 'utf8')).trim().split('\n').at(-1)!);
    const capability = url.hash.slice(1); capabilities.push(capability);
    const response = await fetch(`${url.origin}/secrets/${operation}`, { method: 'POST',
      headers: { origin: url.origin, authorization: `Bearer ${capability}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return (await response.json() as { result: SecretSetupStatus }).result;
  }
  try {
    const calls = [];
    for (const root of projects) {
      const call = await adapter(root); calls.push(call);
      const setup = await call<SecretSetupStatus>('preview_secrets_setup', { file: 'preview.yaml' });
      assert.equal(setup.requirements[0].selected, false);
      const approved = await privateCall('approve');
      assert.equal(approved.state, 'complete'); assert.deepEqual(approved.alreadyPresent, [shared]);
      const started = await call<PreviewStatus>('preview_start', { file: 'preview.yaml' });
      const ready = await call<AttemptResult>('preview_wait', { name: 'tree', attemptId: started.candidate!.id });
      assert.equal(ready.state, 'ready'); assert.equal(await (await fetch(ready.url!)).text(), 'FAKE_SHARED');
      if (root === directory) {
        const owner = connectProject({ projectDirectory: root });
        try { assert.equal((await owner.info())?.dataDirectory, dataDirectory); }
        finally { await owner.close(); }
        const conflict = await execute(process.execPath, [cli, 'start', '--project', worktree, '--allow-exec', '--data-dir', dataDirectory,
          '--file', join(worktree, 'preview.yaml')], { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` } }).catch(error => error);
        assert.equal(JSON.parse(conflict.stderr).error.code, 'BUSY');
      }
    }
    const call = calls[1];
    await delay(1001); // Existing browser-opening cooldown.
    await writeFile(join(worktree, 'preview.yaml'), yaml(distinct));
    const variant = await call<SecretSetupStatus>('preview_secrets_setup', { file: 'preview.yaml' });
    assert.equal(variant.state, 'pending');
    assert.deepEqual((await privateCall('approve')).remaining, [distinct]);
    assert.equal((await privateCall('save', { values: { [distinct]: 'FAKE_VARIANT' } })).state, 'complete');
    const replaced = await call<PreviewStatus>('preview_replace', { name: 'tree', file: 'preview.yaml' });
    const ready = await call<AttemptResult>('preview_wait', { name: 'tree', attemptId: replaced.candidate!.id });
    assert.equal(await (await fetch(ready.url!)).text(), 'FAKE_VARIANT');
    assert.equal(await keystore.store.get('user', shared), 'FAKE_SHARED');
    await writeFile(join(worktree, 'preview.yaml'), yaml(`${shared}/edited`));
    const edited = await call<PreviewStatus>('preview_replace', { name: 'tree', file: 'preview.yaml' });
    const denied = await call<AttemptResult>('preview_wait', { name: 'tree', attemptId: edited.candidate!.id });
    assert.equal(denied.error?.code, 'SECRET_DENIED');
    assert.equal(await (await fetch(ready.url!)).text(), 'FAKE_VARIANT');
    await adapters[1].close();
    const resumed = await adapter(worktree);
    assert.equal((await resumed<SecretSetupStatus>('preview_secrets_status', { id: variant.id })).state, 'complete');
    await calls[0]('preview_shutdown');
    const restarted = await calls[0]<SecretSetupStatus>('preview_secrets_setup', { file: 'preview.yaml' });
    assert.equal(restarted.requirements[0].selected, false);
    assert.deepEqual((await privateCall('approve')).alreadyPresent, [shared]);
    assert.ok(!wire.join('\n').includes('FAKE_'));
    assert.ok(capabilities.every(capability => !wire.join('\n').includes(capability)));
  } finally {
    await Promise.all(adapters.map(mcp => mcp.close()));
    for (const root of projects) {
      const owner = connectProject({ projectDirectory: root });
      try { await owner.shutdown(); }
      catch (error) { if ((error as { code?: string }).code !== 'DAEMON_UNAVAILABLE') throw error; }
      finally { await owner.close(); }
    }
  }
});

test('concurrent first CLI callers have one owner; launch mismatches preserve it; crashes block blind restart', enabled, async t => {
  const { directory, client } = await fixture(t);
  const file = join(directory, 'preview.yaml'); await writeFile(file, 'name: site\ntype: static\ndirectory: .\n');
  const callers = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    const file = join(directory, `site-${i}.json`);
    await writeFile(file, JSON.stringify({ name: `site-${i}`, type: 'static', directory }));
    return execute(process.execPath, [cli, 'start', '--project', directory, '--allow-exec', '--file', file]);
  }));
  assert.ok(callers.every(result => JSON.parse(result.stdout).state === 'ready'));
  assert.equal((await client.list()).length, 6);
  const owner = (await client.info())!;
  const mismatch = connectProject({ projectDirectory: directory, allowedRoots: [await realpath(tmpdir())] });
  try { await assert.rejects(mismatch.start({ name: 'other', type: 'static', directory }), { code: 'INVALID_INPUT' }); }
  finally { await mismatch.close(); }
  assert.equal((await client.info())?.pid, owner.pid);
  process.kill(owner.pid, 'SIGKILL');
  await delay(100);
  await assert.rejects(client.start({ name: 'site', type: 'static', directory }), { code: 'CLEANUP_INCOMPLETE' });
  // This disposable owner ran in-process static servers only. No child/data cleanup is outstanding.
  await rm(join(projectOwnerDirectory(directory), 'connection.json'));
  const restarted = await client.start({ name: 'site', type: 'static', directory });
  assert.equal((await client.wait('site', restarted.candidate!.id)).state, 'ready');
  assert.notEqual((await client.info())?.pid, owner.pid);
});

test('Git worktree roots are distinct and command wait timeout preserves continuing startup', enabled, async t => {
  const { directory, client, projects } = await fixture(t);
  await execute('git', ['init', directory]);
  await execute('git', ['-C', directory, '-c', 'user.name=Previewhost Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const worktree = join(directory, 'worktree');
  await execute('git', ['-C', directory, 'worktree', 'add', '--detach', worktree]);
  const nested = join(worktree, 'nested'); await mkdir(nested);
  const other = connectProject({ projectDirectory: worktree });
  projects.push(worktree);
  t.after(() => other.close());
  await writeFile(join(worktree, 'preview.yaml'), 'name: tree\ntype: static\ndirectory: .\n');
  const fromNested = JSON.parse((await execute(process.execPath, [cli, 'start'], { cwd: nested })).stdout);
  assert.equal(fromNested.state, 'ready');
  assert.equal((await other.info())?.projectDirectory, worktree);
  await assert.rejects(client.list(), { code: 'DAEMON_UNAVAILABLE' });
  await writeFile(join(directory, 'app.mjs'), `import http from 'node:http'; setTimeout(() => http.createServer((req,res) => res.end('ready')).listen(Number(process.env.PORT), process.env.HOST), 500);`);
  const file = join(directory, 'slow.json');
  await writeFile(file, JSON.stringify({ name: 'slow', type: 'command', cwd: '.', command: [process.execPath, 'app.mjs'] }));
  const starting = JSON.parse((await execute(process.execPath, [cli, 'start', '--project', directory, '--allow-exec', '--file', file, '--timeout-ms', '1'])).stdout);
  assert.equal(starting.state, 'starting');
  const ready = await client.wait('slow', starting.id);
  assert.equal(ready.state, 'ready'); assert.equal(await (await fetch(ready.url!)).text(), 'ready');
});

test('one shared MCP connection routes Git worktrees to separate owners and managed data', {
  ...enabled, skip: !process.env.PREVIEWHOST_TEST_DOCKER_SOCKET && 'Requires PREVIEWHOST_TEST_DOCKER_SOCKET',
}, async t => {
  const { directory, projects } = await fixture(t);
  const keystore = await testKeystore(t);
  const hook = join(keystore.directory, 'preload.mjs');
  await writeFile(hook, keystore.installSource.replaceAll('/.local/test-build/', '/dist/'));
  await writeFile(join(directory, 'preview.yaml'), 'name: notes\ntype: environment\nprimary: web\nservices:\n  web: {type: static, directory: .}\n  db: {type: postgres}\n');
  await execute('git', ['init', directory]);
  await execute('git', ['-C', directory, 'add', '.']);
  await execute('git', ['-C', directory, '-c', 'user.name=Previewhost Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  const worktree = await realpath(await mkdtemp(join(tmpdir(), 'previewhost-mcp-worktree-')));
  projects.push(worktree);
  await execute('git', ['-C', directory, 'worktree', 'add', '--detach', worktree]);
  await writeFile(join(worktree, 'index.html'), 'other worktree');
  const removed = join(directory, 'removed-worktree');
  await execute('git', ['-C', directory, 'worktree', 'add', '--detach', removed]);
  await rm(removed, { recursive: true }); // An unrelated stale Git entry must not deny the living checkout.
  const client = new Client({ name: 'worktree-launch', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [cli, 'mcp', '--root', directory, '--allow-exec', '--docker-socket', process.env.PREVIEWHOST_TEST_DOCKER_SOCKET!],
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` } as Record<string, string>, stderr: 'pipe' }));
  const tools = (await client.listTools()).tools;
  assert.ok(tools.every(tool => tool.inputSchema.required?.includes('project')));
  assert.equal((await client.callTool({ name: 'preview_list', arguments: {} })).isError, true);
  function adapter(project: string) {
    return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const response = await client.callTool({ name, arguments: { ...args, project } });
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      return (response.structuredContent as { result: T }).result;
    };
  }
  const first = adapter(directory); const second = adapter(worktree);
  const ready = await Promise.all([first, second].map(async call => {
    const started = await call<PreviewStatus>('preview_start');
    return call<AttemptResult>('preview_wait', { name: 'notes', attemptId: started.candidate!.id });
  }));
  for (const [i, project] of projects.entries()) {
    assert.equal(ready[i].state, 'ready');
    assert.equal(ready[i].services?.db.state, 'ready');
    assert.deepEqual(ready[i].sources, [project]);
    const owner = connectProject({ projectDirectory: project });
    try { assert.equal((await owner.info())?.dataDirectory, join(projectOwnerDirectory(project), 'data')); }
    finally { await owner.close(); }
  }
  assert.notEqual(ready[0].url, ready[1].url);
  const wrongAttempt = await client.callTool({ name: 'preview_wait', arguments: { project: worktree, name: 'notes', attemptId: ready[0].id } });
  assert.equal((wrongAttempt.structuredContent as { error: { code: string } }).error.code, 'ATTEMPT_EXPIRED');
  assert.equal(await (await fetch(ready[0].url!)).text(), 'project preview');
  assert.equal(await (await fetch(ready[1].url!)).text(), 'other worktree');
  const denied = await client.callTool({ name: 'preview_inspect', arguments: { project: worktree, spec: { name: 'escape', type: 'static', directory: resolve('src') } } });
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'SOURCE_DENIED');
  const unrelated = await client.callTool({ name: 'preview_list', arguments: { project: resolve('.') } });
  assert.equal((unrelated.structuredContent as { error: { code: string } }).error.code, 'SOURCE_DENIED');
  await first('preview_stop', { name: 'notes' });
  await assert.rejects(fetch(ready[0].url!));
  assert.equal((await second<PreviewStatus>('preview_get', { name: 'notes' })).active!.id, ready[1].id);
  assert.equal(await (await fetch(ready[1].url!)).text(), 'other worktree');
  const restarted = await first<PreviewStatus>('preview_start');
  assert.equal((await first<AttemptResult>('preview_wait', { name: 'notes', attemptId: restarted.candidate!.id })).state, 'ready');
});

for (const customData of [false, true]) test(`automatic storage keeps explicit options and static previews usable without Docker (custom data: ${customData})`, enabled, async t => {
  const { directory, client } = await fixture(t);
  const dataDirectory = customData ? join(projectOwnerDirectory(directory), 'custom-data') : undefined;
  const dockerSocket = process.platform === 'win32' ? `\\\\.\\pipe\\previewhost-absent-${randomUUID()}` : join(directory, 'absent.sock');
  const owner = connectProject({ projectDirectory: directory, allowExec: true, dataDirectory, dockerSocket });
  t.after(() => owner.close());
  const site: PreviewSpec = { name: 'site', type: 'environment', primary: 'web', services: { web: { type: 'static', directory } } };
  const started = await owner.start(site);
  const ready = await owner.wait('site', started.candidate!.id);
  assert.equal(ready.state, 'ready');
  const info = (await owner.info())!;
  assert.equal(info.dataDirectory, dataDirectory ?? join(projectOwnerDirectory(directory), 'data'));
  assert.equal(info.dockerSocket, dockerSocket);
  assert.equal((await client.info())?.pid, info.pid, 'omitted launch options must reuse the existing owner');
  for (const override of [{ dataDirectory: join(directory, 'different') }, { dockerSocket: `${dockerSocket}-other` }]) {
    const mismatch = connectProject({ projectDirectory: directory, ...override });
    try { await assert.rejects(mismatch.start(site), { code: 'INVALID_INPUT' }); }
    finally { await mismatch.close(); }
  }
  const update = await owner.replace('site', { name: 'site', type: 'environment', primary: 'web',
    services: { web: { type: 'static', directory }, db: { type: 'postgres' } } });
  const failed = await owner.wait('site', update.candidate!.id);
  assert.equal(failed.error?.code, process.platform === 'win32' ? 'CLEANUP_INCOMPLETE' : 'START_FAILED');
  assert.match(failed.error!.message, process.platform === 'win32' ? /Docker pipe open/ : /Docker socket is unavailable/);
  assert.equal(await (await fetch(ready.url!)).text(), 'project preview');
  assert.deepEqual(await owner.info(), info, 'failed updates and conflicting options must not reconfigure or restart the owner');
  assert.equal((await client.get('site')).active?.id, ready.id);
});

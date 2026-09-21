import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { AttemptResult, PreviewSpec, PreviewStatus, SecretSetupStatus } from './contracts.js';
import { testKeychain } from './testSupport/keychain.js';

const execute = promisify(execFile);
const dockerSocket = process.env.PREVIEWD_TEST_DOCKER_SOCKET;

test('global MCP defaults support private setup, isolated worktree databases and owner restart without launch overrides', {
  skip: process.platform !== 'darwin' || !dockerSocket, timeout: 120_000,
}, async t => {
  const keychain = await testKeychain(t);
  // Give the child a disposable home with the documented default socket, including on Colima CI.
  const home = join(keychain.directory, 'home');
  await mkdir(join(home, '.docker/run'), { recursive: true });
  await symlink(await realpath(dockerSocket!), join(home, '.docker/run/docker.sock'));
  const capture = join(keychain.directory, 'private-url');
  const hook = join(keychain.directory, 'preload.mjs');
  await writeFile(hook, keychain.installSource.replace('/.local/test-build/keychain.js', '/dist/keychain.js') + `
    import {SecretSetup} from ${JSON.stringify(new URL('../../dist/secrets-setup.js', import.meta.url).href)};
    import {writeFile} from 'node:fs/promises';
    SecretSetup.prototype.openBrowser = async url => { await writeFile(${JSON.stringify(capture)}, url, {mode: 0o600}); };
  `, { mode: 0o600 });
  const source = join(keychain.directory, 'source');
  const worktree = join(keychain.directory, 'worktree');
  await mkdir(source);
  const api = `
    import http from 'node:http';
    import {Client} from ${JSON.stringify(import.meta.resolve('pg'))};
    if (!process.env.API_SECRET) throw new Error('Missing test secret');
    const db = new Client({connectionString: process.env.DATABASE_URL}); await db.connect();
    await db.query('CREATE TABLE IF NOT EXISTS counter (id integer PRIMARY KEY, value integer NOT NULL)');
    await db.query('INSERT INTO counter VALUES (1, 0) ON CONFLICT DO NOTHING');
    http.createServer(async (req,res) => {
      try {
        if (req.method === 'POST') await db.query('UPDATE counter SET value = value + 1 WHERE id = 1');
        res.end(JSON.stringify({count: (await db.query('SELECT value FROM counter WHERE id = 1')).rows[0].value}));
      } catch { res.writeHead(500); res.end(); }
    }).listen(Number(process.env.PORT), process.env.HOST);
  `;
  await writeFile(join(source, 'api.mjs'), api);
  await writeFile(join(source, 'web.mjs'), `
    import http from 'node:http';
    http.createServer(async (req,res) => {
      try { const result = await fetch(process.env.API_URL, {method: req.method}); res.end(await result.text()); }
      catch { res.writeHead(502); res.end(); }
    }).listen(Number(process.env.PORT), process.env.HOST);
  `);
  await execute('git', ['init', source]);
  await execute('git', ['-C', source, 'add', '.']);
  await execute('git', ['-C', source, '-c', 'user.name=Previewhost Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  await execute('git', ['-C', source, 'worktree', 'add', '--detach', worktree]);
  const projects = await Promise.all([source, worktree].map(path => realpath(path)));
  const reference = 'disposable/default-data/api';
  const spec = (project: string): PreviewSpec => ({ name: 'notes', type: 'environment', primary: 'web', services: {
    db: { type: 'postgres' },
    api: { type: 'command', cwd: project, command: [process.execPath, 'api.mjs'],
      env: { DATABASE_URL: { service: 'db' }, API_SECRET: { secret: reference } } },
    web: { type: 'command', cwd: project, command: [process.execPath, 'web.mjs'], env: { API_URL: { service: 'api' } } },
  } });
  const client = new Client({ name: 'default-database-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { allow: true } }));
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', '--allow-exec'], stderr: 'pipe',
    env: { ...process.env, HOME: home, NODE_OPTIONS: `--import=${hook}` } as Record<string, string> }));
  async function call<T>(name: string, project: string, args: Record<string, unknown> = {}): Promise<T> {
    for (;;) {
      const signal = name === 'preview_wait' ? t.signal : undefined;
      signal?.throwIfAborted();
      const response = await client.callTool({ name, arguments: { project, ...args } }, { signal });
      // A wait budget expiring is not a failed attempt. Observe the same attempt; never repeat startup.
      if (name === 'preview_wait' && response.isError && (response.structuredContent as { error: { code: string } }).error.code === 'TIMEOUT') continue;
      assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
      return (response.structuredContent as { result: T }).result;
    }
  }
  async function privateCall(operation: string, body: unknown = {}) {
    const url = new URL(await readFile(capture, 'utf8'));
    const response = await fetch(`${url.origin}/secrets/${operation}`, { method: 'POST',
      headers: { origin: url.origin, authorization: `Bearer ${url.hash.slice(1)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return (await response.json() as { result: SecretSetupStatus }).result;
  }
  async function start(project: string, args: Record<string, unknown>) {
    const started = await call<PreviewStatus>('preview_start', project, args);
    const ready = await call<AttemptResult>('preview_wait', project, { name: 'notes', attemptId: started.candidate!.id });
    assert.equal(ready.state, 'ready', JSON.stringify(ready.error));
    assert.equal(ready.services?.db.state, 'ready');
    return ready;
  }
  const count = async (url: string, method = 'GET') => (await (await fetch(url, { method })).json() as { count: number }).count;
  const approvedProjects: string[] = [];
  try {
    for (const [index, project] of projects.entries()) {
      await call('preview_access', project);
      approvedProjects.push(project);
      const setup = await call<SecretSetupStatus>('preview_secrets_setup', project, { spec: spec(project) });
      assert.equal(setup.state, 'pending');
      const approved = await privateCall('approve');
      if (index === 0) {
        assert.deepEqual(approved.remaining, [reference]);
        assert.equal((await privateCall('save', { values: { [reference]: 'FAKE_DEFAULT_DATA_SECRET' } })).state, 'complete');
      } else {
        assert.equal(approved.state, 'complete');
        assert.deepEqual(approved.alreadyPresent, [reference]);
      }
    }
    await unlink(join(home, '.docker/run/docker.sock'));
    const unavailable = await call<PreviewStatus>('preview_start', projects[0], { spec: spec(projects[0]) });
    const failed = await call<AttemptResult>('preview_wait', projects[0], { name: 'notes', attemptId: unavailable.candidate!.id });
    assert.equal(failed.error?.code, 'START_FAILED');
    assert.match(failed.error!.message, /Docker socket is unavailable/);
    await symlink(await realpath(dockerSocket!), join(home, '.docker/run/docker.sock'));
    await call('preview_save_config', projects[1], { spec: spec(projects[1]) });
    const [first, second] = await Promise.all([start(projects[0], { spec: spec(projects[0]) }), start(projects[1], {})]);
    assert.notEqual(first.url, second.url);
    assert.deepEqual(await Promise.all([first.url!, second.url!].map(url => count(url))), [0, 0]);
    assert.equal(await count(first.url!, 'POST'), 1);
    assert.equal(await count(second.url!), 0);
    await writeFile(join(projects[0], 'web.mjs'), (await readFile(join(projects[0], 'web.mjs'), 'utf8'))
      .replace('res.end(await result.text())', "res.end(JSON.stringify({...await result.json(), updated: true}))"));
    const update = await call<PreviewStatus>('preview_replace', projects[0], { name: 'notes', spec: spec(projects[0]) });
    const updated = await call<AttemptResult>('preview_wait', projects[0], { name: 'notes', attemptId: update.candidate!.id });
    assert.equal(updated.state, 'ready');
    assert.deepEqual(await (await fetch(updated.url!)).json(), { count: 1, updated: true });
    assert.deepEqual(await (await fetch(second.url!)).json(), { count: 0 });
    const owners = await readdir(join(home, '.local/share/previewd/projects'));
    assert.equal(owners.length, 2);
    const records = await Promise.all(owners.map(id => readFile(join(home, '.local/share/previewd/projects', id, 'data/notes.json'), 'utf8')));
    assert.notEqual(JSON.parse(records[0]).resources[0].volume, JSON.parse(records[1]).resources[0].volume);
    await assert.rejects(readFile(join(projects[0], 'preview.yaml')), { code: 'ENOENT' });
    await call('preview_stop', projects[0], { name: 'notes' });
    assert.equal(await count(second.url!, 'POST'), 1);
    const restarted = await start(projects[0], { spec: spec(projects[0]) });
    assert.equal(await count(restarted.url!), 1);
    await call('preview_shutdown', projects[0]);
    assert.equal(await count(second.url!), 1);
    const denied = await call<PreviewStatus>('preview_start', projects[0], { spec: spec(projects[0]) });
    const result = await call<AttemptResult>('preview_wait', projects[0], { name: 'notes', attemptId: denied.candidate!.id });
    assert.equal(result.error?.code, 'SECRET_DENIED');
    await call('preview_secrets_setup', projects[0], { spec: spec(projects[0]) });
    assert.deepEqual((await privateCall('approve')).alreadyPresent, [reference]);
    assert.equal(await count((await start(projects[0], { spec: spec(projects[0]) })).url!), 1);
  } finally {
    try {
      for (const project of approvedProjects) {
        await call('preview_stop', project, { name: 'notes' }).catch(() => {});
        // Only delete data when a retained record exists; a failed initial setup has none.
        const status = await call<PreviewStatus>('preview_get', project, { name: 'notes' }).catch(() => undefined);
        if (status?.data) await call('preview_delete_data', project, { name: 'notes' });
        await call('preview_shutdown', project);
      }
    } finally { await client.close(); }
  }
});

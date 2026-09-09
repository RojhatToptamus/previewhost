import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectPreviewDaemon } from './client.js';
import { createPreviewRuntime } from './runtime.js';
import { startDaemon } from './daemon.js';
import { keychain } from './keychain.js';
import { setSecret, removeSecret } from './secrets.js';
import { SecretSetup } from './secrets-setup.js';
import { PreviewError } from './errors.js';
import { testKeychain } from './testSupport/keychain.js';
import type { AttemptResult, PreviewSpec, PreviewStatus, SecretSetupStatus } from './contracts.js';

const enabled = { skip: process.platform !== 'darwin', timeout: 60_000 };
const app = `import http from 'node:http'; import fs from 'node:fs'; fs.writeFileSync('started','yes');
  console.log(process.env.ONE,process.env.TWO);
  http.createServer((req,res)=>res.end(process.env.ONE+'|'+process.env.TWO)).listen(Number(process.env.PORT),process.env.HOST);`;

async function browserCall(origin: string, capability: string, operation: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/secrets/${operation}`, { method: 'POST',
    headers: { authorization: `Bearer ${capability}`, origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as { result?: SecretSetupStatus; error?: { code: string } } };
}

test('MCP missing → private save → status → ordinary retry keeps values and write permission off the public transport', enabled, async (t) => {
  const fixture = await testKeychain(t);
  await writeFile(join(fixture.directory, 'app.mjs'), app);
  const opened: string[] = [];
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { opened.push(url); });
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['shared', 'new'], authorize: () => true });
  const tokenFile = join(fixture.directory, 'control', 'token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  const mcp = new Client({ name: 'previewhost-secrets-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', '--endpoint', daemon.endpoint, '--token-file', tokenFile], stderr: 'pipe' });
  let stderr = ''; const wire: string[] = [];
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  const spec: PreviewSpec = { name: 'private-flow', type: 'command', cwd: fixture.directory, command: [process.execPath, 'app.mjs'],
    env: { ONE: { secret: 'shared' }, TWO: { secret: 'new' } } };
  try {
    await mcp.connect(transport);
    const receive = transport.onmessage!;
    transport.onmessage = (...args) => { wire.push(JSON.stringify(args[0])); receive(...args); };
    const missingStart = (await mcp.callTool({ name: 'preview_start', arguments: { spec } })).structuredContent as { result: PreviewStatus };
    const missing = (await mcp.callTool({ name: 'preview_wait', arguments: { name: spec.name, attemptId: missingStart.result.candidate!.id } })).structuredContent as { result: AttemptResult };
    assert.equal(missing.result.error?.code, 'SECRET_REQUIRED');
    assert.deepEqual(missing.result.error?.requirements?.map((item) => item.id), ['new', 'shared']);
    const setup = (await mcp.callTool({ name: 'preview_secrets_setup', arguments: { spec } })).structuredContent as { result: SecretSetupStatus };
    assert.equal(setup.result.state, 'pending');
    assert.equal(opened.length, 1);
    assert.equal(new URL(opened[0]).origin, daemon.endpoint);
    const capability = new URL(opened[0]).hash.slice(1);
    assert.equal(capability.length, 64);
    const shell = await fetch(`${daemon.endpoint}/secrets`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(shell.headers.get('cache-control'), 'no-store');
    assert.ok(!(await shell.text()).includes(capability));
    assert.equal((await browserCall(daemon.endpoint, setup.result.id, 'form')).status, 401);
    const form = await browserCall(daemon.endpoint, capability, 'form');
    assert.equal(form.data.result?.name, spec.name);
    assert.deepEqual(form.data.result?.requirements.find((item) => item.id === 'shared')?.bindings, [{ key: 'ONE' }]);
    for (const origin of ['null', 'http://127.0.0.1:1', 'http://evil.example']) {
      assert.equal((await browserCall(daemon.endpoint, capability, 'save', { values: { shared: 'FAKE_bad', new: 'FAKE_bad' } }, { origin })).status, 401);
    }
    assert.equal((await browserCall(daemon.endpoint, capability, 'save', { values: { shared: 'FAKE_missing-field' } })).status, 400);
    assert.equal((await browserCall(daemon.endpoint, capability, 'save', { values: { shared: '\ud800', new: 'FAKE_new' } })).status, 400);
    await setSecret('shared', 'FAKE_owner_wins');
    const saved = await browserCall(daemon.endpoint, capability, 'save', { values: { shared: 'FAKE_stale_form', new: 'FAKE_new' } });
    assert.equal(saved.data.result?.state, 'complete');
    assert.deepEqual(saved.data.result?.alreadyPresent, ['shared']);
    assert.deepEqual(saved.data.result?.saved, ['new']);
    assert.equal(await fixture.store.get('user', 'shared'), 'FAKE_owner_wins');
    await assert.rejects(readFile(join(fixture.directory, 'started')), { code: 'ENOENT' });
    assert.equal((await browserCall(daemon.endpoint, capability, 'save', { values: { shared: 'FAKE_replay', new: 'FAKE_replay' } })).status, 401);
    const status = (await mcp.callTool({ name: 'preview_secrets_status', arguments: { id: setup.result.id } })).structuredContent as { result: SecretSetupStatus };
    assert.equal(status.result.state, 'complete');
    const retry = (await mcp.callTool({ name: 'preview_start', arguments: { spec } })).structuredContent as { result: PreviewStatus };
    const ready = await client.wait(spec.name, retry.result.candidate!.id);
    assert.equal(ready.state, 'ready');
    assert.equal(await (await fetch(ready.url!)).text(), 'FAKE_owner_wins|FAKE_new');
    await mcp.callTool({ name: 'preview_logs', arguments: { name: spec.name } });
    assert.ok(!wire.join('\n').includes('FAKE_'));
    assert.ok(!wire.join('\n').includes(capability));
    assert.equal(stderr, '');
  } finally { await mcp.close(); await client.close(); await daemon.close(); }
});

test('setup rechecks CLI input, edit never recreates a deleted entry, and partial writes retain accurate results', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const opened: string[] = [];
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { opened.push(url); });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['one', 'two'], authorize: () => true });
  const setup = new SecretSetup(runtime, 'http://127.0.0.1:9999');
  const spec: PreviewSpec = { name: 'form', type: 'command', cwd: fixture.directory, command: ['false'], env: { ONE: { secret: 'one' }, TWO: { secret: 'two' } } };
  const signal = new AbortController().signal;
  const authorization = () => `Bearer ${new URL(opened.at(-1)!).hash.slice(1)}`;
  try {
    const first = await setup.setup(spec, signal);
    assert.equal((await setup.setup(spec, signal)).id, first.id);
    assert.equal(opened.length, 1);
    await setSecret('one', 'FAKE_cli_one'); await setSecret('two', 'FAKE_cli_two');
    const rechecked = await setup.setup(spec, signal);
    assert.equal(rechecked.state, 'complete');
    assert.equal(setup.status(first.id).state, 'canceled');
    assert.throws(() => setup.form(authorization()), { code: 'UNAUTHORIZED' });
    now += 1001;
    const edit = await setup.setup('one', signal);
    await removeSecret('one');
    const missingEdit = await setup.save(authorization(), { values: { one: 'FAKE_edit' } });
    assert.equal(missingEdit.state, 'partial');
    assert.equal(missingEdit.error?.code, 'SECRET_REQUIRED');
    assert.equal(await fixture.store.has('user', 'one'), false);
    assert.equal(setup.status(edit.id).state, 'partial');
    await removeSecret('two'); now += 1001;
    const partial = await setup.setup(spec, signal);
    const add = keychain.add.bind(keychain);
    t.mock.method(keychain, 'add', async (...args: Parameters<typeof add>) => {
      if (args[1] === 'two') throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'A dispatched write has an unknown result.', { outcome: 'unknown' });
      return add(...args);
    });
    const saving = await setup.save(authorization(), { values: { one: 'FAKE_saved', two: 'FAKE_unknown' } });
    assert.deepEqual(saving.saved, ['one']);
    assert.deepEqual(saving.remaining, ['two']);
    assert.equal(saving.error?.outcome, 'unknown');
    assert.equal(setup.status(partial.id).state, 'partial');
    assert.equal(await fixture.store.get('user', 'one'), 'FAKE_saved');
    await assert.rejects(setup.save(authorization(), { values: { one: 'FAKE_replay', two: 'FAKE_replay' } }), { code: 'UNAUTHORIZED' });
  } finally { await setup.close(); await runtime.close(); }
});

test('private form routes reject duplicate authority headers and control bearers cannot save', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const opened: string[] = [];
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { opened.push(url); });
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['one'], authorize: () => true });
  const tokenFile = join(fixture.directory, 'control', 'token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  try {
    await client.secretsSetup({ name: 'form', type: 'command', cwd: fixture.directory, command: ['false'], env: { ONE: { secret: 'one' } } });
    const capability = new URL(opened[0]).hash.slice(1);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    assert.equal((await browserCall(daemon.endpoint, token, 'save', { values: { one: 'FAKE_control' } })).status, 401);
    const headers = { host: new URL(daemon.endpoint).host, origin: daemon.endpoint, authorization: `Bearer ${capability}`, 'content-type': 'application/json' };
    for (const duplicated of ['host', 'origin', 'authorization', 'content-type']) {
      const raw = [...Object.entries(headers).flat(), duplicated, headers[duplicated as keyof typeof headers]];
      const status = await new Promise<number>((resolveStatus, reject) => {
        const req = request(`${daemon.endpoint}/secrets/save`, { method: 'POST', headers: raw }, (res) => {
          res.resume(); res.once('end', () => resolveStatus(res.statusCode!));
        });
        req.once('error', reject); req.end(JSON.stringify({ values: { one: 'FAKE_duplicate' } }));
      });
      assert.ok(status === 400 || status === 401);
    }
    for (const method of ['GET', 'OPTIONS']) {
      const response = await fetch(`${daemon.endpoint}/secrets/save`, { method, headers });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    assert.equal(await fixture.store.has('user', 'one'), false);
    assert.equal((await browserCall(daemon.endpoint, capability, 'cancel')).data.result?.state, 'canceled');
    assert.equal((await browserCall(daemon.endpoint, capability, 'form')).status, 401);
  } finally { await client.close(); await daemon.close(); }
});

test('browser launch passes only the private URL and normal OS environment, without ambient credential values', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory] });
  const setup = new SecretSetup(runtime, 'http://127.0.0.1:9999');
  const spawn = childProcess.spawn;
  const old = process.env.PREVIEWD_UNSELECTED_TEST;
  process.env.PREVIEWD_UNSELECTED_TEST = 'FAKE_do_not_inherit';
  const intercepted = t.mock.method(childProcess, 'spawn', ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, '/usr/bin/open');
    assert.deepEqual(args, ['http://127.0.0.1:9999/secrets#FAKE_private_capability']);
    assert.ok(!JSON.stringify(options).includes('FAKE_do_not_inherit'));
    assert.deepEqual(Object.keys(options.env!).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'].filter((key) => process.env[key] !== undefined).sort());
    return spawn(process.execPath, ['-e', 'process.exit(0)'], options);
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try { await setup.openBrowser('http://127.0.0.1:9999/secrets#FAKE_private_capability', new AbortController().signal); }
  finally {
    intercepted.mock.restore(); syncBuiltinESMExports();
    if (old === undefined) delete process.env.PREVIEWD_UNSELECTED_TEST; else process.env.PREVIEWD_UNSELECTED_TEST = old;
    await setup.close(); await runtime.close();
  }
});

test('setup authorization precedes Keychain access and shutdown joins pending preparation and saving', enabled, async (t) => {
  const fixture = await testKeychain(t);
  let allowed = false;
  const opened: string[] = [];
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { opened.push(url); });
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['one'], authorize: () => allowed });
  const setup = new SecretSetup(runtime, 'http://127.0.0.1:9999');
  const spec: PreviewSpec = { name: 'shutdown', type: 'command', cwd: fixture.directory, command: ['false'], env: { ONE: { secret: 'one' } } };
  const signal = new AbortController().signal;
  const has = t.mock.method(keychain, 'has', async () => false);
  let releaseSave = () => {};
  let releasePreparation = () => {};
  try {
    await assert.rejects(setup.setup(spec, signal), { code: 'EXECUTION_DENIED' });
    assert.equal(has.mock.callCount(), 0);
    allowed = true;
    await setup.setup(spec, signal);
    const authorization = `Bearer ${new URL(opened[0]).hash.slice(1)}`;
    let enterSave!: () => void;
    const saveEntered = new Promise<void>((resolve) => { enterSave = resolve; });
    const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve; });
    let saveSignal: AbortSignal | undefined;
    t.mock.method(keychain, 'add', async (_namespace: string, _id: string, _value: string, options: { signal: AbortSignal }) => {
      saveSignal = options.signal; enterSave(); await saveRelease;
      throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'The dispatched write has an unknown result.', { outcome: 'unknown' });
    });
    const save = setup.save(authorization, { values: { one: 'FAKE_shutdown' } });
    await saveEntered;
    let enterPreparation!: () => void;
    const prepareEntered = new Promise<void>((resolve) => { enterPreparation = resolve; });
    const prepareRelease = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let prepareSignal: AbortSignal | undefined;
    t.mock.method(keychain, 'has', async (_namespace: string, _id: string, options: { signal: AbortSignal }) => {
      prepareSignal = options.signal; enterPreparation(); await prepareRelease; return false;
    });
    const preparation = assert.rejects(setup.setup(spec, signal), { code: 'CLOSED' });
    await prepareEntered;
    let closed = false;
    const closing = setup.close().then(() => { closed = true; });
    assert.equal(saveSignal?.aborted, true);
    assert.equal(prepareSignal?.aborted, true);
    await Promise.resolve(); assert.equal(closed, false);
    releaseSave(); releasePreparation();
    const result = await save;
    await preparation; await closing;
    assert.equal(result.state, 'partial');
    assert.equal(result.error?.outcome, 'unknown');
    assert.equal(opened.length, 1);
    assert.throws(() => setup.form(authorization), { code: 'UNAUTHORIZED' });
    await assert.rejects(setup.setup(spec, signal), { code: 'CLOSED' });
  } finally { releaseSave(); releasePreparation(); await setup.close(); await runtime.close(); }
});

test('expired grants lose write permission and pending form capacity is recovered without background polling', enabled, async (t) => {
  const fixture = await testKeychain(t);
  const opened: string[] = [];
  t.mock.method(SecretSetup.prototype, 'openBrowser', async (url: string) => { opened.push(url); });
  let elapsed = 0;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + elapsed);
  t.mock.method(performance, 'now', () => elapsed);
  const runtime = await createPreviewRuntime({ allowedRoots: [fixture.directory], secretIds: ['one'], authorize: () => true });
  const setup = new SecretSetup(runtime, 'http://127.0.0.1:9999');
  const spec: PreviewSpec = { name: 'capacity', type: 'command', cwd: fixture.directory, command: ['false'], env: { ONE: { secret: 'one' } } };
  const signal = new AbortController().signal;
  try {
    const first = await setup.setup(spec, signal);
    const authorization = `Bearer ${new URL(opened[0]).hash.slice(1)}`;
    for (let i = 1; i < 8; i++) {
      elapsed += 1001;
      await setup.setup({ ...spec, name: `capacity-${i}` }, signal);
    }
    elapsed += 1001;
    await assert.rejects(setup.setup({ ...spec, name: 'capacity-overflow' }, signal), { code: 'BUSY' });
    assert.equal(opened.length, 8);
    elapsed = 301000;
    assert.equal(setup.status(first.id).state, 'expired');
    await assert.rejects(setup.save(authorization, { values: { one: 'FAKE_expired' } }), { code: 'UNAUTHORIZED' });
    assert.equal(await fixture.store.has('user', 'one'), false);
    assert.equal((await setup.setup(spec, signal)).state, 'pending');
    assert.equal(opened.length, 9);
  } finally { await setup.close(); await runtime.close(); }
});

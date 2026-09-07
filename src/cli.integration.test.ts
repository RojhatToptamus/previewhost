import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { promisify } from 'node:util';
import { connectPreviewDaemon } from './client.js';
import { startDaemon } from './daemon.js';
import { createPreviewRuntime } from './runtime.js';

const execute = promisify(execFile);
const cli = resolve('dist/cli.js');

test('CLI file and stdin workflows share the daemon, resolve paths once, and return useful failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd cli '));
  await mkdir(join(directory, 'site'));
  await writeFile(join(directory, 'site', 'index.html'), 'CLI preview');
  const file = join(directory, 'spec.json');
  await writeFile(file, JSON.stringify({ name: 'cli-site', type: 'static', directory: './site' }));
  const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
  const tokenFile = join(directory, 'private', 'token');
  const daemon = await startDaemon({ runtime, port: 0, tokenFile });
  const common = ['--endpoint', daemon.endpoint, '--token-file', tokenFile];
  t.after(async () => { await daemon.close(); await rm(directory, { recursive: true, force: true }); });
  const started = JSON.parse((await execute(process.execPath, [cli, 'start', '--file', file, ...common])).stdout);
  assert.equal(started.state, 'ready');
  assert.equal(await (await fetch(started.url)).text(), 'CLI preview');
  const status = JSON.parse((await execute(process.execPath, [cli, 'get', 'cli-site', ...common])).stdout);
  assert.equal(status.active.id, started.id);
  const input = spawn(process.execPath, [cli, 'inspect', '--file', '-', ...common], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  input.stdout.on('data', (chunk) => { stdout += chunk; });
  input.stderr.on('data', (chunk) => { stderr += chunk; });
  const ended = once(input, 'exit');
  input.stdin.end(JSON.stringify({ name: 'stdin-site', type: 'static', directory: 'site' }));
  assert.equal((await ended)[0], 0, stderr);
  assert.equal(JSON.parse(stdout).spec.directory, await realpath(join(directory, 'site')));
  const environmentFile = join(directory, 'environment.yaml');
  await mkdir(join(directory, 'api site'));
  await writeFile(join(directory, 'api site', 'index.html'), 'API preview');
  await writeFile(environmentFile, `name: cli-environment
type: environment
primary: web
services:
  web: {type: static, directory: ./site}
  api: {type: static, directory: './api site'}
`);
  const environment = JSON.parse((await execute(process.execPath, [cli, 'start', '--file', environmentFile, ...common])).stdout);
  assert.equal(environment.state, 'ready');
  assert.equal(environment.services.web.state, 'ready');
  assert.equal(environment.services.api.state, 'ready');
  assert.equal(await (await fetch(environment.url)).text(), 'CLI preview');
  assert.equal(new URL(environment.services.api.browserUrl).hostname, 'cli-environment--api.localhost');
  const stoppedEnvironment = JSON.parse((await execute(process.execPath, [cli, 'stop', 'cli-environment', ...common])).stdout);
  assert.equal(stoppedEnvironment.active, undefined);
  await assert.rejects(fetch(environment.url));
  const deniedFile = join(directory, 'denied.json');
  await writeFile(deniedFile, JSON.stringify({ name: 'denied', type: 'command', cwd: directory,
    command: [process.execPath, '-e', 'throw new Error("must not run")'], env: { PRIVATE_VALUE: 'do-not-display-this-secret' } }));
  const denied = await execute(process.execPath, [cli, 'start', '--file', deniedFile, ...common]).catch((error) => error);
  assert.equal(denied.code, 1);
  const deniedResult = JSON.parse(denied.stderr);
  assert.equal(deniedResult.error.code, 'EXECUTION_DENIED');
  assert.equal(typeof deniedResult.attemptId, 'string');
  assert.ok(!denied.stderr.includes('do-not-display-this-secret'));
  await execute(process.execPath, [cli, 'stop', 'cli-site', ...common]);
  await assert.rejects(fetch(started.url));
});

test('the foreground CLI owns its daemon and explicit shutdown ends it without a hidden child owner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd serve '));
  const tokenFile = join(directory, 'private', 'token');
  const secret = 'selected-owner-input-must-stay-private';
  const owner = spawn(process.execPath, [cli, 'serve', '--root', directory, '--env', 'PREVIEWD_SELECTED_INPUT', '--token-file', tokenFile, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PREVIEWD_SELECTED_INPUT: secret, PREVIEWD_UNSELECTED_INPUT: 'not-selected' },
  });
  const exit = once(owner, 'exit');
  let stderr = '';
  owner.stderr.on('data', (data) => { stderr += data; });
  t.after(async () => {
    if (owner.exitCode === null) { owner.kill('SIGTERM'); await exit; }
    await rm(directory, { recursive: true, force: true });
  });
  const lines = createInterface({ input: owner.stdout });
  const [line] = await once(lines, 'line');
  lines.close();
  const info = JSON.parse(line);
  assert.equal(info.execution, 'disabled');
  assert.deepEqual(info.inputKeys, ['PREVIEWD_SELECTED_INPUT']);
  assert.ok(!line.includes(secret));
  const client = connectPreviewDaemon({ endpoint: info.endpoint, tokenFile });
  t.after(() => client.close());
  assert.deepEqual(await client.list(), []);
  const environment = { name: 'inputs', type: 'environment' as const, primary: 'api', services: {
    api: { type: 'command' as const, cwd: directory, command: [process.execPath, '-e', 'process.exit(99)'],
      env: { TOKEN: { fromEnv: 'PREVIEWD_SELECTED_INPUT' } } },
  } };
  const description = await client.inspect(environment);
  assert.ok(!JSON.stringify(description).includes(secret));
  environment.services.api.env.TOKEN.fromEnv = 'PREVIEWD_UNSELECTED_INPUT';
  await assert.rejects(client.inspect(environment), { code: 'INVALID_INPUT' });
  await client.shutdown();
  assert.equal((await exit)[0], 0, stderr);
  await assert.rejects(client.list(), { code: 'DAEMON_UNAVAILABLE' });
});

test('interrupting CLI wait closes its request but leaves the daemon candidate cancelable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd wait '));
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: ({ signal }) => new Promise<boolean>((resolveApproval) => {
    signal.addEventListener('abort', () => resolveApproval(false), { once: true });
  }) });
  const tokenFile = join(directory, 'private', 'token');
  const daemon = await startDaemon({ runtime, port: 0, tokenFile });
  const client = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  t.after(async () => { await client.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }); });
  const status = await client.start({ name: 'waiting', type: 'command', cwd: directory, command: [process.execPath, '-e', 'process.exit(99)'] });
  let entered!: () => void;
  const waiting = new Promise<void>((done) => { entered = done; });
  const original = runtime.wait.bind(runtime);
  runtime.wait = (...args) => { entered(); return original(...args); };
  const child = spawn(process.execPath, [cli, 'wait', 'waiting', status.candidate!.id, '--endpoint', daemon.endpoint, '--token-file', tokenFile], { stdio: 'pipe' });
  child.stdin.end(); child.stdout.resume(); child.stderr.resume();
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await exit; } });
  await waiting;
  child.kill('SIGINT');
  assert.equal((await exit)[0], 130);
  assert.equal((await client.get('waiting')).candidate?.id, status.candidate!.id);
  await client.cancel('waiting', status.candidate!.id);
});

test('interrupting an incomplete stdin spec exits without waiting for the producer to close its pipe', { timeout: 5_000 }, async (t) => {
  // Synchronize at the real stdin read, so the test never signals before CLI handlers exist.
  const hook = `const iterate = process.stdin[Symbol.asyncIterator];
process.stdin[Symbol.asyncIterator] = function () { process.send('reading-spec'); return iterate.call(this); };`;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, cli, 'start', '--file', '-'], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const exit = once(child, 'exit');
    const closed = once(child, 'close');
    const reading = once(child, 'message');
    let stdout = ''; let stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk; });
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    t.after(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await exit; } });
    child.stdin!.write('{');
    assert.deepEqual(await reading, ['reading-spec', undefined]);
    child.kill(signal);
    assert.equal((await closed)[0], 130);
    assert.equal(stdout, '');
    assert.equal(JSON.parse(stderr).error.code, 'CLOSED');
  }
});

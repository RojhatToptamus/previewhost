import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import childProcess, { spawn, fork, type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startNative, type NativeResource, type NativeCommandSpec as CommandSpec } from './native.js';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
const server = `
import http from 'node:http';
import fs from 'node:fs';
fs.writeFileSync('identity.json', JSON.stringify({ pid: process.pid, group: process.ppid }));
http.createServer((request, response) => response.end(JSON.stringify({
  port: process.env.PORT, host: process.env.HOST, url: process.env.PREVIEW_URL,
  inheritedSecret: process.env.PREVIEWD_TEST_UNDECLARED_SECRET,
  argv: process.argv.slice(2),
}))).listen(Number(process.env.PORT), process.env.HOST);
`;

nativeTest('native argv/env and listener ownership work from a directory with spaces; stop removes the group', async () => {
  const root = await fixture(server);
  const previous = process.env.PREVIEWD_TEST_UNDECLARED_SECRET;
  process.env.PREVIEWD_TEST_UNDECLARED_SECRET = 'must-not-inherit';
  let resource: NativeResource | undefined;
  try {
    resource = await launch(root, { command: [process.execPath, 'server.mjs', '{port}', 'literal $HOME; echo ignored'] });
    const body = await ready(resource);
    await resource.verifyListener();
    assert.deepEqual(JSON.parse(body), {
      port: String(resource.target.port), host: '127.0.0.1', url: 'http://127.0.0.1:45678',
      argv: [String(resource.target.port), 'literal $HOME; echo ignored'],
    });
    const identity = JSON.parse(await readFile(path.join(root, 'identity.json'), 'utf8'));
    await resource.stop();
    await resource.stop();
    assert.equal(present(identity.pid), false);
    assert.equal(present(-identity.group), false);
    await assert.rejects(fetch(`http://127.0.0.1:${resource.target.port}/`));
  } finally {
    if (previous === undefined) delete process.env.PREVIEWD_TEST_UNDECLARED_SECRET;
    else process.env.PREVIEWD_TEST_UNDECLARED_SECRET = previous;
    await resource?.stop(); await rm(root, { recursive: true, force: true });
  }
});

nativeTest('cancellation before supervisor spawn creates no command and preserves its cleanup handle', async () => {
  const root = await fixture(server);
  const controller = new AbortController();
  let resource: NativeResource | undefined;
  try {
    await assert.rejects(startNative({
      spec: spec(root), signal: controller.signal, url: 'http://127.0.0.1:45678', appendLog() {},
      onResource(value) { resource = value; controller.abort(); },
    }), { code: 'CLOSED' });
    assert.ok(resource);
    await resource.stop();
    await assert.rejects(access(path.join(root, 'identity.json')), { code: 'ENOENT' });
  } finally { await resource?.stop(); await rm(root, { recursive: true, force: true }); }
});

nativeTest('cancellation stops a paused supervisor even when configure backpressures its IPC channel', async () => {
  const root = await fixture(server);
  const controller = new AbortController();
  const originalFork = childProcess.fork;
  let supervisor: ChildProcess | undefined;
  let resource: NativeResource | undefined;
  let configured!: () => void;
  const configureObserved = new Promise<void>((resolve) => { configured = resolve; });
  let outcome: Promise<void> | undefined;
  const replacement = test.mock.method(childProcess, 'fork', (...args: unknown[]) => {
    const child = Reflect.apply(originalFork, childProcess, args) as ChildProcess;
    supervisor = child;
    const originalSend = child.send;
    child.send = ((message: { type?: string }, ...rest: unknown[]) => {
      if (message.type === 'configure') {
        process.kill(child.pid!, 'SIGSTOP');
        configured();
      }
      return Reflect.apply(originalSend, child, [message, ...rest]);
    }) as typeof child.send;
    return child;
  });
  syncBuiltinESMExports();
  try {
    outcome = assert.rejects(startNative({
      spec: spec(root, { command: [process.execPath, 'server.mjs', ...Array<string>(100).fill('x'.repeat(8192))] }),
      signal: controller.signal, url: 'http://127.0.0.1:45678', appendLog() {},
      onResource(value) { resource = value; },
    }), { code: 'CLOSED' });
    await deadline(configureObserved, 2_000);
    controller.abort();
    await deadline(Promise.all([outcome, resource!.stop()]), 5_000);
    assert.equal(present(-supervisor!.pid!), false);
    await assert.rejects(access(path.join(root, 'identity.json')), { code: 'ENOENT' });
  } finally {
    replacement.mock.restore(); syncBuiltinESMExports();
    if (supervisor?.pid) killKnownGroup(supervisor.pid);
    await resource?.stop();
    await outcome?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest('missing executable fails and joins supervisor cleanup', async () => {
  const root = await fixture(server);
  let resource: NativeResource | undefined;
  try {
    await assert.rejects(startNative({
      spec: spec(root, { command: ['/previewhost-missing-executable'] }), signal: new AbortController().signal,
      url: 'http://127.0.0.1:45678', appendLog() {}, onResource(value) { resource = value; },
    }), { code: 'START_FAILED' });
    assert.ok(resource);
    await resource.stop();
    await assert.rejects(access(path.join(root, 'identity.json')), { code: 'ENOENT' });
  } finally { await resource?.stop(); await rm(root, { recursive: true, force: true }); }
});

nativeTest('logs redact split and URL-encoded secrets and preserve split UTF-8', async () => {
  const root = await fixture(`
import http from 'node:http';
const secret = process.env.SECRET;
const unicode = Buffer.from('🌿');
process.stdout.write('before ' + secret.slice(0, 5));
setTimeout(() => {
  process.stdout.write(secret.slice(5) + ' ' + encodeURIComponent(secret) + ' after ');
  process.stdout.write(unicode.subarray(0, 2));
  setTimeout(() => {
    process.stdout.write(unicode.subarray(2));
    http.createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), process.env.HOST);
  }, 20);
}, 20);
`);
  let logs = '';
  let resource: NativeResource | undefined;
  const secret = 'special-secret/a b';
  try {
    resource = await launch(root, { env: { SECRET: secret } }, (text) => { logs += text; });
    await ready(resource);
    // Ending the stream flushes the bounded redaction lookbehind.
    await resource.stop();
    assert.equal(logs.includes(secret), false);
    assert.equal(logs.includes(encodeURIComponent(secret)), false);
    assert.match(logs, /before \[REDACTED\] \[REDACTED\] after 🌿/);
  } finally { await resource?.stop(); await rm(root, { recursive: true, force: true }); }
});

nativeTest('short and malformed Unicode environment values are redacted without rewriting markers', async () => {
  const root = await fixture(`
import http from 'node:http';
process.stdout.write(process.env.MALFORMED + ' x');
http.createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), process.env.HOST);
`);
  let logs = '';
  let resource: NativeResource | undefined;
  try {
    resource = await launch(root, { env: { SHORT: 'x', MARKER: 'E', MALFORMED: 'value-\ud800' } }, (text) => { logs += text; });
    await ready(resource); await resource.stop();
    assert.equal(logs, '[REDACTED] [REDACTED]');
  } finally { await resource?.stop(); await rm(root, { recursive: true, force: true }); }
});

nativeTest('log chunks preserve UTF-8 across IPC and redaction carry boundaries', async () => {
  const prefix = 'a'.repeat(16_383) + '🌿';
  const root = await fixture(`
import http from 'node:http';
process.stdout.write(${JSON.stringify(prefix)} + 'b'.repeat(4096) + '🌿');
http.createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), process.env.HOST);
`);
  const chunks: Buffer[] = [];
  let resource: NativeResource | undefined;
  try {
    // A two-character value retains one UTF-16 code unit for split secret matches.
    resource = await launch(root, { env: { SECRET: 'xy' } }, (text) => { chunks.push(Buffer.from(text)); });
    await ready(resource);
    await resource.stop();
    assert.equal(Buffer.concat(chunks).toString('utf8'), prefix + 'b'.repeat(4096) + '🌿');
  } finally { await resource?.stop(); await rm(root, { recursive: true, force: true }); }
});

nativeTest('listener validation rejects wildcard binding and leaves unrelated listeners untouched', async () => {
  const root = await fixture(server.replace('process.env.HOST);', "'0.0.0.0');"));
  let resource: NativeResource | undefined;
  const unrelated = http.createServer((_request, response) => response.end('unrelated'));
  try {
    resource = await launch(root);
    await ready(resource);
    await assert.rejects(resource.verifyListener(), /non-loopback/);
    await resource.stop();
    const port = resource.target.port;
    await new Promise<void>((resolve) => unrelated.listen(port, '127.0.0.1', resolve));
    await resource.stop();
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
  } finally {
    await resource?.stop();
    await closeServer(unrelated);
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest('a listener outside the command group is never accepted or stopped', async () => {
  const root = await fixture(`
import fs from 'node:fs';
fs.writeFileSync('port.txt', process.env.PORT);
setInterval(() => {}, 1000);
`);
  const unrelated = http.createServer((_request, response) => response.end('unrelated'));
  let resource: NativeResource | undefined;
  try {
    resource = await launch(root);
    await new Promise<void>((resolve) => unrelated.listen(resource!.target.port, '127.0.0.1', resolve));
    await assert.rejects(resource.verifyListener(), /outside the owned group/);
    await resource.stop();
    assert.equal(await (await fetch(`http://127.0.0.1:${resource.target.port}`)).text(), 'unrelated');
  } finally { await resource?.stop(); await closeServer(unrelated); await rm(root, { recursive: true, force: true }); }
});

nativeTest('stop kills stubborn descendants even when the command leader exits and pipes remain inherited', async () => {
  const root = await fixture(`
import { spawn } from 'node:child_process';
import fs from 'node:fs';
${server.replace(/import fs from 'node:fs';/, '')}
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'inherit' });
fs.writeFileSync('descendant.txt', String(child.pid));
const timer = setInterval(() => { if (fs.existsSync('exit-now')) process.exit(0); }, 20);
`);
  let resource: NativeResource | undefined;
  let group: number | undefined;
  let descendant: number | undefined;
  try {
    resource = await launch(root);
    await ready(resource);
    group = JSON.parse(await readFile(path.join(root, 'identity.json'), 'utf8')).group;
    descendant = Number(await untilFile(path.join(root, 'descendant.txt')));
    await writeFile(path.join(root, 'exit-now'), 'yes');
    await deadline(resource.exited!, 2_000);
    await resource.stop();
    assert.equal(present(descendant), false);
    assert.equal(present(-group!), false);
  } finally {
    if (group) killKnownGroup(group);
    await resource?.stop(); await rm(root, { recursive: true, force: true });
  }
});

nativeTest('owner SIGKILL closes supervisor IPC and stops the command group', async () => {
  const root = await fixture(server);
  let owner: ChildProcess | undefined;
  let identity: { pid: number; group: number } | undefined;
  try {
    await writeFile(path.join(root, 'owner.mjs'), `
import { startNative } from ${JSON.stringify(new URL('./native.js', import.meta.url).href)};
const resource = await startNative({
  spec: ${JSON.stringify(spec(root))}, url: 'http://127.0.0.1:45678', signal: new AbortController().signal,
  appendLog() {}, onResource() {},
});
await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(path.join(root, 'owner-ready'))}, 'ready'));
`);
    owner = spawn(process.execPath, [path.join(root, 'owner.mjs')], { cwd: root, stdio: 'ignore' });
    await untilFile(path.join(root, 'owner-ready'));
    identity = JSON.parse(await untilFile(path.join(root, 'identity.json')));
    owner.kill('SIGKILL');
    await until(() => !present(-identity!.group), 3_000);
    assert.equal(present(identity!.pid), false);
  } finally {
    owner?.kill('SIGKILL');
    if (identity) killKnownGroup(identity.group);
    await rm(root, { recursive: true, force: true });
  }
});

nativeTest('unexpected supervisor death uses the recorded live command identity for exact cleanup', async () => {
  const root = await fixture(server);
  let resource: NativeResource | undefined;
  let identity: { pid: number; group: number } | undefined;
  try {
    resource = await launch(root); await ready(resource);
    identity = JSON.parse(await untilFile(path.join(root, 'identity.json')));
    process.kill(identity!.group, 'SIGKILL');
    await deadline(resource.exited!, 2_000);
    await resource.stop();
    assert.equal(present(identity!.pid), false);
    assert.equal(present(-identity!.group), false);
  } finally {
    if (identity) killKnownGroup(identity.group);
    await resource?.stop(); await rm(root, { recursive: true, force: true });
  }
});

nativeTest('supervisor loss with unavailable target identity retains cleanup debt and permits a later absence check', async () => {
  const root = await fixture(`
import fs from 'node:fs';
fs.writeFileSync('identity.json', JSON.stringify({ pid: process.pid, group: process.ppid }));
process.kill(process.ppid, 'SIGKILL');
setInterval(() => {}, 1000);
`);
  let resource: NativeResource | undefined;
  let identity: { pid: number; group: number } | undefined;
  const original = childProcess.execFile;
  let inspections = 0;
  // Real process inspection can fail (for example permissions or a deadline).
  // Reproduce that boundary while the command really kills its guardian.
  const replacement = test.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    if (args[0] === '/bin/ps' && ++inspections === 2) {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      setTimeout(() => callback(new Error('Identity observation unavailable'), '', ''), 100);
      return undefined;
    }
    return Reflect.apply(original, childProcess, args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(launch(root, {}, undefined, (value) => { resource = value; }), { code: 'CLEANUP_INCOMPLETE' });
    assert.ok(resource);
    identity = JSON.parse(await untilFile(path.join(root, 'identity.json')));
    await deadline(resource.exited!, 2_000);
    assert.equal(present(identity!.pid), true);
    await assert.rejects(resource.stop(), { code: 'CLEANUP_INCOMPLETE' });
    killKnownGroup(identity!.group);
    await until(() => !present(-identity!.group));
    await resource.stop();
  } finally {
    replacement.mock.restore(); syncBuiltinESMExports();
    if (identity) killKnownGroup(identity.group);
    await resource?.stop(); await rm(root, { recursive: true, force: true });
  }
});

nativeTest('leaderless survivors after guardian loss are refused rather than killed by a remembered group number', async () => {
  const root = await fixture(`
import { spawn } from 'node:child_process';
${server}
const child = spawn(process.execPath, ['-e', "setInterval(()=>{},1000)"], { stdio: 'ignore' });
fs.writeFileSync('descendant.txt', String(child.pid));
setInterval(() => {
  if (fs.existsSync('lose-owners')) {
    process.kill(process.ppid, 'SIGKILL');
    process.exit(0);
  }
}, 20);
`);
  let resource: NativeResource | undefined;
  let group: number | undefined;
  try {
    resource = await launch(root); await ready(resource);
    group = JSON.parse(await untilFile(path.join(root, 'identity.json'))).group;
    const descendant = Number(await untilFile(path.join(root, 'descendant.txt')));
    await writeFile(path.join(root, 'lose-owners'), 'yes');
    await deadline(resource.exited!, 2_000);
    await assert.rejects(resource.stop(), { code: 'CLEANUP_INCOMPLETE' });
    assert.equal(present(descendant), true);
    killKnownGroup(group!);
    await until(() => !present(-group!));
    await resource.stop();
  } finally {
    if (group) killKnownGroup(group);
    await resource?.stop(); await rm(root, { recursive: true, force: true });
  }
});

nativeTest('pre-commit owner disconnect never executes the configured command', async () => {
  const root = await fixture(server);
  let child: ChildProcess | undefined;
  try {
    child = fork(fileURLToPath(new URL('./supervisor.js', import.meta.url)), [], { detached: true, silent: true, env: {}, execArgv: [] });
    child.stdout?.resume(); child.stderr?.resume();
    await childMessage(child, 'online');
    const configured = childMessage(child, 'configured');
    child.send({ type: 'configure', command: [process.execPath, 'server.mjs'], cwd: root, env: {}, redactions: [] });
    await configured;
    const stopped = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.disconnect();
    await deadline(stopped, 2_000);
    assert.equal(present(-child.pid!), false);
    await assert.rejects(access(path.join(root, 'identity.json')), { code: 'ENOENT' });
  } finally {
    if (child?.pid) killKnownGroup(child.pid);
    await rm(root, { recursive: true, force: true });
  }
});

function spec(cwd: string, overrides: Partial<CommandSpec> = {}): CommandSpec {
  return { name: 'native-test', type: 'command', cwd, command: [process.execPath, 'server.mjs'], env: {}, readyPath: '/', timeoutMs: 5_000, ...overrides };
}

async function launch(cwd: string, overrides: Partial<CommandSpec> = {}, appendLog: (text: string) => void = () => {}, onResource: (resource: NativeResource) => void = () => {}) {
  return startNative({ spec: spec(cwd, overrides), signal: new AbortController().signal, url: 'http://127.0.0.1:45678', appendLog, onResource });
}

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'previewhost native '));
  await writeFile(path.join(root, 'server.mjs'), source);
  return root;
}

async function ready(resource: NativeResource): Promise<string> {
  let body = '';
  await until(async () => {
    try { body = await (await fetch(`http://127.0.0.1:${resource.target.port}/`, { signal: AbortSignal.timeout(500) })).text(); return true; }
    catch { return false; }
  });
  return body;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const expires = performance.now() + timeoutMs;
  while (performance.now() < expires) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for the fixture state.');
}

async function untilFile(file: string): Promise<string> {
  let value = '';
  await until(async () => { try { value = await readFile(file, 'utf8'); return Boolean(value); } catch { return false; } });
  return value;
}

function present(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

function killKnownGroup(group: number) {
  if (!present(-group)) return;
  try { process.kill(-group, 'SIGKILL'); }
  catch (error) {
    // macOS can return EPERM while a killed leaderless group is being reaped.
    if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

async function closeServer(server: http.Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline exceeded.')), ms); })]); }
  finally { clearTimeout(timer); }
}

function childMessage(child: ChildProcess, type: string) {
  return deadline(new Promise<void>((resolve) => {
    const message = (value: { type: string }) => { if (value.type === type) { child.off('message', message); resolve(); } };
    child.on('message', message);
  }), 2_000);
}

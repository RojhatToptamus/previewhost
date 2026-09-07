import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createPreviewRuntime } from './index.js';

const execute = promisify(execFile);
const nativeTest = process.platform === 'darwin' ? test : test.skip;

nativeTest('cleanup failure after replacement cutover preserves the new route and retains old debt until stop can verify absence', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd replacement '));
  const site = join(directory, 'site');
  const baselinePorts = await ownedListenerPorts();
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => true });
  let identity: { pid: number; group: number; descendant: number } | undefined;
  let stream: http.ClientRequest | undefined;
  let response: http.IncomingMessage | undefined;
  try {
    await mkdir(site);
    await writeFile(join(site, 'index.html'), 'replacement remains available');
    await writeFile(join(directory, 'descendant.mjs'), `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
process.send('ready');
`);
    await writeFile(join(directory, 'server.mjs'), `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
const child = spawn(process.execPath, ['descendant.mjs'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
await once(child, 'message');
fs.writeFileSync('identity.json', JSON.stringify({ pid: process.pid, group: process.ppid, descendant: child.pid }));
http.createServer((request, response) => {
  if (request.url === '/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: old preview\\n\\n');
    return;
  }
  response.end('old preview');
}).listen(Number(process.env.PORT), process.env.HOST);
`);
    const started = await runtime.start({
      name: 'page', type: 'command', cwd: directory,
      command: [process.execPath, 'server.mjs'], timeoutMs: 5_000,
    });
    const old = await runtime.wait('page', started.candidate!.id);
    assert.equal(old.state, 'ready', JSON.stringify(old));
    assert.ok(old.url);
    identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'));
    assert.equal(present(identity!.descendant), true);

    let streamClosed!: () => void;
    const closed = new Promise<void>((done) => { streamClosed = done; });
    await new Promise<void>((opened, reject) => {
      stream = http.get(`${old.url}/events`, { agent: false }, (incoming) => {
        response = incoming;
        incoming.once('data', () => opened());
        incoming.on('data', () => {});
        incoming.once('close', streamClosed);
        incoming.on('error', () => {}); // The fixture deliberately loses its upstream.
      });
      stream.once('error', reject);
    });

    const spec = { name: 'page', type: 'static' as const, directory: site };
    const replacement = await runtime.replace('page', spec);
    const candidateId = replacement.candidate!.id;
    await until(async () => {
      const status = await runtime.get('page');
      if (status.active?.id !== candidateId) return false;
      assert.equal(status.busy, true, 'the old SSE request must keep retirement in progress at cutover');
      return true;
    });

    // These exact fixture processes are deliberately lost after cutover. The
    // descendant stays in their group, but previewd has no recorded live owner.
    process.kill(identity!.group, 'SIGKILL');
    process.kill(identity!.pid, 'SIGKILL');

    // Observe the static listener independently, without accessing runtime fields.
    const publicPort = Number(new URL(old.url).port);
    const staticPorts = [...await ownedListenerPorts()].filter((port) => port !== publicPort && !baselinePorts.has(port));
    assert.equal(staticPorts.length, 1);
    const staticUrl = `http://127.0.0.1:${staticPorts[0]}`;
    assert.equal(await body(old.url), 'replacement remains available');
    assert.equal(await body(staticUrl), 'replacement remains available');

    const outcome = await runtime.wait('page', candidateId, { timeoutMs: 10_000 });
    assert.equal(outcome.state, 'cleanup-incomplete');
    assert.equal(outcome.error?.code, 'CLEANUP_INCOMPLETE');
    assert.equal(outcome.url, old.url);
    await closed;
    const failedRetirement = await runtime.get('page');
    assert.equal(failedRetirement.active?.id, candidateId);
    assert.equal(failedRetirement.candidate, undefined);
    assert.equal(failedRetirement.busy, false);
    assert.deepEqual(failedRetirement.cleanup?.map((debt) => debt.attemptId), [old.id]);
    assert.equal(present(identity!.descendant), true, 'unverifiable survivors must not be signaled');
    assert.equal(await body(old.url), 'replacement remains available');
    await assert.rejects(runtime.replace('page', spec), { code: 'CLEANUP_INCOMPLETE' });

    await assert.rejects(runtime.stop('page'), { code: 'CLEANUP_INCOMPLETE' });
    const stopped = await runtime.get('page');
    assert.equal(stopped.active, undefined);
    assert.equal(stopped.url, undefined);
    assert.equal(stopped.busy, false);
    assert.deepEqual(stopped.cleanup?.map((debt) => debt.attemptId), [old.id]);
    assert.equal(present(identity!.descendant), true);
    await assert.rejects(body(old.url));
    await assert.rejects(body(staticUrl));
    await assert.rejects(runtime.start(spec), { code: 'CLEANUP_INCOMPLETE' });

    // Only the test knows this survivor's provenance. Manual fixture cleanup
    // lets a later stop verify absence without widening production kill authority.
    killFixtureGroup(identity!.group);
    await until(() => !present(-identity!.group));
    const repaired = await runtime.stop('page');
    assert.equal(repaired.cleanup, undefined);
    assert.equal(repaired.active, undefined);
    assert.equal(repaired.url, undefined);
    assert.equal(repaired.busy, false);
  } finally {
    response?.destroy();
    stream?.destroy();
    try {
      if (identity) {
        killFixtureGroup(identity.group);
        await until(() => !present(-identity!.group));
      }
    } finally {
      try { await runtime.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
});

async function body(url: string): Promise<string> {
  return fetch(url, { signal: AbortSignal.timeout(2_000) }).then((response) => response.text());
}

function present(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function killFixtureGroup(group: number): void {
  try { process.kill(-group, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('The fixture did not reach its expected process or preview state.');
}

async function ownedListenerPorts(): Promise<Set<number>> {
  let stdout: string;
  try {
    ({ stdout } = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 2_000 }));
  } catch (error) {
    if ((error as { code?: number; stdout?: string }).code === 1 && !(error as { stdout?: string }).stdout?.trim()) return new Set();
    throw error;
  }
  return new Set(stdout.split('\n').filter((line) => line.startsWith('n127.0.0.1:')).map((line) => Number(line.slice('n127.0.0.1:'.length))));
}

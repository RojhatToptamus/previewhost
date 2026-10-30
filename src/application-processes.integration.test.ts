import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewRuntime } from './runtime.js';
import { applicationSupervisorFiles } from './native.js';
import type { ApplicationProcessLauncher, RuntimeOptions, SupervisorChannel } from './contracts.js';

const posix = { skip: process.platform === 'win32' && 'Application process launchers require macOS or Linux' };

/**
 * A test embedder: forks the supervisor into its own process group and proves cleanup by that group's absence.
 * `inject()` returns a message, or several, delivered as if the supervisor had sent them right after `started`.
 */
function embedder(baseEnvironment: Record<string, string>, { module, inject }: { module?: string; inject?: () => unknown } = {}) {
  const requests: Array<{ module: string; env: Record<string, string>; cwd: string }> = [];
  const channels: Array<{ cwd: string; events: string[] }> = [];
  const groups = new Set<number>();
  let refuseStop: string | undefined;
  const launcher: ApplicationProcessLauncher = {
    baseEnvironment,
    async start({ module: requested, env, cwd }) {
      requests.push({ module: requested, env, cwd });
      const child = fork(module ?? requested, [], { cwd, env, detached: true, silent: true, execArgv: [] });
      const group = child.pid!;
      groups.add(group);
      const record = { cwd, events: [] as string[] };
      channels.push(record);
      const queued: unknown[] = [];
      const listeners: Array<(message: unknown) => void> = [];
      const exits: Array<(code: number | null, signal: string | null) => void> = [];
      let exit: [number | null, string | null] | undefined;
      const deliver = (message: unknown) => { if (listeners.length) for (const listener of listeners) listener(message); else queued.push(message); };
      child.on('message', (message: { type?: string }) => {
        deliver(message);
        if (inject && message.type === 'started') for (const extra of [inject()].flat()) if (extra !== undefined) deliver(extra);
      });
      child.once('close', (code, signal) => { exit = [code, signal]; for (const listener of exits) listener(code, signal); });
      return {
        send(message) {
          if ((message as { type?: string }).type === 'stop') record.events.push('ipc-stop');
          if (!child.connected) throw new Error('IPC is closed.');
          child.send(message as object, () => {});
        },
        onMessage(listener) { listeners.push(listener); for (const message of queued.splice(0)) listener(message); },
        onExit(listener) { if (exit) listener(...exit); else exits.push(listener); },
        stdout: child.stdout!, stderr: child.stderr!,
        async stop() {
          record.events.push('stop');
          if (refuseStop) throw new Error(refuseStop);
          await killGroup(group);
          groups.delete(group);
        },
      };
    },
  };
  return {
    launcher, requests, channels,
    refuseStop(message?: string) { refuseStop = message; },
    async cleanup() { for (const group of groups) await killGroup(group); },
  };
}

/**
 * Kills a process group and waits until it is gone. On macOS a group whose only members are unreaped zombies answers
 * EPERM, so EPERM means "still present", as in Previewhost's own `groupExists`, and only ESRCH proves absence.
 */
async function killGroup(group: number) {
  const signal = (name: NodeJS.Signals | 0): boolean => {
    try { process.kill(-group, name); return true; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw error;
    }
  };
  signal('SIGKILL');
  for (const deadline = Date.now() + 5_000; signal(0); await delay(25)) {
    if (Date.now() > deadline) throw new Error(`Process group ${group} survived.`);
  }
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-application-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const home = join(directory, 'agent-home');
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C' };
  const options: Omit<RuntimeOptions, 'applicationProcesses'> = {
    allowedRoots: [source], stateDirectory: join(directory, 'state'), keystoreDirectory: join(directory, 'keystore'), authorize: () => true,
  };
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step();
    await rm(directory, { recursive: true, force: true });
  });
  /** Starts a runtime whose application processes run through a test embedder; both are cleaned up in reverse. */
  async function start(behavior?: Parameters<typeof embedder>[1]) {
    const host = embedder(base, behavior);
    cleanup.push(() => host.cleanup());
    const runtime = await createPreviewRuntime({ ...options, applicationProcesses: host.launcher });
    cleanup.push(() => runtime.close());
    return { host, runtime };
  }
  return { directory, source, home, base, options, start, cleanup };
}

const server = `require('http').createServer((q, r) => r.end(JSON.stringify({
  HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? null, VALUE: process.env.VALUE ?? null, PORT: process.env.PORT,
}))).listen(Number(process.env.PORT), process.env.LISTEN ?? '127.0.0.1');`;

test('an embedder runs a copied supervisor from its base environment and stops it over IPC before stop()', posix, async t => {
  const { directory, source, home, base, options, start } = await fixture(t);
  // The embedder installs only the listed files, elsewhere, for another user.
  const installed = join(directory, 'installed');
  await mkdir(installed);
  const files = applicationSupervisorFiles();
  assert.ok(files.files.includes(files.module));
  for (const file of files.files) await copyFile(file, join(installed, basename(file)));
  // The listener is a descendant of the command, as with `npm run dev`.
  await writeFile(join(source, 'launcher.cjs'), `require('child_process').spawn(process.execPath, ['server.cjs'], { stdio: 'inherit' });`);
  await writeFile(join(source, 'server.cjs'), server);
  const { host, runtime } = await start({ module: join(installed, basename(files.module)) });

  const pending = await runtime.start({ name: 'app', type: 'command', cwd: source, command: [process.execPath, 'launcher.cjs'], env: { VALUE: 'bound' } });
  const ready = await runtime.wait('app', pending.candidate!.id);
  assert.equal(ready.state, 'ready', JSON.stringify({ ready, logs: await runtime.logs('app', ready.id) }));
  const { PORT: port, ...environment } = JSON.parse(await (await fetch(ready.url!)).text());
  assert.deepEqual(environment, { HOME: home, TMPDIR: null, VALUE: 'bound' });
  assert.notEqual(environment.HOME, process.env.HOME);
  assert.deepEqual(host.requests, [{ module: files.module, env: base, cwd: await realpath(source) }]);
  // Recovery belongs to the embedder: the owner records no process it did not start.
  assert.deepEqual(JSON.parse(await readFile(join(options.stateDirectory!, 'app.json'), 'utf8')).processes, {});

  await runtime.stop('app');
  assert.deepEqual(host.channels.map(channel => channel.events), [['ipc-stop', 'stop']]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
});

test('environment services and jobs run through the embedder, and a refused stop() leaves cleanup to retry', posix, async t => {
  const { source, base, start } = await fixture(t);
  await writeFile(join(source, 'server.cjs'), server);
  await writeFile(join(source, 'setup.cjs'), `require('fs').writeFileSync('setup.txt', process.env.HOME);`);
  const { host, runtime } = await start();

  const pending = await runtime.start({ name: 'env', type: 'environment', primary: 'web', services: {
    setup: { type: 'job', cwd: source, command: [process.execPath, 'setup.cjs'] },
    web: { type: 'command', cwd: source, command: [process.execPath, 'server.cjs'], dependsOn: ['setup'] },
  } });
  const ready = await runtime.wait('env', pending.candidate!.id);
  assert.equal(ready.state, 'ready', JSON.stringify({ ready, logs: await runtime.logs('env', ready.id) }));
  assert.equal(await readFile(join(source, 'setup.txt'), 'utf8'), base.HOME);
  assert.equal(JSON.parse(await (await fetch(ready.url!)).text()).HOME, base.HOME);
  assert.equal(host.requests.length, 2);

  host.refuseStop('the unit is still active');
  await assert.rejects(runtime.stop('env'), { code: 'CLEANUP_INCOMPLETE' });
  const incomplete = await runtime.get('env');
  assert.equal(incomplete.latest?.state, 'cleanup-incomplete');
  assert.equal(incomplete.latest?.services?.web.error?.code, 'CLEANUP_INCOMPLETE');
  host.refuseStop();
  assert.equal((await runtime.stop('env')).latest?.state, 'stopped');
  const web = host.channels[1].events;
  assert.deepEqual([web[0], web.at(-1), web.filter(event => event === 'stop').length], ['ipc-stop', 'stop', 2]);
});

test('the supervisor refuses a listener outside its command tree and a non-loopback listener', posix, async t => {
  const { source, start, cleanup } = await fixture(t);
  await writeFile(join(source, 'idle.cjs'), `require('fs').writeFileSync('port.txt', process.env.PORT); setInterval(() => {}, 1000);`);
  await writeFile(join(source, 'server.cjs'), server);
  const { runtime } = await start();

  const pending = await runtime.start({ name: 'idle', type: 'command', cwd: source, command: [process.execPath, 'idle.cjs'] });
  let port: number | undefined;
  for (const deadline = Date.now() + 10_000; !port; await delay(25)) {
    port = Number(await readFile(join(source, 'port.txt'), 'utf8').catch(() => '')) || undefined;
    assert.ok(Date.now() < deadline, 'The command did not report its port.');
  }
  const unrelated = http.createServer((_request, response) => response.end('unrelated'));
  await new Promise<void>(resolve => unrelated.listen(port, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => unrelated.close(resolve)));
  const foreign = await runtime.wait('idle', pending.candidate!.id);
  assert.equal(foreign.state, 'failed');
  assert.match(foreign.error!.message, /outside the command's process tree/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'unrelated');

  const wildcard = await runtime.start({ name: 'wildcard', type: 'command', cwd: source, command: [process.execPath, 'server.cjs'], env: { LISTEN: '0.0.0.0' } });
  const refused = await runtime.wait('wildcard', wildcard.candidate!.id);
  assert.equal(refused.state, 'failed');
  assert.match(refused.error!.message, /non-loopback/);
});

test('a restarted service and its command probe both run through the embedder', posix, async t => {
  const { source, base, start } = await fixture(t);
  await writeFile(join(source, 'once.cjs'), `const fs = require('fs');
if (!fs.existsSync('failed-once')) { fs.writeFileSync('failed-once', ''); process.exit(1); }
${server}`);
  await writeFile(join(source, 'probe.cjs'), `require('http').get('http://127.0.0.1:' + process.env.PORT, response => {
  require('fs').writeFileSync('probe.txt', process.env.HOME); process.exit(response.statusCode === 200 ? 0 : 1);
}).on('error', () => process.exit(1));`);
  const { host, runtime } = await start();
  const pending = await runtime.start({ name: 'restart', type: 'environment', primary: 'web', services: {
    web: { type: 'command', cwd: source, command: [process.execPath, 'once.cjs'], restart: { mode: 'on-failure', maxRestarts: 2, backoffMs: 0 },
      ready: { type: 'command', command: [process.execPath, 'probe.cjs'], timeoutMs: 10000 } },
  } });
  const ready = await runtime.wait('restart', pending.candidate!.id);
  assert.equal(ready.state, 'ready', JSON.stringify({ ready, logs: await runtime.logs('restart', ready.id) }));
  assert.match((await runtime.logs('restart', ready.id, { source: 'web' })).text, /Restart 1\/2/);
  // The probe ran from the embedder's environment, not the owner's.
  assert.equal(await readFile(join(source, 'probe.txt'), 'utf8'), base.HOME);
  assert.ok(host.requests.length >= 3, `two service starts and at least one probe: ${host.requests.length}`);
  await runtime.stop('restart');
});

test('a supervisor message outside the protocol stops the channel and fails the command', posix, async t => {
  const { source, start } = await fixture(t);
  await writeFile(join(source, 'idle.cjs'), 'setInterval(() => {}, 1000);');
  let injected: unknown;
  const { host, runtime } = await start({ inject: () => injected });
  for (const [name, message] of [
    ['wrong-id', { type: 'listener', id: 99, result: 'owned' }],
    ['unknown', { type: 'debug', text: 'hello' }],
    ['oversized', { type: 'log', text: 'x'.repeat(16_385) }],
  ] as const) {
    injected = message;
    const pending = await runtime.start({ name, type: 'command', cwd: source, command: [process.execPath, 'idle.cjs'] });
    const failed = await runtime.wait(name, pending.candidate!.id);
    assert.equal(failed.state, 'failed', name);
    assert.equal(failed.error?.code, 'SUPERVISOR_FAILED', name);
    assert.match(failed.error!.message, /outside its protocol/, name);
    // An untrusted supervisor gets no IPC grace: the embedder stops it directly.
    assert.deepEqual(host.channels.at(-1)!.events, ['stop'], name);
    assert.equal((await runtime.get(name)).cleanup, undefined, name);
  }
});

test('a launcher that rejects, honors cancellation, or never returns does not hold startup or hide cleanup', posix, async t => {
  const { source, base, options, cleanup } = await fixture(t);
  await writeFile(join(source, 'server.cjs'), server);
  const spec = (name: string) => ({ name, type: 'command' as const, cwd: source, command: [process.execPath, 'server.cjs'] });
  let pendingStart: ((channel: SupervisorChannel) => void) | undefined;
  let mode: 'reject' | 'abort' | 'never' = 'reject';
  const runtime = await createPreviewRuntime({ ...options, applicationProcesses: { baseEnvironment: base, start: ({ signal }) => {
    if (mode === 'reject') return Promise.reject(new Error('sandbox unavailable'));
    if (mode === 'abort') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return new Promise(resolve => { pendingStart = resolve; });
  } } });
  cleanup.push(() => runtime.close());

  const rejected = await runtime.wait('reject', (await runtime.start(spec('reject'))).candidate!.id);
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.error?.code, 'SUPERVISOR_FAILED');
  assert.match(rejected.error!.message, /sandbox unavailable/);

  mode = 'abort';
  const aborting = (await runtime.start(spec('abort'))).candidate!.id;
  await delay(100);
  await runtime.cancel('abort', aborting);
  const canceled = await runtime.get('abort');
  assert.equal(canceled.latest?.state, 'canceled');
  assert.equal(canceled.cleanup, undefined);

  mode = 'never';
  const never = (await runtime.start(spec('never'))).candidate!.id;
  for (const deadline = Date.now() + 5000; !pendingStart; await delay(25)) assert.ok(Date.now() < deadline, 'start was not called');
  // Startup ends at cancellation; cleanup stays visible while the launcher has not returned.
  await runtime.cancel('never', never).catch(error => assert.equal(error.code, 'CLEANUP_INCOMPLETE'));
  assert.equal((await runtime.get('never')).latest?.state, 'cleanup-incomplete');
  const stops: string[] = [];
  pendingStart!({ send() {}, onMessage() {}, onExit() {}, stdout: Readable.from([]), stderr: Readable.from([]), async stop() { stops.push('stop'); } });
  assert.equal((await runtime.stop('never')).latest?.state, 'stopped');
  assert.deepEqual(stops, ['stop']);
});

test('a burst of ordinary output delivered in one turn passes, and a flood past the byte bound fails', posix, async t => {
  const { source, start } = await fixture(t);
  await writeFile(join(source, 'server.cjs'), server);
  let injected: unknown[] = [];
  const { runtime } = await start({ inject: () => injected });
  // As when the owner is busy: thousands of short log messages arrive before it next drains the channel.
  injected = Array.from({ length: 5000 }, (_, index) => ({ type: 'log', text: `burst line ${index}\n` }));
  const burst = await runtime.wait('burst', (await runtime.start({ name: 'burst', type: 'command', cwd: source, command: [process.execPath, 'server.cjs'] })).candidate!.id);
  assert.equal(burst.state, 'ready', JSON.stringify(burst));
  assert.match((await runtime.logs('burst', burst.id)).text, /burst line 4999/);
  injected = Array.from({ length: 600 }, () => ({ type: 'log', text: 'x'.repeat(16_000) }));
  const flood = await runtime.wait('flood', (await runtime.start({ name: 'flood', type: 'command', cwd: source, command: [process.execPath, 'server.cjs'] })).candidate!.id);
  assert.equal(flood.state, 'failed');
  assert.equal(flood.error?.code, 'SUPERVISOR_FAILED');
  assert.match(flood.error!.message, /outside its protocol/);
});

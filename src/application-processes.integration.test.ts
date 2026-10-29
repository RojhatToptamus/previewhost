import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewRuntime } from './runtime.js';
import { applicationSupervisorFiles } from './native.js';
import type { ApplicationProcessLauncher, RuntimeOptions } from './contracts.js';

const posix = { skip: process.platform === 'win32' && 'Application process launchers require macOS or Linux' };

/** A test embedder: forks the supervisor into its own process group and proves cleanup by that group's absence. */
function embedder(baseEnvironment: Record<string, string>, module?: string) {
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
      child.on('message', message => { if (listeners.length) for (const listener of listeners) listener(message); else queued.push(message); });
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

async function killGroup(group: number) {
  try { process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  for (const deadline = Date.now() + 5_000; ; await delay(25)) {
    try { process.kill(-group, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
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
  async function start(module?: string) {
    const host = embedder(base, module);
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
  const { host, runtime } = await start(join(installed, basename(files.module)));

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

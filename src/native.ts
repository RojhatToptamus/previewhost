import { fork, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import type { CommandSpec, RuntimeOptions } from './contracts.js';
import type { Resource } from './resources.js';
import { PreviewError, throwIfAborted } from './errors.js';
import { captureOutput } from './stream-logs.js';
import { validateEnvironmentSize } from './spec.js';
import { requireSupportedPlatform } from './private-files.js';
import { createWindowsJob, assertWindowsListener } from './windows.js';

// Process-group and owner-IPC behavior derives from Task Monki (MIT); see NOTICE.

export interface ProcessIdentity {
  pid: number;
  group: number;
  started: string;
  command: string;
}
export interface NativeReceipt { source: string; supervisor: ProcessIdentity; command?: ProcessIdentity }
export interface NativeOwnership {
  save(receipt: NativeReceipt): Promise<void>;
  clear(): Promise<void>;
}

export interface NativeResource extends Resource {
  verifyListener(port?: number): Promise<void>;
  completion: Promise<{ code: number | null; signal: string | null }>;
}
export type NativeCommandSpec = Omit<CommandSpec, 'env'> & { env: Record<string, string> };

/** The caller receives cleanup ownership before the supervisor can execute. */
export interface NativeInput {
  /** Allocated once by the environment and reused by restarts. Zero means no HTTP port. */
  port?: number;
  /** Runtime-assigned ports are public metadata, not private bindings to redact. */
  portEnvironment?: Record<string, string>;
  /** Owner-selected tool environment, separate from application bindings and secret values. */
  hostEnvironment?: Record<string, string>;
  ownership?: NativeOwnership;
  supervisor?: RuntimeOptions['supervisor'];
  spec: Pick<NativeCommandSpec, 'cwd' | 'command' | 'env'>;
  url: string;
  signal: AbortSignal;
  appendLog(text: string): void;
  redactions?: string[];
  onResource(resource: NativeResource): void;
}

export function startNative(input: NativeInput): Promise<NativeResource> {
  return launchNative(input, false);
}

/** Finite jobs use the same supervisor, redaction and verified group cleanup as servers. */
export async function runNativeJob(input: Omit<NativeInput, 'onResource'> & {
  timeoutMs: number; onResource(resource: Pick<Resource, 'stop'>): void;
}): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs);
  let resource: Awaited<ReturnType<typeof launchNative>> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    resource = await launchNative({ ...input, signal }, true);
    const result = await Promise.race([
      resource.completion,
      resource.exited!.then(error => { throw error; }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new PreviewError('CLOSED', 'Job canceled. Database writes are not rolled back.'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    throwIfAborted(signal);
    if (result.code !== 0 || result.signal) throw new PreviewError('START_FAILED', `Job exited (${result.code ?? result.signal ?? 'unknown'}). Database writes are not rolled back.`);
  } catch (error) {
    if (timedOut) throw new PreviewError('TIMEOUT', `Job exceeded ${input.timeoutMs}ms. Database writes are not rolled back.`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await resource?.stop();
  }
}

async function launchNative(input: NativeInput, job: boolean): Promise<NativeResource & { completion: Promise<{ code: number | null; signal: string | null }> }> {
  requireSupportedPlatform();
  throwIfAborted(input.signal);
  validateEnvironmentSize(input.spec.env);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(input.spec.command[0])) {
    throw new PreviewError('INVALID_INPUT', 'Windows batch files require an explicit cmd.exe command. Use node.exe with the script path to preserve literal arguments.');
  }
  if (process.platform !== 'win32') await Promise.all(nativeTools().map((name) => access(name, constants.X_OK)));
  throwIfAborted(input.signal);
  const port = job ? 0 : input.port ?? await availablePort();
  throwIfAborted(input.signal);

  let supervisor: ChildProcess | undefined;
  let output: Promise<void>[] = [];
  let supervisorIdentity: ProcessIdentity | undefined;
  let commandIdentity: ProcessIdentity | undefined;
  let group: number | undefined;
  let windowsJob: ReturnType<typeof createWindowsJob> | undefined;
  let stopping = false;
  let stopped = false;
  let unexpectedError: Error | undefined;
  let stopWork: Promise<void> | undefined;
  let unexpected!: (error: Error) => void;
  const exited = new Promise<Error>((resolve) => { unexpected = resolve; });
  let finished = false;
  let complete!: (result: { code: number | null; signal: string | null }) => void;
  const completion = new Promise<{ code: number | null; signal: string | null }>(resolve => { complete = resolve; });
  const resource = {
    completion,
    target: { port, hostHeader: `127.0.0.1:${port}` },
    exited,
    stop,
    assertRunning: ensureStarting,
    async verifyListener(listenPort = port) {
      ensureStarting();
      if (!group) throw new PreviewError('START_FAILED', 'The native supervisor is no longer running.');
      if (process.platform === 'win32') {
        if (!windowsJob) throw new PreviewError('START_FAILED', 'Windows process ownership is unavailable.');
        assertWindowsListener(listenPort, windowsJob);
      } else await assertOwnedListener(listenPort, group);
      ensureStarting();
    },
  };
  const onAbort = () => { void stop().catch(() => undefined); };
  input.onResource(resource);
  if (!stopping && !input.signal.aborted) input.signal.addEventListener('abort', onAbort, { once: true });

  function ensureStarting() {
    throwIfAborted(input.signal);
    if (stopping) throw new PreviewError('CLOSED', 'The native command was stopped.');
    if (unexpectedError) throw unexpectedError;
  }

  function recordUnexpected(error: Error) {
    if (stopping || unexpectedError) return;
    unexpectedError = error;
    unexpected(error);
  }

  function stop(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (stopWork) return stopWork;
    stopping = true;
    input.signal.removeEventListener('abort', onAbort);
    stopWork = stopOnce().then(async () => { await input.ownership?.clear(); stopped = true; }).catch((error: unknown) => {
      if (error instanceof PreviewError && error.code === 'CLEANUP_INCOMPLETE') throw error;
      throw new PreviewError('CLEANUP_INCOMPLETE', `Native cleanup failed${group ? ` for process group ${group}` : ''}.`);
    }).finally(() => { stopWork = undefined; });
    return stopWork;
  }

  async function stopOnce(): Promise<void> {
    if (!supervisor || !group) return;
    if (process.platform === 'win32') {
      if (windowsJob) {
        if (supervisor.connected) {
          void send(supervisor, { type: 'stop' }).catch(() => undefined);
          const drainDeadline = performance.now() + 500;
          while (supervisor.exitCode === null && supervisor.signalCode === null && performance.now() < drainDeadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        await windowsJob.stop();
      }
      else if (supervisor.exitCode === null && supervisor.signalCode === null) {
        // Before job assignment, no application can run. ChildProcess retains the exact Windows handle.
        supervisor.kill();
      }
      const deadline = performance.now() + 3000;
      while (supervisor.exitCode === null && supervisor.signalCode === null) {
        if (performance.now() >= deadline) throw cleanupError(group);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return;
    }
    // IPC is an exact live process handle; it never signals a reused PID.
    if (supervisor.connected) {
      // A blocked configure write must not postpone the cleanup deadline.
      void send(supervisor, { type: 'stop' }).catch(() => undefined);
      if (await waitForGroupAbsence(group, 2_000)) return;
    }
    if (!groupExists(group)) return;
    await signalVerifiedGroup('SIGTERM');
    if (await waitForGroupAbsence(group, 750)) return;
    await signalVerifiedGroup('SIGKILL');
    if (await waitForGroupAbsence(group, 1_500)) return;
    throw cleanupError(group);
  }

  async function signalVerifiedGroup(signal: NodeJS.Signals): Promise<void> {
    if (!group || !groupExists(group)) return;
    for (const identity of [supervisorIdentity, commandIdentity]) {
      if (!identity) continue;
      const actual = await inspectProcess(identity.pid);
      if (actual && sameIdentity(actual, identity)) {
        try { process.kill(-group, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        return;
      }
    }
    // Group absence proves cleanup. Group existence alone proves no authority.
    if (groupExists(group)) throw cleanupError(group);
  }

  try {
    ensureStarting();
    supervisor = fork(input.supervisor?.module ?? fileURLToPath(new URL('./supervisor.js', import.meta.url)), [], {
      detached: process.platform !== 'win32',
      silent: true,
      execArgv: [],
      execPath: input.supervisor?.executable ?? process.execPath,
      env: { ...(process.platform === 'win32' ? commandEnvironment({}, undefined, '') : {}), ...input.supervisor?.env },
    });
    group = supervisor.pid;
    const redactions = [...Object.values(input.spec.env), ...(input.redactions ?? []), ...Object.entries(input.supervisor?.env ?? {}).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE').map(([, value]) => value)];
    output = [supervisor.stdout!, supervisor.stderr!].map(stream => captureOutput(stream, redactions, input.appendLog));
    supervisor.on('message', (message: Record<string, unknown>) => {
      if (message?.type === 'log' && typeof message.text === 'string') {
        input.appendLog(message.text);
      } else if (message?.type === 'target-exit' && !stopping) {
        finished = job;
        complete({ code: typeof message.code === 'number' ? message.code : null, signal: typeof message.signal === 'string' ? message.signal : null });
        if (!job) recordUnexpected(new PreviewError('START_FAILED', `Native command exited (${message.code ?? message.signal ?? 'unknown'}).`));
      } else if (message?.type === 'failure' && !stopping) {
        recordUnexpected(new PreviewError(message.code === 'SUPERVISOR_FAILED' ? 'SUPERVISOR_FAILED' : 'START_FAILED', typeof message.message === 'string' ? message.message : 'Native command failed.'));
      }
    });
    supervisor.once('error', (error) => {
      recordUnexpected(new PreviewError('SUPERVISOR_FAILED', `Native supervisor failed: ${error.message}`));
    });
    // A finite job's result can still be buffered in IPC when its supervisor exits.
    supervisor.once(job ? 'close' : 'exit', async (code, signal) => {
      await Promise.race([Promise.all(output), new Promise(resolve => setTimeout(resolve, 250))]);
      if (!finished) recordUnexpected(new PreviewError('SUPERVISOR_FAILED', `Native supervisor exited (${code ?? signal ?? 'unknown'}).`));
    });
    const online = await waitMessage(supervisor, 'online', input.signal);
    ensureStarting();
    if (process.platform === 'win32') {
      if (!group || typeof online.started !== 'string') throw new PreviewError('START_FAILED', 'Windows supervisor identity is missing.');
      windowsJob = createWindowsJob(group, online.started);
    } else {
      supervisorIdentity = group ? await inspectProcess(group) : undefined;
      if (!supervisorIdentity || supervisorIdentity.group !== group) {
        throw new PreviewError('START_FAILED', 'The native supervisor did not establish its owned process group.');
      }
    }
    ensureStarting();
    const argv = job ? input.spec.command : input.spec.command.map((arg) => arg.replaceAll('{port}', String(port)));
    await Promise.all([
      waitMessage(supervisor, 'configured', input.signal),
      send(supervisor, {
        type: 'configure', command: argv,
        cwd: input.spec.cwd,
        env: { ...commandEnvironment(input.spec.env, job || !port ? undefined : port, input.url), ...input.portEnvironment, ...input.hostEnvironment },
        redactions: [...Object.values(input.spec.env), ...(input.redactions ?? [])],
      }),
    ]);
    ensureStarting();
    // Persist authority before commit permits the supervisor to spawn application code.
    if (supervisorIdentity) await input.ownership?.save({ source: input.spec.cwd, supervisor: supervisorIdentity });
    ensureStarting();
    const [started] = await Promise.all([
      waitMessage(supervisor, 'started', input.signal),
      send(supervisor, { type: 'commit' }),
    ]);
    ensureStarting();
    if (typeof started.pid !== 'number') throw new PreviewError('START_FAILED', 'Native command identity is missing.');
    if (windowsJob) return resource;
    commandIdentity = await inspectProcess(started.pid);
    // Fast jobs may exit before ps observes them. Persist live job children for stop-only recovery.
    if (job && !commandIdentity) return resource;
    if (!commandIdentity || commandIdentity.group !== group) {
      throw new PreviewError('START_FAILED', 'Native command exited before its process identity could be verified.');
    }
    ensureStarting();
    await input.ownership?.save({ source: input.spec.cwd, supervisor: supervisorIdentity!, command: commandIdentity });
    ensureStarting();
    return resource;
  } catch (error) {
    await stop();
    await Promise.race([Promise.all(output), new Promise(resolve => setTimeout(resolve, 250))]);
    throw error;
  }

}

/** Stop-only recovery: a PID or group number by itself never grants authority to signal. */
export async function recoverNative(receipt: NativeReceipt): Promise<void> {
  if (process.platform === 'win32') throw new PreviewError('CLEANUP_INCOMPLETE', 'A POSIX native receipt cannot be recovered on Windows.');
  const group = receipt.supervisor.group;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!groupExists(group)) return;
    let verified = false;
    for (const identity of [receipt.supervisor, receipt.command]) {
      if (!identity) continue;
      const actual = await inspectProcess(identity.pid);
      if (actual && sameIdentity(actual, identity) && actual.group === group) { verified = true; break; }
    }
    if (!verified) throw cleanupError(group);
    try { process.kill(-group, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (await waitForGroupAbsence(group, signal === 'SIGTERM' ? 750 : 1500)) return;
  }
  throw cleanupError(group);
}

function cleanupError(group: number) {
  return new PreviewError('CLEANUP_INCOMPLETE', `Could not verify cleanup of native process group ${group}. Inspect its processes manually; previewhost will not signal an unknown owner.`);
}

export function commandEnvironment(values: Record<string, string>, port: number | undefined, url: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', ...(process.platform === 'win32' ? ['SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'COMSPEC', 'PATHEXT'] : [])]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.platform === 'win32') {
    const keys = Object.keys(values).map(key => key.toUpperCase());
    if (new Set(keys).size !== keys.length) throw new PreviewError('INVALID_INPUT', 'Windows environment names must be unique without regard to case.');
    values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toUpperCase(), value]));
  }
  return { ...env, ...values, ...(port === undefined ? {} : { PORT: String(port), HOST: '127.0.0.1' }), PREVIEW_URL: url };
}

export async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function send(child: ChildProcess, message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) { reject(new PreviewError('SUPERVISOR_FAILED', 'Native supervisor IPC is closed.')); return; }
    child.send(message, (error) => error ? reject(new PreviewError('SUPERVISOR_FAILED', `Native supervisor communication failed: ${error.message}`)) : resolve());
  });
}

function waitMessage(child: ChildProcess, type: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new PreviewError('SUPERVISOR_FAILED', `Native supervisor timed out before ${type}.`)), 5_000);
    const message = (value: Record<string, unknown>) => {
      if (value?.type === type) finish(undefined, value);
      if (value?.type === 'failure') finish(new PreviewError(value.code === 'SUPERVISOR_FAILED' ? 'SUPERVISOR_FAILED' : 'START_FAILED', String(value.message ?? 'Native launch failed.')));
    };
    const close = () => finish(new PreviewError('SUPERVISOR_FAILED', `Native supervisor exited before ${type}.`));
    const abort = () => finish(new PreviewError('CLOSED', 'Native startup was canceled.'));
    const failed = (error: Error) => finish(new PreviewError('SUPERVISOR_FAILED', `Native supervisor could not start: ${error.message}`));
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer);
      child.off('message', message); child.off('close', close); child.off('error', failed);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    }
    child.on('message', message); child.once('close', close); child.once('error', failed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function inspectProcess(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const output = await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command=']);
    const fields = output.trim().split(/\s+/);
    if (fields.length < 8) return undefined;
    return { pid: Number(fields[0]), group: Number(fields[1]), started: fields.slice(2, 7).join(' '), command: fields.slice(7).join(' ') };
  } catch { return undefined; }
}

function sameIdentity(actual: ProcessIdentity, expected: ProcessIdentity): boolean {
  return actual.pid === expected.pid && actual.group === expected.group && actual.started === expected.started && actual.command === expected.command;
}

async function assertOwnedListener(port: number, group: number): Promise<void> {
  let output: string;
  try { output = await execute(lsofPath(), ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']); }
  catch { throw new PreviewError('START_FAILED', `No owned listener was observed on native port ${port}.`); }
  let pid: number | undefined;
  let listeners = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n') || !pid) continue;
    listeners += 1;
    if (line.slice(1) !== `127.0.0.1:${port}` && line.slice(1) !== `[::1]:${port}`) {
      throw new PreviewError('START_FAILED', `Native port ${port} has a non-loopback listener.`);
    }
    const identity = await inspectProcess(pid);
    if (!identity || identity.group !== group) {
      throw new PreviewError('START_FAILED', `Native port ${port} belongs to a process outside the owned group.`);
    }
  }
  if (!listeners) throw new PreviewError('START_FAILED', `No owned listener was observed on native port ${port}.`);
}

function execute(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, args, { timeout: 2_000, maxBuffer: 65_536 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    if (process.platform !== 'linux') return true;
    // A zombie cannot execute or hold a listener. Linux containers can retain unreaped orphans.
    const rows = execFileSync('/bin/ps', ['-eo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: 'C' } });
    const members = rows.trim().split('\n').map(row => {
      const [id, state] = row.trim().split(/\s+/);
      if (!/^\d+$/.test(id) || !state) throw cleanupError(group);
      return { group: Number(id), state };
    });
    return members.some(member => member.group === group && !/^[ZX]/.test(member.state));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

async function waitForGroupAbsence(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (!groupExists(group)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (performance.now() < deadline);
  return !groupExists(group);
}

function lsofPath(): string { return process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof'; }

/** Files checked before launching native jobs or services. */
export function nativeTools(): string[] { return process.platform === 'win32' ? [] : ['/bin/ps', lsofPath()]; }

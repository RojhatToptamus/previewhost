import { spawn, type ChildProcess } from 'node:child_process';
import { captureOutput } from './stream-logs.js';
import { listenerOwnership } from './listener-ownership.js';

// Process-group and owner-IPC behavior derives from Task Monki (MIT); see NOTICE.
// An embedder may install this module elsewhere for another user. Import only Node built-ins and the
// files listed by applicationSupervisorFiles(); Windows-only code loads dynamically.

interface Launch {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  redactions: string[];
}

let launch: Launch | undefined;
let target: ChildProcess | undefined;
let committed = false;
let stopping = false;
let output: Promise<void>[] = [];
const deadline = setTimeout(() => { void stop(); }, 5_000);

process.on('message', (value: Record<string, unknown>) => {
  if (value?.type === 'stop') { void stop(); return; }
  if (stopping) return;
  if (value?.type === 'check-listener') {
    const { id, port } = value;
    if (!Number.isSafeInteger(id) || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      void fail('The supervisor received an invalid listener check.', true); return;
    }
    const pid = target?.exitCode === null && target.signalCode === null ? target.pid : undefined;
    void (pid ? listenerOwnership(pid, port as number) : Promise.resolve('missing')).then(result => send({ type: 'listener', id, result }));
    return;
  }
  if (value?.type === 'configure' && !launch && !committed) {
    if (!Array.isArray(value.command) || !value.command.length || !value.command.every((item) => typeof item === 'string') ||
      typeof value.cwd !== 'string' || !value.env || typeof value.env !== 'object' || !Array.isArray(value.redactions)) {
      void fail('The supervisor received an invalid launch contract.', true); return;
    }
    launch = value as unknown as Launch;
    void send({ type: 'configured' });
  } else if (value?.type === 'commit' && launch && !committed) {
    committed = true;
    clearTimeout(deadline);
    target = spawn(launch.command[0], launch.command.slice(1), {
      cwd: launch.cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    });
    output = [captureOutput(target.stdout!, launch.redactions, text => send({ type: 'log', text })), captureOutput(target.stderr!, launch.redactions, text => send({ type: 'log', text }))];
    target.once('spawn', () => { void send({ type: 'started', pid: target!.pid }); });
    target.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN';
      void fail(`Native command could not start (${code}).`);
    });
    // close may wait forever on a grandchild that inherited the output pipes.
    target.once('exit', (code, signal) => {
      void (async () => {
        // A grandchild may hold a pipe open. Bound draining before group cleanup.
        await Promise.race([Promise.all(output), new Promise(resolve => setTimeout(resolve, 250))]);
        if (!stopping) await send({ type: 'target-exit', code, signal });
        await stop();
      })();
    });
  }
});
process.on('disconnect', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('uncaughtException', () => { void fail('The native supervisor encountered an internal error.', true); });
process.on('unhandledRejection', () => { void fail('The native supervisor encountered an internal error.', true); });
void (async () => {
  const identity = process.platform === 'win32' ? { started: (await import('./windows.js')).windowsProcessStart() } : {};
  await send({ type: 'online', ...identity });
})();

async function fail(message: string, supervisor = false) {
  await send({ type: 'failure', code: supervisor ? 'SUPERVISOR_FAILED' : 'START_FAILED', message: message.slice(0, 1024) });
  await stop();
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  if (!committed) { process.exit(0); return; }
  if (process.platform === 'win32') {
    target?.kill();
    await Promise.race([Promise.all(output), new Promise(resolve => setTimeout(resolve, 250))]);
    process.exit(0); return; // The owner then terminates and verifies the entire job.
  }
  // The supervisor owns and remains the leader of this group until escalation.
  // It deliberately survives TERM long enough to send KILL to stubborn members.
  const killTimer = setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); }
    catch { process.exit(1); }
  }, 500);
  try { process.kill(-process.pid, 'SIGTERM'); }
  catch {
    // Not a group leader (an embedder started this supervisor inside its own group): signal only the
    // command. The embedder's stop() removes anything left.
    clearTimeout(killTimer);
    target?.kill('SIGTERM');
    setTimeout(() => { target?.kill('SIGKILL'); process.exit(0); }, 500);
  }
}

function send(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected || !process.send) { resolve(); return; }
    process.send(message, () => resolve());
  });
}

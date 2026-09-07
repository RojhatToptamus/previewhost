import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

// Process-group and owner-IPC behavior derives from Task Monki (MIT); see NOTICE.

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
const deadline = setTimeout(() => { void stop(); }, 5_000);

process.on('message', (value: Record<string, unknown>) => {
  if (value?.type === 'stop') { void stop(); return; }
  if (stopping) return;
  if (value?.type === 'configure' && !launch && !committed) {
    if (!Array.isArray(value.command) || !value.command.length || !value.command.every((item) => typeof item === 'string') ||
      typeof value.cwd !== 'string' || !value.env || typeof value.env !== 'object' || !Array.isArray(value.redactions)) {
      void fail('The supervisor received an invalid launch contract.'); return;
    }
    launch = value as unknown as Launch;
    void send({ type: 'configured' });
  } else if (value?.type === 'commit' && launch && !committed) {
    committed = true;
    clearTimeout(deadline);
    target = spawn(launch.command[0], launch.command.slice(1), {
      cwd: launch.cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    });
    capture(target.stdout!, launch.redactions);
    capture(target.stderr!, launch.redactions);
    target.once('spawn', () => { void send({ type: 'started', pid: target!.pid }); });
    target.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN';
      void fail(`Native command could not start (${code}).`);
    });
    // close may wait forever on a grandchild that inherited the output pipes.
    target.once('exit', (code, signal) => {
      if (!stopping) void send({ type: 'target-exit', code, signal });
      void stop();
    });
  }
});
process.on('disconnect', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('uncaughtException', () => { void fail('The native supervisor encountered an internal error.'); });
process.on('unhandledRejection', () => { void fail('The native supervisor encountered an internal error.'); });
void send({ type: 'online' });

async function fail(message: string) {
  await send({ type: 'failure', message: message.slice(0, 1024) });
  await stop();
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  if (!committed) { process.exit(0); return; }
  // The supervisor owns and remains the leader of this group until escalation.
  // It deliberately survives TERM long enough to send KILL to stubborn members.
  const killTimer = setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); }
    catch { process.exit(1); }
  }, 500);
  try { process.kill(-process.pid, 'SIGTERM'); }
  catch { clearTimeout(killTimer); process.exit(1); }
}

function send(message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected || !process.send) { resolve(); return; }
    process.send(message, () => resolve());
  });
}

function capture(readable: Readable, values: string[]) {
  const decoder = new StringDecoder('utf8');
  // Match the UTF-8 value delivered by spawn, including replacement characters
  // for malformed surrogate input; encodeURIComponent must never break cleanup.
  const secrets = [...new Set(values.filter(Boolean).flatMap((raw) => {
    const value = Buffer.from(raw).toString('utf8');
    return [value, encodeURIComponent(value)];
  }))].sort((a, b) => b.length - a.length);
  const pattern = secrets.length ? new RegExp(secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
  const carrySize = Math.max(0, ...secrets.map((value) => value.length - 1));
  let pending = '';
  let writes = Promise.resolve();

  async function append(value: string, final = false) {
    const text = pending + value;
    let end = completeCodePointEnd(text, final ? text.length : Math.max(0, text.length - carrySize));
    const parts: string[] = [];
    let position = 0;
    if (pattern) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match && match.index < end; match = pattern.exec(text)) {
        parts.push(text.slice(position, match.index), '[REDACTED]');
        position = match.index + match[0].length;
        end = Math.max(end, position);
      }
    }
    parts.push(text.slice(position, end));
    pending = text.slice(end);
    const output = parts.join('');
    for (let offset = 0; offset < output.length;) {
      const end = completeCodePointEnd(output, Math.min(output.length, offset + 16_384));
      await send({ type: 'log', text: output.slice(offset, end) });
      offset = end;
    }
  }

  readable.on('data', (chunk: Buffer) => {
    readable.pause();
    writes = writes.then(() => append(decoder.write(chunk))).finally(() => readable.resume());
  });
  readable.once('end', () => {
    writes = writes.then(() => append(decoder.end(), true));
  });
}

function completeCodePointEnd(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

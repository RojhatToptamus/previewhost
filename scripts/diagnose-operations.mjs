// Disposable preload for the second CI diagnosis. Never log arguments, results or errors.
// Build both outputs first, then load this absolute file with NODE_OPTIONS=--import=... .
// Native supervised commands intentionally do not inherit NODE_OPTIONS.
import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const started = performance.now();
const cpuStarted = process.cpuUsage();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let sequence = 0;
const output = process.env.PREVIEWHOST_DIAG_DIR
  ? openSync(join(process.env.PREVIEWHOST_DIAG_DIR, `operations-${process.pid}.jsonl`), 'wx', 0o600) : 2;

function emit(value) {
  // A diagnostic-output failure must not replace an application's result or error.
  try { writeSync(output, `OP_DIAG ${JSON.stringify({ pid: process.pid, ...value })}\n`); } catch {}
}

function timed(label, operation) {
  const seq = ++sequence;
  const before = performance.now();
  emit({ label, seq, event: 'begin', at: Date.now() });
  const finish = event => emit({ label, seq, event, at: Date.now(), elapsedMs: Math.round((performance.now() - before) * 1000) / 1000 });
  try {
    const result = operation();
    if (result && typeof result.then === 'function') {
      return result.then(value => { finish('end'); return value; }, error => { finish('error'); throw error; });
    }
    finish('end');
    return result;
  } catch (error) { finish('error'); throw error; }
}

function route(method, path) {
  if (method === 'GET' && path === '/info') return 'info';
  if (method === 'GET' && /^\/images\/json(?:\?|$)/.test(path)) return 'image.list';
  if (method === 'GET' && /^\/images\/[^/]+\/json(?:\?|$)/.test(path)) return 'image.inspect';
  if (method === 'POST' && path === '/volumes/create') return 'volume.create';
  if (method === 'GET' && path.startsWith('/volumes/')) return 'volume.inspect';
  if (method === 'DELETE' && path.startsWith('/volumes/')) return 'volume.remove';
  if (method === 'POST' && /^\/containers\/create(?:\?|$)/.test(path)) return 'container.create';
  if (method === 'GET' && /^\/containers\/[^/]+\/json(?:\?|$)/.test(path)) return 'container.inspect';
  if (method === 'POST' && /^\/containers\/[^/]+\/start(?:\?|$)/.test(path)) return 'container.start';
  if (method === 'POST' && /^\/containers\/[^/]+\/wait(?:\?|$)/.test(path)) return 'container.wait';
  if (method === 'POST' && /^\/containers\/[^/]+\/kill(?:\?|$)/.test(path)) return 'container.kill';
  if (method === 'DELETE' && path.startsWith('/containers/')) return 'container.remove';
  return 'other';
}

for (const [source, file] of [['test-build', '../.local/test-build/docker.js'], ['dist', '../dist/docker.js']]) {
  const { Docker } = await import(new URL(file, import.meta.url));
  const request = Docker.prototype.request;
  Docker.prototype.request = function (...args) {
    return timed(`docker.${source}.${route(args[0], args[1])}`, () => request.apply(this, args));
  };
  const attach = Docker.prototype.attach;
  Docker.prototype.attach = function (...args) {
    return timed(`docker.${source}.attach`, () => attach.apply(this, args));
  };
}

const { Client } = createRequire(import.meta.url)('pg');
for (const method of ['connect', 'query', 'end']) {
  const original = Client.prototype[method];
  Client.prototype[method] = function (...args) {
    // Callback and custom Query APIs are outside this promise-only probe.
    if (args.some(value => typeof value === 'function') || method === 'query' &&
        (args[0]?.callback || typeof args[0]?.submit === 'function')) return original.apply(this, args);
    return timed(`pg.${method}`, () => original.apply(this, args));
  };
}

process.once('exit', () => {
  loop.disable();
  const cpu = process.cpuUsage(cpuStarted);
  const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  emit({ label: 'process.summary', event: 'exit', at: Date.now(), operations: sequence,
    elapsedMs: round(performance.now() - started), cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000),
    eventLoopP99Ms: round(loop.percentile(99) / 1e6), eventLoopMaxMs: round(loop.max / 1e6) });
  if (output !== 2) closeSync(output);
});

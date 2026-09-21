// Disposable diagnostic probe. Logs duration categories only, never request data or credentials.
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const started = performance.now();
const cpuStarted = process.cpuUsage();
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
const counters = new Map();
function record(key, milliseconds, failed) {
  const row = counters.get(key) ?? { count: 0, sumMs: 0, maxMs: 0, errors: 0 };
  row.count++; row.sumMs += milliseconds; row.maxMs = Math.max(row.maxMs, milliseconds); row.errors += Number(failed);
  counters.set(key, row);
}
function wrap(target, method, label) {
  const original = target[method];
  if (typeof original !== 'function') return;
  target[method] = function (...args) {
    const key = typeof label === 'function' ? label(...args) : label;
    const before = performance.now();
    let value;
    try { value = original.apply(this, args); }
    catch (error) { record(key, performance.now() - before, true); throw error; }
    if (value?.then) return value.then(result => { record(key, performance.now() - before, false); return result; }, error => { record(key, performance.now() - before, true); throw error; });
    record(key, performance.now() - before, false); return value;
  };
}
const temporary = join(tmpdir(), `previewhost-duration-probe-${process.pid}`);
const handle = await open(temporary, 'wx', 0o600);
wrap(Object.getPrototypeOf(handle), 'sync', 'host.file-or-directory.fsync');
await handle.close(); await unlink(temporary);
const { DatabaseSync, StatementSync } = createRequire(import.meta.url)('node:sqlite');
wrap(DatabaseSync.prototype, 'exec', sql => {
  const first = sql.trim().split(/\s+/)[0].toUpperCase();
  return `sqlite.exec.${['PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK'].includes(first) ? first : 'other'}`;
});
wrap(StatementSync.prototype, 'run', 'sqlite.statement.run');
const { Docker } = await import(pathToFileURL(resolve('.local/test-build/docker.js')));
const { Keystore } = await import(pathToFileURL(resolve('.local/test-build/keystore.js')));
wrap(Docker, 'connect', 'docker.connect');
for (const method of ['unlock', 'open', 'get', 'add', 'set', 'remove', 'transaction']) wrap(Keystore.prototype, method, `keystore.${method}`);
wrap(Docker.prototype, 'request', (method, path) => {
  let route = 'other';
  if (path === '/info') route = 'info';
  else if (path.startsWith('/images/')) route = 'images';
  else if (path === '/volumes/create') route = 'volume.create';
  else if (path.startsWith('/volumes/')) route = 'volume';
  else if (path.startsWith('/containers/create')) route = 'container.create';
  else if (path.startsWith('/containers/')) route = path.includes('/wait?') ? 'container.wait' : path.endsWith('/json') ? 'container.inspect' : path.endsWith('/start') ? 'container.start' : path.endsWith('/kill') ? 'container.kill' : 'container.remove';
  return `docker.${method}.${route}`;
});
wrap(Docker.prototype, 'attach', 'docker.attach');
process.once('exit', () => {
  loop.disable();
  const cpu = process.cpuUsage(cpuStarted);
  const round = n => Math.round(n * 1000) / 1000;
  for (const row of counters.values()) { row.sumMs = round(row.sumMs); row.maxMs = round(row.maxMs); }
  console.error('DURATION_PROBE ' + JSON.stringify({ pid: process.pid, testChild: Boolean(process.env.NODE_TEST_CONTEXT), elapsedMs: round(performance.now() - started), cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000), eventLoopP99Ms: round(loop.percentile(99) / 1e6), eventLoopMaxMs: round(loop.max / 1e6), counters: Object.fromEntries(counters) }));
});

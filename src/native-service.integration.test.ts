import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import type { PreviewSpec, PreviewStatus } from './contracts.js';

type Environment = Extract<PreviewSpec, { type: 'environment' }>;
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'previewhost native lifecycle '));
  await fs.writeFile(path.join(directory, 'index.html'), 'application');
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => true });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, runtime };
}
async function result(runtime: PreviewRuntime, status: PreviewStatus) {
  return runtime.wait(status.name, status.candidate!.id, { timeoutMs: 30000 });
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, 'Lifecycle did not settle'); await delay(25); }
}

test('exclusive workers never overlap and a failed or canceled replacement restores the serving worker', async t => {
  const { directory, runtime } = await fixture(t);
  await fs.writeFile(path.join(directory, 'worker.mjs'), `
import fs from 'node:fs';
const lock = fs.openSync('worker.lock', 'wx');
fs.writeFileSync(lock, String(process.pid));
process.once('SIGTERM', () => { fs.closeSync(lock); fs.unlinkSync('worker.lock'); process.exit(0); });
console.log('worker running');
setInterval(() => {}, 1000);
`);
  const spec = (probe = "if(!require('fs').existsSync('worker.lock'))process.exit(1)"): Environment => ({
    name: 'exclusive', type: 'environment', primary: 'web', services: {
      web: { type: 'static', directory },
      worker: { type: 'worker', cwd: directory, command: [process.execPath, 'worker.mjs'],
        ready: { type: 'command', command: [process.execPath, '-e', probe], timeoutMs: 1000 } },
    },
  });
  const first = await result(runtime, await runtime.start(spec()));
  assert.equal(first.state, 'ready', JSON.stringify(first));
  const pid = await fs.readFile(path.join(directory, 'worker.lock'), 'utf8');
  const failed = await result(runtime, await runtime.replace('exclusive', spec('process.exit(8)')));
  assert.equal(failed.state, 'failed');
  assert.equal((await runtime.get('exclusive')).active!.id, first.id);
  assert.notEqual(await fs.readFile(path.join(directory, 'worker.lock'), 'utf8'), pid);
  assert.equal(await (await fetch(first.url!)).text(), 'application');
  const replacement = await runtime.replace('exclusive', spec('setTimeout(()=>{}, 30000)'));
  await until(async () => (await runtime.get('exclusive')).candidate?.services?.worker.state === 'starting');
  await runtime.cancel('exclusive', replacement.candidate!.id);
  assert.equal((await runtime.get('exclusive')).latest!.state, 'canceled');
  assert.equal((await runtime.get('exclusive')).active!.services!.worker.state, 'ready');
  const next = await result(runtime, await runtime.replace('exclusive', spec()));
  assert.equal(next.state, 'ready', JSON.stringify(next));
  assert.equal(next.url, first.url);
  await runtime.stop('exclusive');
  await assert.rejects(fs.stat(path.join(directory, 'worker.lock')), { code: 'ENOENT' });
});

test('named ports stay stable through bounded restarts and noncritical worker liveness failure leaves HTTP serving', async t => {
  const { directory, runtime } = await fixture(t);
  await fs.writeFile(path.join(directory, 'live'), 'yes');
  await fs.writeFile(path.join(directory, 'server.mjs'), `
import fs from 'node:fs'; import http from 'node:http';
const count=Number(fs.existsSync('count')?fs.readFileSync('count','utf8'):0)+1; fs.writeFileSync('count',String(count));
http.createServer((req,res)=>{if(req.url==='/crash'){res.end('bye');setTimeout(()=>process.exit(8),10)}else res.end(process.env.METRICS_PORT)}).listen(Number(process.env.PORT),'127.0.0.1');
http.createServer((req,res)=>res.end('metrics')).listen(Number(process.env.METRICS_PORT),'127.0.0.1');
`);
  const spec: Environment = { name: 'native', type: 'environment', primary: 'web', routes: { metrics: { service: 'web', port: 'metrics' } }, services: {
    web: { type: 'command', cwd: directory, command: [process.execPath, 'server.mjs'], ports: { http: 'PORT', metrics: 'METRICS_PORT' },
      ready: { type: 'tcp', port: 'metrics' }, restart: { mode: 'on-failure', maxRestarts: 1, backoffMs: 10 } },
    worker: { type: 'worker', cwd: directory, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], critical: false, overlap: 'safe',
      ready: { type: 'command', command: [process.execPath, '-e', 'process.exit(0)'] },
      liveness: { intervalMs: 100, failureThreshold: 1, probe: { type: 'command', timeoutMs: 1000,
        command: [process.execPath, '-e', "process.exit(require('fs').existsSync('live')?0:1)"] } } },
    consumer: { type: 'job', cwd: directory, command: [process.execPath, '-e', "fetch(process.env.METRICS).then(r=>r.text()).then(t=>{if(t!=='metrics')process.exit(1)})"],
      env: { METRICS: { service: 'web', port: 'metrics' } } },
  } };
  const first = await result(runtime, await runtime.start(spec));
  assert.equal(first.state, 'ready', JSON.stringify(first));
  const metrics = await new Promise<string>((resolve, reject) => {
    const request = http.get(first.url!, { headers: { host: `native--metrics.localhost:${new URL(first.url!).port}` } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve(text)); response.on('error', reject);
    });
    request.on('error', reject);
  });
  assert.equal(metrics, 'metrics');
  const port = await (await fetch(first.url!)).text();
  await fetch(`${first.url}/crash`);
  await until(async () => (await fs.readFile(path.join(directory, 'count'), 'utf8')) === '2' && (await runtime.get('native')).active?.services?.web.state === 'ready');
  assert.equal(await (await fetch(first.url!)).text(), port);
  await fs.unlink(path.join(directory, 'live'));
  await until(async () => (await runtime.get('native')).active?.services?.worker.state === 'failed');
  assert.equal((await fetch(first.url!)).status, 200);
  await fetch(`${first.url}/crash`);
  await until(async () => !(await runtime.get('native')).active);
  assert.equal(await fs.readFile(path.join(directory, 'count'), 'utf8'), '2');
});

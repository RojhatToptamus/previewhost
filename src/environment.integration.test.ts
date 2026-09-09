import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import { PreviewError } from './errors.js';
import type { PreviewSpec, PreviewStatus } from './contracts.js';

type EnvironmentInput = Extract<PreviewSpec, { type: 'environment' }>;
const app = `
import http from 'node:http';
import fs from 'node:fs';
fs.appendFileSync(process.env.PID_JOURNAL, process.pid + '\\n');
const started = Date.now();
if (process.env.TOKEN) console.log(process.env.TOKEN);
const server = http.createServer(async (req,res) => {
  try {
    if (req.url === '/crash') { res.end('bye'); setTimeout(() => process.exit(9), 10); return; }
    if (req.url === '/redirect') { res.writeHead(302,{location:'http://' + req.headers.host + '/state'}); res.end(); return; }
    const dependencies = {};
    for (const key of ['API_URL','REPORT_URL']) if (process.env[key]) {
      const response = await fetch(process.env[key] + '/state');
      dependencies[key] = await response.json();
      if (dependencies[key].revision !== process.env.REVISION) throw new Error('Candidate received a different revision');
    }
    const ready = Date.now() - started >= Number(process.env.READY_DELAY || 0);
    res.writeHead(req.url === '/ready' && !ready ? 503 : 200, {'content-type':'application/json'});
    res.end(JSON.stringify({revision:process.env.REVISION, pid:process.pid, dependencies,
      hasToken:!!process.env.TOKEN, origin:process.env.ALLOWED_ORIGIN, publicApi:process.env.PUBLIC_API,
      forwardedHost:req.headers['x-forwarded-host'], cwd:process.cwd()}));
  } catch { res.writeHead(503); res.end('Dependency unavailable'); }
});
server.listen(Number(process.env.PORT), process.env.HOST);
if (process.env.EXIT_AFTER) setTimeout(() => process.exit(8), Number(process.env.EXIT_AFTER));
`;

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'previewhost multi repo '));
  const journal = path.join(directory, 'pids');
  await fs.writeFile(journal, '');
  for (const id of ['web', 'api', 'report']) {
    await fs.mkdir(path.join(directory, `${id} repository`));
    await fs.writeFile(path.join(directory, `${id} repository`, 'server.mjs'), app);
  }
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], inputs: { TEST_TOKEN: 'scoped-secret-for-api' }, authorize: () => true });
  t.after(async () => {
    await runtime.close();
    for (const pid of (await fs.readFile(journal, 'utf8')).trim().split('\n').filter(Boolean).map(Number)) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Fixture process ${pid} remained after runtime.close()`);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const spec = (revision = 'v1', name = 'shop'): EnvironmentInput => ({
    type: 'environment', name, primary: 'web', timeoutMs: 10_000,
    services: {
      api: { type: 'command', cwd: path.join(directory, 'api repository'), command: [process.execPath, 'server.mjs'], readyPath: '/ready',
        env: { REVISION: revision, PID_JOURNAL: journal, TOKEN: { fromEnv: 'TEST_TOKEN' }, ALLOWED_ORIGIN: { browserUrl: 'web' } } },
      report: { type: 'command', cwd: path.join(directory, 'report repository'), command: [process.execPath, 'server.mjs'], readyPath: '/ready',
        env: { REVISION: revision, PID_JOURNAL: journal, API_URL: { service: 'api' } } },
      web: { type: 'command', cwd: path.join(directory, 'web repository'), command: [process.execPath, 'server.mjs'], readyPath: '/ready',
        env: { REVISION: revision, PID_JOURNAL: journal, API_URL: { service: 'api' }, REPORT_URL: { service: 'report' }, PUBLIC_API: { browserUrl: 'api' } } },
    },
  });
  return { runtime, spec, directory, journal };
}

async function outcome(runtime: PreviewRuntime, started: PreviewStatus) {
  assert.ok(started.candidate);
  return runtime.wait(started.name, started.candidate.id);
}
async function ready(runtime: PreviewRuntime, started: PreviewStatus) {
  const result = await outcome(runtime, started);
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.ok(result.url);
  return result;
}
function request(url: string, pathname = '/state'): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const origin = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: origin.port, path: pathname, headers: { host: origin.host } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      res.once('error', reject);
    });
    req.once('error', reject);
  });
}
async function until(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true');
    await delay(20);
  }
}

// This scenario verifies real dependency traffic and process ownership, not just a projected graph.
test('multi-repo replacement checks candidate backends while all public routes retain the old application', async (t) => {
  const { runtime, spec } = await fixture(t);
  const first = await ready(runtime, await runtime.start(spec()));
  const web = JSON.parse((await request(first.url!)).text);
  assert.equal(web.revision, 'v1');
  assert.equal(web.dependencies.API_URL.revision, 'v1');
  assert.equal(web.dependencies.REPORT_URL.dependencies.API_URL.revision, 'v1');
  assert.equal(web.hasToken, false);
  assert.equal(web.dependencies.API_URL.hasToken, true);
  assert.match(web.cwd, /web repository$/);
  const apiUrl = first.services!.api.browserUrl!;
  const webUrl = first.services!.web.browserUrl!;
  assert.equal(web.dependencies.API_URL.origin, webUrl);
  assert.equal(web.publicApi, apiUrl);
  const redirect = await request(apiUrl, '/redirect');
  assert.equal(redirect.headers.location, `${apiUrl}/state`);
  assert.equal(JSON.parse((await request(apiUrl)).text).forwardedHost, new URL(apiUrl).host);
  const inspected = JSON.stringify(await runtime.inspect(spec()));
  assert.ok(!inspected.includes('scoped-secret-for-api'));
  assert.ok(!JSON.stringify(await runtime.get('shop')).includes('scoped-secret-for-api'));
  assert.ok(!(await runtime.logs('shop')).text.includes('scoped-secret-for-api'));

  const secondSpec = spec('v2');
  if (secondSpec.services.web.type === 'command') secondSpec.services.web.env!.READY_DELAY = '750';
  const second = await runtime.replace('shop', secondSpec);
  await until(async () => (await runtime.get('shop')).candidate?.services?.web.state === 'starting');
  assert.equal(JSON.parse((await request(apiUrl)).text).revision, 'v1');
  assert.equal(JSON.parse((await request(webUrl)).text).revision, 'v1');
  const replaced = await ready(runtime, second);
  assert.equal(replaced.url, first.url);
  const newWeb = JSON.parse((await request(webUrl)).text);
  assert.equal(newWeb.revision, 'v2');
  assert.equal(newWeb.dependencies.API_URL.revision, 'v2');
  assert.equal(newWeb.dependencies.REPORT_URL.revision, 'v2');
  assert.equal(JSON.parse((await request(apiUrl)).text).revision, 'v2');

  const bad = spec('v3');
  if (bad.services.web.type === 'command') { bad.services.web.env!.READY_DELAY = '5000'; bad.services.web.timeoutMs = 150; }
  const failed = await outcome(runtime, await runtime.replace('shop', bad));
  assert.equal(failed.state, 'failed', JSON.stringify(failed));
  assert.equal(failed.services!.web.state, 'failed');
  assert.equal((await runtime.get('shop')).active?.id, replaced.id);
  assert.equal(JSON.parse((await request(apiUrl)).text).revision, 'v2');

  const cancelSpec = spec('v4');
  if (cancelSpec.services.web.type === 'command') cancelSpec.services.web.env!.READY_DELAY = '5000';
  const candidate = await runtime.replace('shop', cancelSpec);
  await until(async () => (await runtime.get('shop')).candidate?.services?.web.state === 'starting');
  await assert.rejects(runtime.cancel('shop', replaced.id), (error: unknown) => error instanceof PreviewError && error.code === 'STALE_ATTEMPT');
  await runtime.cancel('shop', candidate.candidate!.id);
  assert.equal((await runtime.wait('shop', candidate.candidate!.id)).state, 'canceled');
  assert.equal(JSON.parse((await request(webUrl)).text).revision, 'v2');
  await runtime.stop('shop');
  await assert.rejects(request(first.url!));
});

test('a prerequisite exit during later readiness fails and cleans the whole candidate', async (t) => {
  const { runtime, spec } = await fixture(t);
  const input = spec();
  if (input.services.api.type === 'command') input.services.api.env!.EXIT_AFTER = '500';
  if (input.services.web.type === 'command') input.services.web.env!.READY_DELAY = '3000';
  const result = await outcome(runtime, await runtime.start(input));
  assert.equal(result.state, 'failed', JSON.stringify(result));
  assert.match(result.error!.message, /api/);
  assert.equal(result.services!.api.state, 'failed');
  assert.equal((await runtime.get('shop')).active, undefined);
  assert.equal((await runtime.get('shop')).url, undefined);
});

test('an attached alias feeds native consumers and survives consumer failure, cancellation and stop', async (t) => {
  const { runtime, spec } = await fixture(t);
  const hostLabel = 'external-service-with-a-long-task-and-worktree-name-for-testing';
  const external = http.createServer((incoming, response) => {
    if (incoming.headers.host !== `${hostLabel}.localhost:${(external.address() as import('node:net').AddressInfo).port}`) {
      response.writeHead(421); response.end(); return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ revision: 'v1' }));
  });
  await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => external.close(() => resolve())));
  const externalUrl = `http://${hostLabel}.localhost:${(external.address() as import('node:net').AddressInfo).port}`;
  const attached = spec();
  attached.services.api = { type: 'attach', url: externalUrl, readyPath: '/ready' };
  const first = await ready(runtime, await runtime.start(attached));
  assert.equal(JSON.parse((await request(first.url!)).text).dependencies.API_URL.revision, 'v1');
  const bad = structuredClone(attached);
  if (bad.services.web.type === 'command') bad.services.web.env!.REVISION = 'wrong';
  bad.timeoutMs = 250;
  assert.equal((await outcome(runtime, await runtime.replace('shop', bad))).state, 'failed');
  const canceled = await runtime.replace('shop', attached);
  await runtime.cancel('shop', canceled.candidate!.id);
  await runtime.stop('shop');
  assert.equal((await request(externalUrl)).status, 200);
  assert.equal(external.listening, true);
});

test('pending environment nodes reserve the global capacity before authorization completes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'previewhost-capacity-'));
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: () => new Promise<boolean>(() => {}) });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const input = (name: string): EnvironmentInput => ({
    name, type: 'environment', primary: 'web', services: Object.fromEntries([
      ['web', { type: 'static', directory }],
      ...Array.from({ length: 15 }, (_, index) => [`service-${index}`, { type: 'static', directory }]),
    ]),
  });
  for (let index = 0; index < 8; index++) await runtime.start(input(`task-${index}`));
  await assert.rejects(runtime.start(input('excess')), (error: unknown) => error instanceof PreviewError && error.code === 'BUSY');
  await runtime.stop('task-0');
  const admitted = await runtime.start(input('replacement'));
  assert.ok(admitted.candidate);
});

test('the environment deadline bounds a graph and missing inputs or cycles execute no services', async (t) => {
  const { runtime, spec, journal, directory } = await fixture(t);
  const cyclic = spec();
  if (cyclic.services.api.type === 'command') cyclic.services.api.env!.BACK = { service: 'web' };
  await assert.rejects(runtime.start(cyclic), (error: unknown) => error instanceof PreviewError && error.code === 'INVALID_INPUT');
  await assert.rejects(runtime.start({ name: 'invalid-alias', type: 'environment', primary: 'web-', services: {
    'web-': { type: 'command', cwd: directory, command: [process.execPath, '-e', 'process.exit(0)'] },
  } }), { code: 'INVALID_INPUT' });
  const missing = spec();
  if (missing.services.api.type === 'command') missing.services.api.env!.TOKEN = { fromEnv: 'UNSELECTED' };
  assert.equal((await outcome(runtime, await runtime.start(missing))).state, 'failed');
  assert.equal(await fs.readFile(journal, 'utf8'), '');
  const deadline = spec();
  deadline.timeoutMs = 150;
  if (deadline.services.api.type === 'command') deadline.services.api.env!.READY_DELAY = '3000';
  const failed = await outcome(runtime, await runtime.start(deadline));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error!.code, 'TIMEOUT');
  assert.equal((await runtime.get('shop')).url, undefined);
});

test('owned service loss stops its environment and leaves a concurrent environment available', async (t) => {
  const { runtime, spec } = await fixture(t);
  const one = await ready(runtime, await runtime.start(spec('v1', 'one')));
  const two = await ready(runtime, await runtime.start(spec('v2', 'two')));
  await request(one.services!.api.browserUrl!, '/crash');
  await until(async () => {
    const status = await runtime.get('one');
    return !status.busy && !status.active && !status.url;
  });
  assert.equal((await runtime.get('one')).latest?.state, 'failed');
  assert.equal(JSON.parse((await request(two.url!)).text).revision, 'v2');
  assert.equal((await runtime.get('two')).active?.id, two.id);
});

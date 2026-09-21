import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { createPreviewRuntime, type PreviewRuntime } from '../runtime.js';
import { PreviewError } from '../errors.js';
import type { PreviewSpec, PreviewStatus, RuntimeOptions } from '../contracts.js';
import { testKeystore } from './keystore.js';
import { traceStep } from './diagnosis.js';

export type Spec = Extract<PreviewSpec, { type: 'environment' }>;

const dockerSocket = process.env.PREVIEWHOST_TEST_DOCKER_SOCKET;

export const database = { skip: process.platform !== 'darwin' || !dockerSocket, timeout: 120_000 };

export async function outcome(runtime: PreviewRuntime, started: PreviewStatus) {
  for (;;) {
    try {
      // Exercise pending observation windows without extending startup or repeating effects.
      return await runtime.wait(started.name, started.candidate!.id, { timeoutMs: 1000 });
    } catch (error) {
      if (!(error instanceof PreviewError) || error.code !== 'TIMEOUT') throw error;
    }
  }
}

export async function until(check: () => Promise<boolean>, signal = AbortSignal.timeout(10_000)) {
  while (!await check()) await delay(20, undefined, { signal });
}

export async function seedWaiting(f: Awaited<ReturnType<typeof databaseFixture>>, started: PreviewStatus, signal: AbortSignal) {
  await until(async () => {
    const status = await f.runtime.get(started.name);
    assert.equal(status.candidate?.id, started.candidate!.id, JSON.stringify(status.latest));
    return access(join(f.directory, 'waiting')).then(() => true, () => false);
  }, signal);
}

export const job = (cwd: string, script: string) => ({ type: 'job' as const, cwd, command: [process.execPath, '-e', script] });

export async function databaseFixture(t: TestContext, authorize: RuntimeOptions['authorize'] = () => true) {
  const directory = await traceStep(`${t.name}: fixture 01 directory`, async () => realpath(await mkdtemp(join(tmpdir(), 'previewhost-jobs-'))));
  let runtime: PreviewRuntime;
  t.after(async () => {
    if (runtime) {
      for (const p of await traceStep(`${t.name}: cleanup 01 list`, () => runtime.list())) {
        await traceStep(`${t.name}: cleanup 02 stop`, () => runtime.stop(p.name));
        if (p.data) await traceStep(`${t.name}: cleanup 03 delete data`, () => runtime.deleteData(p.name));
      }
      await traceStep(`${t.name}: cleanup 04 close runtime`, () => runtime.close());
    }
    await traceStep(`${t.name}: cleanup 05 remove directory`, () => rm(directory, { recursive: true, force: true }));
  });
  const keys = await traceStep(`${t.name}: fixture 02 keystore`, () => testKeystore(t));
  await traceStep(`${t.name}: fixture 03 add secret`, () => keys.store.add('user', 'disposable/jobs-seed', 'fake-job-secret-value'));
  const options = { allowedRoots: [directory], dataDirectory: join(directory, 'data'), dockerSocket, secretIds: ['disposable/jobs-seed'], authorize };
  runtime = await traceStep(`${t.name}: fixture 04 create runtime`, () => createPreviewRuntime(options));
  const connection = `import {Client} from ${JSON.stringify(import.meta.resolve('pg'))}; const db=new Client({connectionString:process.env.DATABASE_URL}); await db.connect();`;
  await writeFile(join(directory, 'migrate.mjs'), connection + `await db.query('CREATE TABLE IF NOT EXISTS items (id serial primary key, label text)'); console.log('schema ready'); await db.end();`);
  await writeFile(join(directory, 'seed.mjs'), connection + `import fs from 'node:fs'; await db.query("INSERT INTO items(label) VALUES ('demo')"); console.log('seed wrote',process.env.TEST_TOKEN); const mode=fs.existsSync('mode')?fs.readFileSync('mode','utf8'):''; if(mode==='fail')process.exit(9); if(mode==='wait'){fs.writeFileSync('waiting','');await new Promise(()=>{});} await db.end();`);
  await writeFile(join(directory, 'api.mjs'), connection + `import http from 'node:http'; http.createServer(async(req,res)=>{try { if(req.method==='POST') await db.query("INSERT INTO items(label) VALUES ('user')"); const {rows}=await db.query('SELECT * FROM items ORDER BY id'); res.setHeader('content-type','application/json'); res.end(JSON.stringify(rows)); } catch {res.writeHead(503);res.end('Database not ready');}}).listen(Number(process.env.PORT),process.env.HOST);`);
  await writeFile(join(directory, 'web.mjs'), `import http from 'node:http'; http.createServer(async(req,res)=>{try {const r=await fetch(process.env.API_URL,{method:req.method});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());}catch{res.writeHead(503);res.end();}}).listen(Number(process.env.PORT),process.env.HOST);`);
  const spec: Spec = { name: 'job-data', type: 'environment', primary: 'web', timeoutMs: 60_000, services: {
    db: { type: 'postgres' },
    migrate: { type: 'job', cwd: directory, command: [process.execPath, 'migrate.mjs'], env: { DATABASE_URL: { service: 'db' } } },
    seed: { type: 'job', run: 'once', cwd: directory, command: [process.execPath, 'seed.mjs'], dependsOn: ['migrate'], env: { DATABASE_URL: { service: 'db' }, TEST_TOKEN: { secret: 'disposable/jobs-seed' } } },
    api: { type: 'command', cwd: directory, command: [process.execPath, 'api.mjs'], dependsOn: ['seed'], readyPath: '/health', env: { DATABASE_URL: { service: 'db' }, CORS_ORIGIN: { browserUrl: 'web' } } },
    web: { type: 'command', cwd: directory, command: [process.execPath, 'web.mjs'], env: { API_URL: { service: 'api' } } },
  } };
  return { directory, spec, keys, options, get runtime() { return runtime; }, async reconnect() {
    await traceStep(`${t.name}: reconnect 01 close runtime`, () => runtime.close());
    runtime = await traceStep(`${t.name}: reconnect 02 create runtime`, () => createPreviewRuntime(options));
  } };
}

export async function rows(url: string, method = 'GET') {
  return await (await fetch(url, { method })).json() as unknown[];
}

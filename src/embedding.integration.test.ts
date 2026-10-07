import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createPreviewRuntime, type PreviewRuntime } from './runtime.js';
import type { PreviewSpec, PreviewStatus, RuntimeOptions } from './contracts.js';
import { limits } from './contracts.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-embedding-'));
  const source = join(directory, 'source');
  await mkdir(source);
  await writeFile(join(source, 'server.cjs'), `require('http').createServer((q,r)=>r.end(require('fs').readFileSync('content.txt')+'|'+String(process.env.EMBEDDER_ONLY))).listen(Number(process.env.PORT),'127.0.0.1');`);
  await writeFile(join(source, 'content.txt'), 'first');
  const options: RuntimeOptions = { allowedRoots: [source], stateDirectory: join(directory, 'state'), keystoreDirectory: join(directory, 'keystore'), authorize: () => true };
  const spec: PreviewSpec = { name: 'app', type: 'command', cwd: source, command: [process.execPath, 'server.cjs'] };
  const runtimes: PreviewRuntime[] = [];
  t.after(async () => {
    for (const runtime of runtimes.toReversed()) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const create = async (input: RuntimeOptions = options) => {
    const runtime = await createPreviewRuntime(input); runtimes.push(runtime); return runtime;
  };
  return { directory, source, options, spec, create };
}

test('supervisor bootstrap failures retain redacted diagnostics before reporting failure', async t => {
  const { directory, source, options, spec, create } = await fixture(t);
  const launcher = join(directory, 'broken-supervisor.mjs');
  const secret = 'SYNTHETIC_bootstrap/a b';
  await writeFile(launcher, `
process.stderr.write('bootstrap: ' + process.env.PRIVATE_VALUE.slice(0, 9));
setTimeout(() => {
  process.stderr.write(process.env.PRIVATE_VALUE.slice(9) + '\\n');
  import('previewhost-intentionally-missing-dependency');
}, 10);
`);
  const runtime = await create({ ...options, supervisor: {
    executable: process.execPath, module: launcher, env: { PRIVATE_VALUE: secret },
  } });
  const pending = await runtime.start(spec);
  const failed = await runtime.wait('app', pending.candidate!.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error?.code, 'SUPERVISOR_FAILED');
  const logs = await runtime.logs('app', failed.id);
  assert.match(logs.text, /ERR_MODULE_NOT_FOUND/);
  assert.match(logs.text, /previewhost-intentionally-missing-dependency/);
  assert.match(logs.text, /bootstrap: \[REDACTED\]/);
  assert.equal(logs.text.includes(secret), false);
  assert.equal(logs.text.includes(secret.slice(0, 9)), false);
  assert.equal((await runtime.get('app')).cleanup, undefined);
  assert.equal(await readFile(join(source, 'content.txt'), 'utf8'), 'first');
});

test('embedded native launch isolates host settings and retains configuration without replay after restart', async t => {
  const { directory, source, options, spec, create } = await fixture(t);
  const launcher = join(directory, 'launcher.mjs');
  await writeFile(launcher, `if(process.env.EMBEDDER_ONLY!=='host')throw Error('missing host environment'); await import(${JSON.stringify(new URL('./supervisor.js', import.meta.url).href)});`);
  const runtime = await create({ ...options, supervisor: { executable: process.execPath, module: launcher, env: { EMBEDDER_ONLY: 'host' } } });

  const pending = await runtime.start(spec);
  const ready = await runtime.wait('app', pending.candidate!.id);
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.equal(await (await fetch(ready.url!)).text(), 'first|undefined');
  await writeFile(join(source, 'content.txt'), 'uncommitted edit');
  assert.equal(await (await fetch(ready.url!)).text(), 'uncommitted edit|undefined');
  await assert.rejects(createPreviewRuntime(options), { code: 'BUSY' });
  await runtime.close();
  const reopened = await create(options);
  const stopped = await reopened.get('app');
  assert.equal(stopped.active, undefined);
  assert.equal(stopped.latest?.id, ready.id);
  assert.equal(stopped.latest?.state, 'stopped');
  assert.equal(reopened.keystore.directory, await realpath(options.keystoreDirectory!));
  await assert.rejects(fetch(ready.url!));
  const restarted = await reopened.startAgain('app', ready.id);
  assert.equal((await reopened.wait('app', restarted.candidate!.id)).state, 'ready');
  await reopened.stop('app');
  await reopened.remove('app', restarted.candidate!.id);
  assert.deepEqual(await reopened.list(), []);
});

test('profile keystores behind directory aliases are excluded from static serving', async t => {
  const { directory, source, options, create } = await fixture(t);
  const alias = join(directory, 'alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = await create({ ...options, keystoreDirectory: join(alias, 'vault') });

  const password = 'SYNTHETIC_profile_password';
  await runtime.keystore.unlock({ password, confirmation: password, create: true });
  await runtime.keystore.set('user', 'test/dev/token', 'SYNTHETIC_value');
  const status = await runtime.start({ name: 'page', type: 'static', directory: source });
  const ready = await runtime.wait('page', status.candidate!.id);
  assert.equal(ready.state, 'ready');
  assert.equal((await fetch(`${ready.url}/vault/secrets.sqlite`)).status, 403);
});

test('restart cleans a surviving owned application after owner and supervisor loss without stopping a neighbor', { skip: process.platform === 'win32' }, async t => {
  const { directory, options, spec, create } = await fixture(t);
  const neighbor = await create({ allowedRoots: options.allowedRoots, keystoreDirectory: join(directory, 'neighbor-vault'), authorize: () => true });
  const neighborStart = await neighbor.start({ ...spec, name: 'neighbor' });
  const neighborReady = await neighbor.wait('neighbor', neighborStart.candidate!.id);
  assert.equal(neighborReady.state, 'ready');
  const ownerModule = join(directory, 'owner.mjs');
  await writeFile(ownerModule, `import {createPreviewRuntime} from ${JSON.stringify(new URL('./runtime.js', import.meta.url).href)};
    const runtime=await createPreviewRuntime({...${JSON.stringify(options)},authorize:()=>true});
    const status=await runtime.start(${JSON.stringify(spec)});
    process.send(await runtime.wait('app',status.candidate.id));`);
  const owner = fork(ownerModule, [], { silent: true, execArgv: [] });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  const ready = await Promise.race([
    once(owner, 'message').then(([value]) => value as PreviewStatus['active'] & { url: string }),
    once(owner, 'exit').then(() => { throw new Error('fixture owner exited before readiness'); }),
  ]);
  assert.equal(ready!.state, 'ready');
  const record = JSON.parse(await readFile(join(directory, 'state/app.json'), 'utf8'));
  const receipt = Object.values(record.processes)[0] as { supervisor: { pid: number; group: number }; command: { pid: number } };
  assert.ok(receipt.command.pid);
  process.kill(-receipt.supervisor.group, 'SIGSTOP');
  t.after(() => { try { process.kill(-receipt.supervisor.group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } });
  owner.kill('SIGKILL');
  await once(owner, 'exit');
  process.kill(receipt.supervisor.pid, 'SIGKILL');
  const recovered = await create(options);
  assert.equal((await recovered.get('app')).latest?.state, 'stopped');
  assert.equal((await recovered.get('app')).cleanup, undefined);
  await assert.rejects(fetch(ready!.url, { signal: AbortSignal.timeout(1000) }));
  assert.equal(await (await fetch(neighborReady.url!)).text(), 'first|undefined');
  const clean = JSON.parse(await readFile(join(directory, 'state/app.json'), 'utf8'));
  assert.deepEqual(clean.processes, {});
});

test('failed replacement remains the accepted configuration after stop and owner restart', async t => {
  const { source, options, spec, create } = await fixture(t);
  const runtime = await create();
  const first = await runtime.start(spec);
  assert.equal((await runtime.wait('app', first.candidate!.id)).state, 'ready');
  await writeFile(join(source, 'replacement.cjs'), 'process.exit(7);');
  const replacement = { ...spec, command: [process.execPath, 'replacement.cjs'] };
  const update = await runtime.replace('app', replacement);
  const failed = await runtime.wait('app', update.candidate!.id);
  assert.equal(failed.state, 'failed');
  const stopped = await runtime.stop('app');
  assert.equal(stopped.latest?.id, failed.id);
  const description = (await runtime.describe('app', failed.id)).spec;
  assert.equal(description.type, 'command');
  if (description.type === 'command') assert.deepEqual(description.command, replacement.command);
  await runtime.close();
  const reopened = await create(options);
  assert.equal((await reopened.get('app')).latest?.id, failed.id);
  await writeFile(join(source, 'replacement.cjs'), `require('http').createServer((q,r)=>r.end('corrected replacement')).listen(+process.env.PORT,'127.0.0.1');`);
  const retry = await reopened.startAgain('app', failed.id);
  const ready = await reopened.wait('app', retry.candidate!.id);
  assert.equal(ready.state, 'ready');
  assert.equal(await (await fetch(ready.url!)).text(), 'corrected replacement');
});

test('source permissions cannot be released while shared and are reusable across successive captures', async t => {
  const { directory, create } = await fixture(t);
  const runtime = await create();
  for (let index = 0; index < 34; index++) {
    const source = join(await realpath(directory), `capture-${index}`);
    await mkdir(source); await writeFile(join(source, 'index.html'), String(index));
    await runtime.allowSources([source], new AbortController().signal);
    const pending = await runtime.start({ name: 'capture', type: 'static', directory: source });
    const ready = await runtime.wait('capture', pending.candidate!.id);
    assert.equal(ready.state, 'ready');
    assert.throws(() => runtime.releaseSources([source]), { code: 'BUSY' });
    assert.equal(await (await fetch(ready.url!)).text(), String(index));
    await runtime.stop('capture');
    runtime.releaseSources([source]);
    await rm(source, { recursive: true });
    assert.equal(runtime.sourceRoots().length, 1);
  }
});

test('connecting a source requires source permission and changes only the chosen service', async t => {
  const { directory, source, create } = await fixture(t);
  const other = join(directory, 'other-source');
  await mkdir(other);
  await writeFile(join(source, 'index.html'), 'original');
  await writeFile(join(other, 'index.html'), 'connected');
  const runtime = await create();
  const initial = await runtime.start({ name: 'sources', type: 'environment', primary: 'web', services: {
    web: { type: 'static', directory: source }, other: { type: 'static', directory: source }
  } });
  const ready = await runtime.wait('sources', initial.candidate!.id);
  assert.equal(ready.state, 'ready');
  const expected = { active: ready.id, candidate: null, latest: ready.id };
  const denied = await runtime.configureSource('sources', ready.id, 'web', other, expected);
  assert.equal((await runtime.wait('sources', denied.candidate!.id)).error?.code, 'SOURCE_DENIED');
  expected.latest = denied.candidate!.id;
  assert.equal(await (await fetch(ready.url!)).text(), 'original');
  await runtime.allowSources([other], new AbortController().signal);
  const changed = await runtime.configureSource('sources', ready.id, 'web', other, expected);
  const next = await runtime.wait('sources', changed.candidate!.id);
  assert.equal(next.state, 'ready');
  assert.equal(await (await fetch(next.url!)).text(), 'connected');
  const description = await runtime.describe('sources', next.id);
  assert.equal(description.spec.type, 'environment');
  if (description.spec.type === 'environment') {
    assert.equal(description.spec.services.other.type, 'static');
    if (description.spec.services.other.type === 'static') assert.equal(description.spec.services.other.directory, await realpath(source));
  }
  await assert.rejects(runtime.configureSource('sources', ready.id, 'web', source, expected), { code: 'STALE_ATTEMPT' });
});


test('held multi-service candidates expose their own HTTP routes and keep the serving environment until publication', async t => {
  const { source, create } = await fixture(t);
  const runtime = await create();
  const spec = (version: string): PreviewSpec => ({ name: 'design-services', type: 'environment', primary: 'web', services: {
    web: { type: 'command', cwd: source, command: [process.execPath, '-e', `require('http').createServer((q,r)=>r.end('${version}-web')).listen(+process.env.PORT,'127.0.0.1')`] },
    api: { type: 'command', cwd: source, command: [process.execPath, '-e', `require('http').createServer((q,r)=>r.end('${version}-api')).listen(+process.env.PORT,'127.0.0.1')`] }
  } });
  const first = await runtime.start(spec('serving'));
  const ready = await runtime.wait(first.name, first.candidate!.id);
  assert.equal(ready.state, 'ready');
  const next = await runtime.prepareCandidate(spec('candidate'));
  const candidate = await runtime.wait(next.name, next.candidate!.id);
  assert.equal(candidate.state, 'ready');
  const candidatePort = new URL(runtime.candidateUrl(next.name, candidate.id)).port;
  const readService = (url: string, port = new URL(url).port) => new Promise<string>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, headers: { host: `${new URL(url).hostname}:${port}` } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk); response.on('end', () => resolve(body)); response.on('error', reject);
    }).on('error', reject);
  });
  for (const id of ['web', 'api']) {
    const address = candidate.services![id].browserUrl!;
    assert.equal(await readService(address, candidatePort), `candidate-${id}`);
    assert.equal(await readService(address), `serving-${id}`);
  }
  await runtime.promote(next.name, candidate.id);
  for (const id of ['web', 'api']) assert.equal(await readService(candidate.services![id].browserUrl!), `candidate-${id}`);
  await assert.rejects(fetch(`http://127.0.0.1:${candidatePort}`));
});

test('verification candidates keep the serving app unchanged until exact promotion and can be canceled', async t => {
  const { source, options, create } = await fixture(t);
  const runtime = await create(options);
  await mkdir(join(source, 'old')); await mkdir(join(source, 'candidate'));
  await writeFile(join(source, 'old/index.html'), 'serving');
  await writeFile(join(source, 'candidate/index.html'), 'candidate');
  const spec = { name: 'design', type: 'static' as const, directory: join(source, 'old') };
  const initial = await runtime.prepareCandidate(spec);
  const serving = await runtime.wait('design', initial.candidate!.id);
  assert.equal(serving.state, 'ready', JSON.stringify(serving));
  const publicUrl = (await runtime.get('design')).url!;
  await assert.rejects(runtime.promote('design', serving.id, async () => {
    assert.equal(await (await fetch(publicUrl)).text(), 'serving');
    throw new Error('Initial settlement failed');
  }), /Initial settlement failed/);
  assert.equal((await runtime.get('design')).active, undefined);
  assert.equal((await fetch(publicUrl)).status, 503);
  assert.equal(await (await fetch(runtime.candidateUrl('design', serving.id))).text(), 'serving');
  await runtime.promote('design', serving.id);
  const held = await runtime.prepareCandidate({ ...spec, directory: join(source, 'candidate') });
  assert.equal((await runtime.wait('design', held.candidate!.id)).state, 'ready');
  assert.equal((await runtime.get('design')).active?.id, serving.id);
  assert.equal(await (await fetch(publicUrl)).text(), 'serving');
  const candidateUrl = runtime.candidateUrl('design', held.candidate!.id);
  assert.equal(await (await fetch(candidateUrl)).text(), 'candidate');
  await assert.rejects(runtime.replace('design', spec), { code: 'BUSY' });
  await assert.rejects(runtime.promote('design', serving.id), { code: 'STALE_ATTEMPT' });
  await runtime.cancel('design', held.candidate!.id);
  await assert.rejects(fetch(candidateUrl));
  assert.equal(await (await fetch(publicUrl)).text(), 'serving');
  const next = await runtime.prepareCandidate({ ...spec, directory: join(source, 'candidate') });
  await runtime.wait('design', next.candidate!.id);
  await assert.rejects(runtime.promote('design', next.candidate!.id, async () => {
    assert.equal(await (await fetch(publicUrl)).text(), 'candidate');
    throw new Error('SQLite settlement failed');
  }), /SQLite settlement failed/);
  assert.equal((await runtime.get('design')).active?.id, serving.id);
  assert.equal(await (await fetch(publicUrl)).text(), 'serving');
  const promoted = await runtime.promote('design', next.candidate!.id);
  assert.equal(promoted.active?.id, next.candidate!.id);
  assert.equal(promoted.url, publicUrl);
  assert.equal(await (await fetch(publicUrl)).text(), 'candidate');
  const final = await runtime.prepareCandidate(spec);
  await runtime.wait('design', final.candidate!.id);
  let settle!: () => void;
  const settlement = new Promise<void>(resolve => { settle = resolve; });
  const promotion = runtime.promote('design', final.candidate!.id, () => settlement);
  await assert.rejects(runtime.cancel('design', final.candidate!.id), { code: 'BUSY' });
  let stopped = false;
  const stopping = runtime.stop('design').then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  settle();
  await promotion;
  await stopping;
  assert.equal((await runtime.get('design')).active, undefined);
  await assert.rejects(fetch(publicUrl));
});

test('recent attempts retain exact job logs across restarts and expire at the bounded history limit', async t => {
  const { source, create } = await fixture(t);
  const runtime = await create();
  await writeFile(join(source, 'index.html'), 'ready');
  const ids: string[] = [];
  for (let index = 0; index < limits.attemptsPerPreview + 1; index++) {
    const pending = await runtime.start({ name: 'history', type: 'environment', primary: 'web', services: {
      job: { type: 'job', cwd: source, command: [process.execPath, '-e', `console.log('job-${index}')`] },
      web: { type: 'static', directory: source, dependsOn: ['job'] },
    } });
    ids.push(pending.candidate!.id);
    assert.equal((await runtime.wait('history', ids.at(-1)!)).state, 'ready');
    await runtime.stop('history');
  }
  assert.equal((await runtime.get('history')).history!.length, limits.attemptsPerPreview);
  assert.match((await runtime.logs('history', ids[1], { source: 'job' })).text, /job-1/);
  await assert.rejects(runtime.logs('history', ids[0]), { code: 'ATTEMPT_EXPIRED' });
});

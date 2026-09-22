import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadPreviewSpec, readPreviewSpec, resolvePreviewFile, savePreviewSpec } from './config.js';
import { limits, type PreviewSpec } from './contracts.js';
import { parseSpec } from './spec.js';

test('default configuration lookup accepts either filename, rejects conflicts, and leaves explicit files independent', async t => {
  const project = await mkdtemp(join(tmpdir(), 'previewhost defaults '));
  t.after(() => rm(project, { recursive: true, force: true }));
  const yaml = join(project, 'preview.yaml');
  const yml = join(project, 'preview.yml');
  assert.equal(await resolvePreviewFile(project), yaml);
  await assert.rejects(loadPreviewSpec(await resolvePreviewFile(project)), { code: 'INVALID_INPUT' });
  await writeFile(yml, 'name: short\ntype: static\ndirectory: .\n');
  assert.equal(await resolvePreviewFile(project), yml);
  assert.equal((await loadPreviewSpec(await resolvePreviewFile(project))).name, 'short');
  await writeFile(yaml, 'name: preferred\ntype: static\ndirectory: .\n');
  await assert.rejects(resolvePreviewFile(project), { code: 'INVALID_INPUT', message: /Both preview.yaml and preview.yml exist/ });
  assert.equal((await loadPreviewSpec(yaml)).name, 'preferred');
  assert.equal((await loadPreviewSpec(yml)).name, 'short');
  const spec = await readPreviewSpec(Readable.from(['{"name":"inline","type":"static","directory":"."}']), {
    baseDirectory: project, format: 'json', fallbackProject: project,
  });
  assert.equal(spec.name, 'inline');
  await assert.rejects(readPreviewSpec(Readable.from([' ']), {
    baseDirectory: project, format: 'json', fallbackProject: project,
  }), { code: 'INVALID_INPUT', message: /Both preview.yaml and preview.yml exist/ });
  await rm(yml);
  assert.equal(await resolvePreviewFile(project), yaml);
  await writeFile(yaml, 'services: [\n');
  await assert.rejects(loadPreviewSpec(await resolvePreviewFile(project)), { code: 'INVALID_INPUT' });
  await rm(yaml);
  await symlink(join(project, 'missing'), yaml);
  assert.equal(await resolvePreviewFile(project), yaml);
  await writeFile(yml, 'name: short\ntype: static\ndirectory: .\n');
  await assert.rejects(resolvePreviewFile(project), { code: 'INVALID_INPUT', message: /Both/ });
});

test('saving preserves preview.yml files, directories, and dangling symlinks without creating preview.yaml', async t => {
  const project = await mkdtemp(join(tmpdir(), 'previewhost save existing '));
  t.after(() => rm(project, { recursive: true, force: true }));
  const file = join(project, 'preview.yml');
  const spec: PreviewSpec = { name: 'site', type: 'static', directory: project };
  await writeFile(file, '# keep this configuration\n');
  await assert.rejects(savePreviewSpec(spec, { projectDirectory: project }), { code: 'ALREADY_EXISTS', message: /preview.yml/ });
  assert.equal(await readFile(file, 'utf8'), '# keep this configuration\n');
  await rm(file); await mkdir(file);
  await assert.rejects(savePreviewSpec(spec, { projectDirectory: project }), { code: 'ALREADY_EXISTS' });
  await rm(file, { recursive: true });
  await symlink(join(project, 'missing'), file);
  await assert.rejects(savePreviewSpec(spec, { projectDirectory: project }), { code: 'ALREADY_EXISTS' });
  assert.deepEqual(await readdir(project), ['preview.yml']);
});

test('JSON and YAML files produce the same environment with file-relative repositories and symbolic inputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost config '));
  const configDirectory = join(directory, 'config');
  await mkdir(configDirectory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const spec = { name: 'shop', type: 'environment', primary: 'web', services: {
    web: { type: 'static', directory: '../front end' },
    api: { type: 'command', cwd: '../back end', command: ['node', 'server.mjs'], env: {
      TOKEN: { fromEnv: 'API_TOKEN' }, DATABASE_URL: { service: 'database' }, WEB_ORIGIN: { browserUrl: 'web' },
    } },
    database: { type: 'postgres' },
  } };
  const json = join(configDirectory, 'preview.json'); const yaml = join(configDirectory, 'preview.yaml');
  await writeFile(json, JSON.stringify(spec));
  await writeFile(yaml, `# Separate repositories share one environment.
name: shop
type: environment
primary: web
services:
  web: {type: static, directory: '../front end'}
  api:
    type: command
    cwd: ../back end
    command: [node, server.mjs]
    env:
      TOKEN: {fromEnv: API_TOKEN}
      DATABASE_URL: {service: database}
      WEB_ORIGIN: {browserUrl: web}
  database: {type: postgres}
`);
  const result = await loadPreviewSpec(yaml);
  assert.deepEqual(result, await loadPreviewSpec(json));
  assert.equal(result.type, 'environment');
  if (result.type !== 'environment') throw new Error('Expected an environment');
  assert.deepEqual(result.services.web, { type: 'static', directory: resolve(directory, 'front end'), spa: false });
  const api = result.services.api;
  assert.equal(api.type, 'command');
  if (api.type !== 'command') throw new Error('Expected a command');
  assert.equal(api.cwd, resolve(directory, 'back end'));
  assert.deepEqual(api.env?.TOKEN, { fromEnv: 'API_TOKEN' });
  assert.deepEqual(api.env?.DATABASE_URL, { service: 'database' });
  assert.deepEqual(api.env?.WEB_ORIGIN, { browserUrl: 'web' });
});

test('explicit saves round-trip all spec kinds without resolving inputs and retain allowed external sources', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost save ')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const external = join(directory, 'external'); await mkdir(external);
  const project = join(directory, 'project'); await mkdir(project);
  const cases: PreviewSpec[] = [
    { name: 'static', type: 'static', directory: project, spa: true },
    { name: 'command', type: 'command', cwd: project, command: ['node', 'app.mjs', '--port', '{port}', '#literal'], env: {
      VALUE: { secret: 'shop/dev/token' }, INPUT: { fromEnv: 'MISSING_INPUT' }, NODE_ENV: 'development',
    } },
    { name: 'attached', type: 'attach', url: 'http://127.0.0.1:12345' },
    { name: 'environment', type: 'environment', primary: 'web', services: {
      web: { type: 'command', cwd: project, command: ['node', 'app.mjs'], env: { DB: { service: 'database' }, ORIGIN: { browserUrl: 'api' } } },
      api: { type: 'static', directory: external }, database: { type: 'external-postgres', url: { secret: 'shop/dev/database' } },
    } },
  ];
  for (const spec of cases) {
    const result = await savePreviewSpec(spec, { projectDirectory: project, allowedRoots: [directory] });
    assert.equal(result.file, join(project, 'preview.yaml'));
    assert.deepEqual(await loadPreviewSpec(result.file), parseSpec(spec));
    assert.deepEqual(result.externalSources, spec.type === 'environment' ? [external] : []);
    assert.ok(!(await readFile(result.file, 'utf8')).includes(project));
    await rm(result.file);
  }
});

test('save rejects invalid graphs, sources and cancellation before publication; failures leave no partial destination', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'previewhost save failure ')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'); await mkdir(source);
  const spec: PreviewSpec = { name: 'site', type: 'static', directory: source };
  const options = { projectDirectory: source };
  await assert.rejects(savePreviewSpec({ ...spec, directory }, options), { code: 'SOURCE_DENIED' });
  await assert.rejects(savePreviewSpec({ ...spec, directory: join(source, 'missing') }, options), { code: 'INVALID_INPUT' });
  await symlink(directory, join(source, 'escape'));
  await assert.rejects(savePreviewSpec({ ...spec, directory: join(source, 'escape') }, options), { code: 'SOURCE_DENIED' });
  await assert.rejects(savePreviewSpec({ name: 'cycle', type: 'environment', primary: 'web', services: {
    web: { type: 'command', cwd: source, command: ['false'], env: { URL: { service: 'web' } } },
  } }, options), { code: 'INVALID_INPUT' });
  await assert.rejects(savePreviewSpec(spec, { ...options, signal: AbortSignal.abort() }), { code: 'CLOSED' });
  const link = fs.link;
  t.mock.method(fs, 'link', async () => { throw new Error('FAKE_private-filesystem-error'); });
  const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
  try { await assert.rejects(savePreviewSpec(spec, options), { code: 'INVALID_INPUT', message: /Cannot save preview.yaml/ }); }
  finally { t.mock.method(fs, 'link', link); syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(source), ['escape']);
});

test('concurrent saves publish one complete file and preserve existing content, directories and symlink targets', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost save race ')));
  t.after(() => rm(project, { recursive: true, force: true }));
  const spec: PreviewSpec = { name: 'site', type: 'static', directory: project };
  const options = { projectDirectory: project };
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => savePreviewSpec(spec, options)));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.ok(results.filter(item => item.status === 'rejected').every(item => item.reason.code === 'ALREADY_EXISTS'));
  const file = join(project, 'preview.yaml');
  assert.deepEqual(await loadPreviewSpec(file), parseSpec(spec));
  await writeFile(file, '# owner content stays\n');
  await assert.rejects(savePreviewSpec(spec, options), { code: 'ALREADY_EXISTS' });
  assert.equal(await readFile(file, 'utf8'), '# owner content stays\n');
  await rm(file); await mkdir(file);
  await assert.rejects(savePreviewSpec(spec, options), { code: 'ALREADY_EXISTS' });
  await rm(file, { recursive: true });
  const target = join(project, 'target'); await writeFile(target, 'keep'); await symlink(target, file);
  await assert.rejects(savePreviewSpec(spec, options), { code: 'ALREADY_EXISTS' });
  assert.equal(await readFile(target, 'utf8'), 'keep');
  assert.deepEqual((await readdir(project)).sort(), ['preview.yaml', 'target']);
});

test('configuration rejects ambiguous YAML, extra fields, oversized input, and source excerpts in errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost unsafe config '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'preview.yaml');
  const secret = 'private-value-must-not-appear-in-errors';
  const invalid = [
    `name: first\nname: ${secret}\ntype: static\ndirectory: .`,
    `name: site\ntype: static\ndirectory: &path ${secret}\ncopy: *path`,
    `name: site\ntype: static\ndirectory: .\n<<: {spa: true}`,
    `name: site\ntype: static\ndirectory: !include ${secret}`,
    `name: site\ntype: static\ndirectory: !!str ${secret}`,
    'name: site\ntype: static\ndirectory: .\n---\nname: second',
    '? [name]\n: site\ntype: static\ndirectory: .',
    '%YAML 1.1\n---\nname: site\ntype: static\ndirectory: .',
  ];
  for (const contents of invalid) {
    await writeFile(file, contents);
    await assert.rejects(loadPreviewSpec(file), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'INVALID_INPUT');
      assert.ok(!(error as Error).message.includes(secret));
      return true;
    });
  }
  await writeFile(file, 'name: site\ntype: static\ndirectory: .\napproved: true');
  await assert.rejects(loadPreviewSpec(file), { code: 'INVALID_INPUT' });
  await writeFile(file, `name: site\ntype: static\ndirectory: .\n# ${'x'.repeat(limits.controlBytes)}`);
  await assert.rejects(loadPreviewSpec(file), { code: 'INVALID_INPUT' });
  await assert.rejects(readPreviewSpec(Readable.from(['name: site\ntype: static\ndirectory: .']), {
    baseDirectory: directory, format: 'json',
  }), { code: 'INVALID_INPUT' });
});

test('the file loader preserves legacy relative specs and honors cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost legacy config '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'preview.json');
  await writeFile(file, JSON.stringify({ name: 'site', type: 'static', directory: '.' }));
  assert.deepEqual(await loadPreviewSpec(file), { name: 'site', type: 'static', directory, spa: false });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadPreviewSpec(file, { signal: controller.signal }), { code: 'CLOSED' });
  await assert.rejects(loadPreviewSpec(join(directory, 'missing.json')), { code: 'INVALID_INPUT' });
});

test('file input rejects special files without waiting for a producer and still follows regular-file links', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost file input '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (process.platform !== 'win32') { // Windows has no filesystem FIFOs.
    const fifo = join(directory, 'preview.yaml');
    await promisify(execFile)('mkfifo', [fifo]);
    await assert.rejects(loadPreviewSpec(fifo), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(loadPreviewSpec(directory), { code: 'INVALID_INPUT' });
  await writeFile(join(directory, 'spec.json'), JSON.stringify({ name: 'site', type: 'static', directory: '.' }));
  const file = join(directory, 'linked.json'); await symlink(join(directory, 'spec.json'), file);
  assert.deepEqual(await loadPreviewSpec(file), await loadPreviewSpec(join(directory, 'spec.json')));
  const scoped = { allowedRoots: [directory] };
  assert.deepEqual(await loadPreviewSpec(file, scoped), await loadPreviewSpec(file));
  const restricted = join(directory, 'restricted'); await mkdir(restricted);
  await symlink(join(directory, 'spec.json'), join(restricted, 'escape.json'));
  await assert.rejects(loadPreviewSpec(file, { allowedRoots: [restricted] }), { code: 'SOURCE_DENIED' });
  await assert.rejects(loadPreviewSpec(join(restricted, 'escape.json'), { allowedRoots: [restricted] }), { code: 'SOURCE_DENIED' });
});

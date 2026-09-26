import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { changeConfigurationBindings, configurationBindings, loadPreviewSpec, readConfigurationDocument, readPreviewSpec, resolvePreviewFile, savePreviewSpec, updateConfigurationDocument } from './config.js';
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
  const files: string[] = [];
  const spec = await readPreviewSpec(Readable.from(['{"name":"inline","type":"static","directory":"."}']), {
    baseDirectory: project, format: 'json', fallbackProject: project, onFile: file => files.push(file),
  });
  assert.equal(spec.name, 'inline');
  assert.equal(files.length, 0);
  await assert.rejects(readPreviewSpec(Readable.from([' ']), {
    baseDirectory: project, format: 'json', fallbackProject: project,
  }), { code: 'INVALID_INPUT', message: /Both preview.yaml and preview.yml exist/ });
  await rm(yml);
  assert.equal(await resolvePreviewFile(project), yaml);
  assert.equal((await readPreviewSpec(Readable.from([' ']), {
    baseDirectory: project, format: 'json', fallbackProject: project, onFile: file => files.push(file),
  })).name, 'preferred');
  assert.deepEqual(files, [yaml]);
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

test('binding edits preserve YAML comments, relative sources and untouched private declarations', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost edit yaml ')));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, 'front end')); await mkdir(join(project, 'backend'));
  const file = join(project, 'preview.yaml');
  const original = `# Configuration owned by the project.
name: shop
type: environment
primary: web
services:
  web:
    type: command
    cwd: './front end' # Keep paths portable.
    command: [node, 'serve #literal', '--port', '{port}']
    env:
      KEEP: 'private-existing-literal' # Keep this comment and value.
      MODE: development # Preserve the edited row's comment too.
      REMOVE: obsolete
      API_URL: {service: api}
      TOKEN: {secret: shared/api}
  migrate:
    type: job
    cwd: ./backend
    command: [node, migrate.mjs]
    env: {MODE: development}
  api: {type: static, directory: ./backend}
  database: {type: external-postgres, url: 'postgres://owner:private-database@127.0.0.1:5432/db'}
`;
  await writeFile(file, original);
  const options = { allowedRoots: [project] };
  const document = await readConfigurationDocument(file, options);
  assert.ok(!JSON.stringify(document.bindings).includes('private-'));
  assert.deepEqual(document.bindings.find(row => row.key === 'KEEP'), { service: 'web', key: 'KEEP', value: null });
  assert.deepEqual(document.bindings.find(row => row.key === 'TOKEN')?.value, { secret: 'shared/api' });
  assert.ok(document.bindings.every(row => row.service !== 'database'));
  const saved = await updateConfigurationDocument(document, [
    { service: 'web', key: 'MODE', value: 'production' },
    { service: 'web', key: 'REMOVE', value: null },
    { service: 'web', key: 'ADDED', value: { secret: 'shop/new' } },
    { service: 'migrate', key: 'MODE', value: { fromEnv: 'MIGRATION_MODE' } },
  ], options);
  const text = await readFile(file, 'utf8');
  assert.equal(saved.text, text);
  for (const retained of ['# Configuration owned by the project.', "cwd: './front end' # Keep paths portable.",
    "KEEP: 'private-existing-literal' # Keep this comment and value.", "# Preserve the edited row's comment too.", 'cwd: ./backend', 'directory: ./backend']) {
    assert.ok(text.includes(retained), retained);
  }
  const loaded = await loadPreviewSpec(file);
  assert.equal(loaded.type, 'environment');
  if (loaded.type !== 'environment') throw new Error('Expected an environment');
  assert.equal(loaded.services.web.type, 'command');
  if (loaded.services.web.type !== 'command') throw new Error('Expected a command');
  assert.deepEqual(loaded.services.web.command, ['node', 'serve #literal', '--port', '{port}']);
  assert.equal(loaded.services.web.cwd, join(project, 'front end'));
  assert.deepEqual(loaded.services.web.env, {
    KEEP: 'private-existing-literal', MODE: 'production', API_URL: { service: 'api' }, TOKEN: { secret: 'shared/api' }, ADDED: { secret: 'shop/new' },
  });
  assert.equal(loaded.services.migrate.type, 'job');
  if (loaded.services.migrate.type !== 'job') throw new Error('Expected a job');
  assert.deepEqual(loaded.services.migrate.env, { MODE: { fromEnv: 'MIGRATION_MODE' } });
  assert.equal(loaded.services.database.type, 'external-postgres');
  if (loaded.services.database.type !== 'external-postgres') throw new Error('Expected external database');
  assert.equal(loaded.services.database.url, 'postgres://owner:private-database@127.0.0.1:5432/db');
  assert.equal(document.text, original);
});

test('JSON and direct binding edits retain literals, symbolic inputs and file permissions without mutating the input', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost edit json ')));
  t.after(() => rm(project, { recursive: true, force: true }));
  const file = join(project, 'preview.json');
  const original: PreviewSpec = { name: 'site', type: 'command', cwd: '.', command: ['node', 'app.mjs'], env: {
    KEEP: 'private-value', REMOVE: 'obsolete', TOKEN: { secret: 'shared/token' },
  } };
  await writeFile(file, JSON.stringify(original)); await chmod(file, 0o640);
  const options = { allowedRoots: [project] };
  const document = await readConfigurationDocument(file, options);
  const unchanged = await updateConfigurationDocument(document, [{ key: 'ABSENT', value: null }], options);
  assert.equal(unchanged.text, JSON.stringify(original));
  assert.deepEqual(unchanged.identity, document.identity);
  const changes = [{ key: 'REMOVE', value: null }, { key: 'TOKEN', value: { fromEnv: 'OWNER_TOKEN' } }, { key: 'EMPTY', value: '' }];
  const direct = changeConfigurationBindings(document.spec, changes);
  assert.equal(document.spec.type, 'command');
  if (document.spec.type !== 'command') throw new Error('Expected a command');
  assert.deepEqual(document.spec.env, original.env);
  assert.deepEqual(configurationBindings(direct), [
    { key: 'EMPTY', value: null }, { key: 'KEEP', value: null }, { key: 'TOKEN', value: { fromEnv: 'OWNER_TOKEN' } },
  ]);
  const saved = await updateConfigurationDocument(document, changes, options);
  assert.deepEqual(saved.spec, direct);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, env: {
    KEEP: 'private-value', TOKEN: { fromEnv: 'OWNER_TOKEN' }, EMPTY: '',
  } });
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o640);
});

test('document updates reject external changes and symlinks without overwriting the file or linked target', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost edit stale ')));
  t.after(() => rm(project, { recursive: true, force: true }));
  const file = join(project, 'preview.yaml');
  const original = 'name: site\ntype: command\ncwd: .\ncommand: [node, app.mjs]\nenv: {MODE: before}\n';
  const options = { allowedRoots: [project] };
  const changes = [{ key: 'MODE', value: 'after' }];
  await writeFile(file, original);
  const document = await readConfigurationDocument(file, options);
  const external = original.replace('before', 'external');
  await writeFile(file, external);
  await assert.rejects(updateConfigurationDocument(document, changes, options), { code: 'STALE_ATTEMPT' });
  assert.equal(await readFile(file, 'utf8'), external);
  const reread = await readConfigurationDocument(file, options);
  const replacement = join(project, 'replacement.yaml'); await writeFile(replacement, external); await rename(replacement, file);
  await assert.rejects(updateConfigurationDocument(reread, changes, options), { code: 'STALE_ATTEMPT' });
  const current = await readConfigurationDocument(file, options);
  const target = join(project, 'target.yaml'); await rename(file, target); await symlink(target, file);
  await assert.rejects(readConfigurationDocument(file, options), { code: 'INVALID_INPUT' });
  await assert.rejects(updateConfigurationDocument(current, changes, options), { code: 'INVALID_INPUT' });
  assert.equal(await readFile(target, 'utf8'), external);
  assert.deepEqual((await readdir(project)).sort(), ['preview.yaml', 'target.yaml']);
  // A parent alias with '..' must not silently select a different backend than the normal loader.
  await mkdir(join(project, 'physical/config'), { recursive: true });
  await mkdir(join(project, 'physical/backend'));
  await mkdir(join(project, 'view/backend'), { recursive: true });
  await symlink(join(project, 'physical/config'), join(project, 'view/config'));
  const realFile = join(project, 'physical/config/preview.yaml');
  const aliasFile = join(project, 'view/config/preview.yaml');
  await writeFile(realFile, original.replace('cwd: .', 'cwd: ../backend'));
  const loaded = await loadPreviewSpec(aliasFile);
  assert.equal(loaded.type, 'command');
  if (loaded.type !== 'command') throw new Error('Expected a command');
  assert.equal(loaded.cwd, join(project, 'view/backend'));
  await assert.rejects(readConfigurationDocument(aliasFile, options), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'INVALID_INPUT');
    assert.ok((error as Error).message.includes(realFile));
    return true;
  });
  const explicit = await readConfigurationDocument(realFile, options);
  assert.equal(explicit.spec.type, 'command');
  if (explicit.spec.type !== 'command') throw new Error('Expected a command');
  assert.equal(explicit.spec.cwd, join(project, 'physical/backend'));
});

test('binding saves validate source scope and graph before publication and leave complete original files on failure', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'previewhost edit failures ')));
  t.after(() => rm(project, { recursive: true, force: true }));
  const source = join(project, 'source'); await mkdir(source);
  const file = join(source, 'preview.yaml');
  const original = 'name: site\ntype: environment\nprimary: web\nservices:\n  web: {type: command, cwd: ., command: [node, app.mjs], env: {KEEP: private-value}}\n  assets: {type: static, directory: ..}\n';
  await writeFile(file, original);
  await assert.rejects(readConfigurationDocument(file, { allowedRoots: [source] }), { code: 'SOURCE_DENIED' });
  await assert.rejects(readConfigurationDocument(file, { allowedRoots: [] }), { code: 'SOURCE_DENIED' });
  const options = { allowedRoots: [project] };
  const document = await readConfigurationDocument(file, options);
  for (const change of [
    { service: 'web', key: 'PORT', value: '3000' },
    { service: 'web', key: 'SELF', value: { service: 'web' } },
    { service: 'assets', key: 'TOKEN', value: { secret: 'site/token' } },
    { key: 'MODE', value: 'missing-service' },
  ]) {
    await assert.rejects(updateConfigurationDocument(document, [change], options), { code: 'INVALID_INPUT' });
  }
  const changes = [{ service: 'web', key: 'MODE', value: 'production' }];
  await assert.rejects(updateConfigurationDocument(document, changes, { ...options, signal: AbortSignal.abort() }), { code: 'CLOSED' });
  const originalRename = fs.rename;
  const { syncBuiltinESMExports } = await import('node:module');
  t.mock.method(fs, 'rename', async () => { throw new Error('private-filesystem-details'); }); syncBuiltinESMExports();
  try { await assert.rejects(updateConfigurationDocument(document, changes, options), { code: 'INVALID_INPUT', message: /Cannot update the configuration file/ }); }
  finally { t.mock.method(fs, 'rename', originalRename); syncBuiltinESMExports(); }
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(source), ['preview.yaml']);
  await writeFile(file, Buffer.concat([Buffer.from(`${original}# `), Buffer.from([0xff])]));
  await assert.rejects(readConfigurationDocument(file, options), { code: 'INVALID_INPUT', message: /UTF-8/ });
  await writeFile(file, 'name: site\nname: private-value\n');
  await assert.rejects(readConfigurationDocument(file, options), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'INVALID_INPUT');
    assert.ok(!(error as Error).message.includes('private-value'));
    return true;
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { loadPreviewSpec, readPreviewSpec } from './config.js';
import { limits } from './contracts.js';

test('JSON and YAML files produce the same environment with file-relative repositories and symbolic inputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd config '));
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

test('configuration rejects ambiguous YAML, extra fields, oversized input, and source excerpts in errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd unsafe config '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'preview.yml');
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
  const directory = await mkdtemp(join(tmpdir(), 'previewd legacy config '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'preview.json');
  await writeFile(file, JSON.stringify({ name: 'site', type: 'static', directory: '.' }));
  assert.deepEqual(await loadPreviewSpec(file), { name: 'site', type: 'static', directory, spa: false });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadPreviewSpec(file, { signal: controller.signal }), { code: 'CLOSED' });
  await assert.rejects(loadPreviewSpec(join(directory, 'missing.json')), { code: 'INVALID_INPUT' });
});

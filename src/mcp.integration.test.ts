import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectPreviewDaemon } from './client.js';
import type { AttemptResult, PreviewStatus } from './contracts.js';
import { startDaemon } from './daemon.js';
import { createPreviewRuntime } from './runtime.js';

const cli = resolve('dist/cli.js');

test('MCP discovers with no daemon in both protocol eras and returns actionable tool errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd mcp absent '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const modern of [false, true]) {
    const client = new Client({ name: 'previewd-integration', version: '1.0.0' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--token-file', join(directory, 'absent', 'token')], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += chunk; });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 9);
      assert.ok(!tools.some((tool) => /shutdown|approve|permission/.test(tool.name)));
      assert.equal(tools.find((tool) => tool.name === 'preview_wait')?.annotations?.readOnlyHint, true);
      assert.equal(tools.find((tool) => tool.name === 'preview_start')?.annotations?.readOnlyHint, false);
      const result = await client.callTool({ name: 'preview_list', arguments: {} });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'DAEMON_UNAVAILABLE');
      assert.match(JSON.stringify(result.content), /previewd serve/);
      assert.equal(stderr, '');
    } finally { await client.close(); }
  }
});

test('SDK MCP start, wait, replace, and stop share the same preview with CLI-compatible clients', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd mcp workflow '));
  const first = join(directory, 'first'); const second = join(directory, 'second');
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, 'index.html'), 'first'); await writeFile(join(second, 'index.html'), 'second');
  const runtime = await createPreviewRuntime({ allowedRoots: [directory] });
  const tokenFile = join(directory, 'private', 'token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const other = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  const mcp = new Client({ name: 'previewd-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--endpoint', daemon.endpoint, '--token-file', tokenFile], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => { await mcp.close(); await other.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }); });
  await mcp.connect(transport);
  const invalid = await mcp.callTool({ name: 'preview_start', arguments: { approved: true, spec: { name: 'site', type: 'static', directory: first } } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(await other.list(), []);
  const started = await mcp.callTool({ name: 'preview_start', arguments: { spec: { name: 'site', type: 'static', directory: first } } });
  assert.ok(!started.isError);
  const status = (started.structuredContent as { result: PreviewStatus }).result;
  const ready = ((await mcp.callTool({ name: 'preview_wait', arguments: { name: 'site', attemptId: status.candidate!.id } })).structuredContent as { result: AttemptResult }).result;
  assert.equal(ready.state, 'ready');
  assert.equal(await (await fetch(ready.url!)).text(), 'first');
  const listed = await mcp.callTool({ name: 'preview_list', arguments: {} });
  assert.deepEqual((listed.structuredContent as { result: PreviewStatus[] }).result.map((item) => item.name), ['site']);
  const replacement = await other.replace('site', { name: 'site', type: 'static', directory: second });
  assert.equal((await other.wait('site', replacement.candidate!.id)).state, 'ready');
  assert.equal(await (await fetch(ready.url!)).text(), 'second');
  const stopped = await mcp.callTool({ name: 'preview_stop', arguments: { name: 'site' } });
  assert.ok(!stopped.isError);
  assert.equal((await other.get('site')).active, undefined);
  const again = await other.start({ name: 'survivor', type: 'static', directory: first });
  const survivor = await other.wait('survivor', again.candidate!.id);
  await mcp.close();
  assert.equal(await (await fetch(survivor.url!)).text(), 'first');
  assert.equal(stderr, '');
});

test('SDK cancellation aborts only a wait and EOF releases pending requests without stopping daemon work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'previewd mcp cancel '));
  const runtime = await createPreviewRuntime({ allowedRoots: [directory], authorize: ({ signal }) => new Promise<boolean>((done) => {
    signal.addEventListener('abort', () => done(false), { once: true });
  }) });
  const tokenFile = join(directory, 'private', 'token');
  const daemon = await startDaemon({ runtime, tokenFile, port: 0 });
  const other = connectPreviewDaemon({ endpoint: daemon.endpoint, tokenFile });
  const mcp = new Client({ name: 'previewd-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--endpoint', daemon.endpoint, '--token-file', tokenFile], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  t.after(async () => { await mcp.close(); await other.close(); await daemon.close(); await rm(directory, { recursive: true, force: true }); });
  await mcp.connect(transport);
  const status = await other.start({ name: 'pending', type: 'command', cwd: directory, command: [process.execPath, '-e', 'process.exit(99)'] });
  let entered!: () => void;
  const waiting = new Promise<void>((done) => { entered = done; });
  const original = runtime.wait.bind(runtime);
  runtime.wait = (...args) => { entered(); return original(...args); };
  const controller = new AbortController();
  const result = mcp.callTool({ name: 'preview_wait', arguments: { name: 'pending', attemptId: status.candidate!.id } }, { signal: controller.signal }).catch((error: unknown) => error);
  await waiting;
  controller.abort();
  assert.ok(await result instanceof Error);
  assert.equal((await other.get('pending')).candidate?.id, status.candidate!.id);
  const pending = mcp.callTool({ name: 'preview_wait', arguments: { name: 'pending', attemptId: status.candidate!.id } }).catch((error: unknown) => error);
  await mcp.close();
  assert.ok(await pending instanceof Error);
  assert.equal((await other.get('pending')).candidate?.id, status.candidate!.id);
  await other.cancel('pending', status.candidate!.id);
});

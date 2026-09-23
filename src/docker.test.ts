import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import koffi from 'koffi';
import { pipePermissions } from './testSupport/permissions.js';
import { Docker, normalizeDockerEndpoint } from './docker.js';
import { PreviewError } from './errors.js';
import { createDataOwner } from './data.js';
import { testKeystore } from './testSupport/keystore.js';

test('Docker connection rejection settles even when HTTP never assigns a socket', { timeout: 2000 }, async t => {
  const request = http.request;
  t.mock.method(http, 'request', (options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => request({
    ...options, agent: undefined, createConnection(_options, done) {
      queueMicrotask(() => done!(new PreviewError('UNAUTHORIZED', 'Rejected connected pipe.'), undefined!));
      return undefined;
    },
  }, callback));
  const docker = new Docker('unused');
  await assert.rejects(docker.request('POST', '/containers/create', { marker: 'DUMMY' }), { code: 'UNAUTHORIZED' });
  await assert.rejects(docker.attach('fixture'), { code: 'UNAUTHORIZED' });
});

test('Docker endpoints accept only local transports and normalize pipe aliases', () => {
  const pipe = String.raw`\\.\pipe\docker_engine`;
  assert.equal(normalizeDockerEndpoint('npipe:////./pipe/docker_engine', 'win32'), pipe);
  assert.equal(normalizeDockerEndpoint(pipe, 'win32'), pipe);
  assert.equal(normalizeDockerEndpoint('unix:///tmp/docker.sock', 'linux'), '/tmp/docker.sock');
  for (const endpoint of ['tcp://127.0.0.1:2375', 'ssh://host', 'npipe:////server/pipe/docker_engine', String.raw`\\server\pipe\docker_engine`]) {
    for (const platform of ['win32', 'linux'] as const) assert.throws(() => normalizeDockerEndpoint(endpoint, platform), { code: 'INVALID_INPUT' });
  }
});

test('Docker HTTP and attach share the local socket or named-pipe transport', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'previewhost-docker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\previewhost-${randomUUID()}` : join(directory, 'docker.sock');
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1.40/info');
    res.end(JSON.stringify({ ID: 'fixture-engine' }));
  });
  let received!: (value: string) => void;
  const attached = new Promise<string>(resolve => { received = resolve; });
  server.on('upgrade', (req, socket) => {
    assert.match(req.url!, /\/containers\/fixture\/attach/);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    let body = '';
    socket.on('data', chunk => { body += chunk; });
    socket.on('end', () => { received(body); socket.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  if (process.platform === 'win32') pipePermissions(endpoint, false);
  const docker = await Docker.connect(endpoint);
  assert.deepEqual(await Promise.all(Array.from({ length: 32 }, () => docker.engineId())), Array(32).fill('fixture-engine'));
  const stream = await docker.attach('fixture');
  stream.send('FAKE_initialization_input\n');
  assert.equal(await attached, 'FAKE_initialization_input\n');
  await stream.close();
});

if (process.platform === 'win32') test('a busy Docker pipe respects request cancellation and deadlines before sending HTTP', { timeout: 2000 }, async () => {
  const endpoint = `\\\\.\\pipe\\previewhost-${randomUUID()}`;
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void * __stdcall CreateNamedPipeW(const char16_t *, uint32, uint32, uint32, uint32, uint32, uint32, void *)');
  const open = kernel.func('void * __stdcall CreateFileW(const char16_t *, uint32, uint32, void *, uint32, uint32, void *)');
  const close = kernel.func('int __stdcall CloseHandle(void *)');
  const server = create(endpoint, 3 | 0x40000000, 0, 1, 4096, 4096, 0, null);
  assert.notEqual(koffi.address(server), 0xffffffffffffffffn);
  try {
    const occupied = open(endpoint, 0xc0000000, 0, null, 3, 0x40000000 | 0x00100000, null);
    assert.notEqual(koffi.address(occupied), 0xffffffffffffffffn);
    try {
      const docker = await Docker.connect(endpoint);
      await assert.rejects(docker.request('GET', '/info', undefined, { timeoutMs: 25 }), { code: 'CLEANUP_INCOMPLETE' });
      const controller = new AbortController();
      const pending = docker.request('GET', '/info', undefined, { signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, { code: 'CLOSED' });
    } finally { assert.ok(close(occupied)); }
  } finally { assert.ok(close(server)); }
});

if (process.platform === 'win32') test('Docker checks each connected pipe before HTTP bodies or attach input', { timeout: 5000 }, async t => {
  const endpoint = `\\\\.\\pipe\\previewhost-${randomUUID()}`;
  let requests = 0;
  let bytes = 0;
  const server = http.createServer((_req, res) => { requests++; res.end(JSON.stringify({ ID: 'fixture-engine' })); });
  server.on('connection', socket => socket.on('data', chunk => { bytes += chunk.length; }));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  pipePermissions(endpoint, false);
  const docker = await Docker.connect(endpoint);
  assert.equal(await docker.engineId(), 'fixture-engine');
  pipePermissions(endpoint, true);
  bytes = 0;
  await assert.rejects(docker.request('POST', '/containers/create', { marker: 'DUMMY_private_input' }), { code: 'UNAUTHORIZED' });
  await assert.rejects(docker.attach('fixture'), { code: 'UNAUTHORIZED' });
  assert.equal(requests, 1, 'The changed pipe must receive no HTTP request or upgrade.');
  assert.equal(bytes, 0, 'Rejected connections must send no bytes.');

  const fixture = await testKeystore(t);
  const directory = join(fixture.directory, 'data');
  const add = t.mock.method(fixture.store, 'add', async () => assert.fail('Untrusted pipes must not cause credential writes.'));
  const owner = await createDataOwner({ directory, dockerSocket: endpoint, keystore: fixture.store });
  try {
    await assert.rejects(owner.open('sample', { database: { type: 'postgres' } }, {
      signal: t.signal, onFailure(error) { assert.fail(error.message); },
    }), { code: 'UNAUTHORIZED' });
    assert.equal(add.mock.callCount(), 0);
    assert.deepEqual(owner.names(), []);
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.json')), []);
    assert.equal(bytes, 0, 'The untrusted pipe must receive no database request.');
  } finally { await owner.close(); }
});

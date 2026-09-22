import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import koffi from 'koffi';
import { Docker, normalizeDockerEndpoint } from './docker.js';
import { PreviewError } from './errors.js';
import { createDataOwner } from './data.js';
import { testKeystore } from './testSupport/keystore.js';

test('Docker connection rejection settles even when HTTP never assigns a socket', { timeout: 2000 }, async t => {
  const request = http.request;
  t.mock.method(http, 'request', (options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => request({
    ...options, agent: undefined, createConnection() { throw new PreviewError('UNAUTHORIZED', 'Rejected connected pipe.'); },
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
  assert.equal(await docker.engineId(), 'fixture-engine');
  const stream = await docker.attach('fixture');
  stream.send('FAKE_initialization_input\n');
  assert.equal(await attached, 'FAKE_initialization_input\n');
  await stream.close();
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

// Set permissions only on this test's own pipe. Opening this handle sends no HTTP bytes.
function pipePermissions(endpoint: string, publicAccess: boolean): void {
  const kernel = koffi.load('kernel32.dll'), security = koffi.load('advapi32.dll');
  const user = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-5-[\d-]+/)![0];
  const descriptor = [null], dacl = [null], present = [0], defaulted = [0];
  const convert = security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32, _Out_ void **, void *)');
  const read = security.func('int __stdcall GetSecurityDescriptorDacl(void *, _Out_ int *, _Out_ void **, _Out_ int *)');
  const set = security.func('uint32 __stdcall SetSecurityInfo(void *, int, uint32, void *, void *, void *, void *)');
  const open = kernel.func('void * __stdcall CreateFileW(const char16_t *, uint32, uint32, void *, uint32, uint32, void *)');
  const close = kernel.func('int __stdcall CloseHandle(void *)');
  const free = kernel.func('void * __stdcall LocalFree(void *)');
  assert.ok(convert(`D:P(A;;GA;;;${user})(A;;GA;;;SY)(A;;GA;;;BA)${publicAccess ? '(A;;GA;;;WD)' : ''}`, 1, descriptor, null));
  try {
    assert.ok(read(descriptor[0], present, dacl, defaulted));
    assert.equal(present[0], 1);
    const handle = open(endpoint, 0xc0040000, 0, null, 3, 0x00100000, null);
    assert.notEqual(koffi.address(handle), 0xffffffffffffffffn);
    try { assert.equal(set(handle, 6, 0x4, null, null, dacl[0], null), 0); }
    finally { assert.ok(close(handle)); }
  } finally { free(descriptor[0]); }
}

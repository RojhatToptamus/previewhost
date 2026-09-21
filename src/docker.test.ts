import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Docker, normalizeDockerEndpoint } from './docker.js';

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
  const docker = await Docker.connect(endpoint);
  assert.equal(await docker.engineId(), 'fixture-engine');
  const stream = await docker.attach('fixture');
  stream.send('FAKE_initialization_input\n');
  assert.equal(await attached, 'FAKE_initialization_input\n');
  await stream.close();
});

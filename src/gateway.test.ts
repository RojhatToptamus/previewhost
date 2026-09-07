import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import { createGateway, type Gateway } from './gateway.js';
import { limits } from './contracts.js';
import type { HttpTarget } from './resources.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out: ${label}`);
    await pause(10);
  }
}

async function backend(t: TestContext, handler?: http.RequestListener) {
  const server = http.createServer(handler);
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const target: HttpTarget = { port, hostHeader: `127.0.0.1:${port}` };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, sockets, target, url: `http://${target.hostHeader}` };
}

async function gateway(t: TestContext, target?: HttpTarget): Promise<Gateway> {
  const result = await createGateway();
  t.after(() => result.close());
  result.setTarget(target);
  return result;
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  clientPort?: number;
}
function request(url: string, options: http.RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = http.get(url, { agent: false, ...options }, (incoming) => {
      const clientPort = incoming.socket.localPort;
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.once('error', reject);
      incoming.once('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body, clientPort }));
    });
    outgoing.once('error', reject);
  });
}

async function rawClient(t: TestContext, url: string) {
  const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(url).port) });
  let bytes = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return { socket, get bytes() { return bytes; }, get text() { return bytes.toString(); } };
}

function upgradeRequest(url: string, path = '/'): string {
  return `GET ${path} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: hmr\r\n\r\n`;
}
function acceptUpgrade(request: http.IncomingMessage): string {
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  return `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade, x-private\r\nUpgrade: websocket\r\nx-private: remove-me\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: hmr\r\n\r\n`;
}

test('streams request bodies, uses target Host, replaces forwarding metadata and rewrites only internal redirects', async (t) => {
  let firstChunk!: () => void;
  const firstData = new Promise<void>((resolve) => { firstChunk = resolve; });
  let received = 0;
  const upstream = await backend(t, (incoming, response) => {
    if (incoming.url === '/upload') {
      incoming.on('data', (chunk: Buffer) => { received += chunk.length; firstChunk(); });
      incoming.on('end', () => {
        response.setHeader('Connection', 'close, x-private');
        response.setHeader('x-private', 'remove-me');
        response.end(JSON.stringify({ bytes: received, headers: incoming.headers }));
      });
    } else {
      const locations: Record<string, string> = {
        '/redirect': `http://${incoming.headers.host}/result?x=1#part`,
        '/external': `https://${incoming.headers.host}/secure`,
        '/relative': '/relative-target',
      };
      response.writeHead(307, { location: locations[incoming.url!] });
      response.end();
    }
  });
  upstream.target.hostHeader = `app.localhost:${upstream.target.port}`;
  const proxy = await gateway(t, upstream.target);
  const response = new Promise<Response>((resolve, reject) => {
    const outgoing = http.request(`${proxy.url}/upload`, {
      method: 'POST',
      headers: {
        connection: 'keep-alive, x-remove', 'x-remove': 'do-not-forward',
        forwarded: 'host=untrusted', 'x-forwarded-host': 'untrusted.example',
        'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '203.0.113.2',
      },
    }, (incoming) => {
      let body = '';
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.write(Buffer.alloc(64 * 1024, 'a'));
    void firstData.then(() => {
      assert.equal(outgoing.writableEnded, false, 'the upstream receives data before the client finishes its body');
      outgoing.end(Buffer.alloc(2 * 1024 * 1024, 'b'));
    }).catch(reject);
  });
  const result = await response;
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.bytes, 64 * 1024 + 2 * 1024 * 1024);
  assert.equal(parsed.headers.host, upstream.target.hostHeader);
  assert.equal(parsed.headers['x-forwarded-host'], new URL(proxy.url).host);
  assert.equal(parsed.headers['x-forwarded-proto'], 'http');
  assert.equal(parsed.headers['x-forwarded-for'], '127.0.0.1');
  for (const name of ['x-remove', 'forwarded', 'x-real-ip']) assert.equal(parsed.headers[name], undefined);
  assert.equal(result.headers['x-private'], undefined);
  assert.equal((await request(`${proxy.url}/redirect`)).headers.location, `${proxy.url}/result?x=1#part`);
  assert.equal((await request(`${proxy.url}/external`)).headers.location, `https://${upstream.target.hostHeader}/secure`);
  assert.equal((await request(`${proxy.url}/relative`)).headers.location, '/relative-target');
});

test('rejects invalid authorities and proxy requests, and bounds HTTP and WebSocket routing cycles', async (t) => {
  const upstream = await backend(t, (_request, response) => response.end('ok'));
  const first = await gateway(t, upstream.target);
  assert.equal((await request(first.url, { headers: { host: 'evil.example' } })).status, 421);
  assert.equal((await request(first.url, { path: 'http://evil.example/' })).status, 400);
  assert.equal((await request(first.url, { headers: { 'x-previewd-hops': 'invalid' } })).status, 400);
  const duplicate = await rawClient(t, first.url);
  duplicate.socket.write(`GET / HTTP/1.1\r\nHost: ${new URL(first.url).host}\r\nHost: evil.example\r\n\r\n`);
  await eventually(() => duplicate.text.includes('421'), 'duplicate Host rejection');
  const tunnel = await rawClient(t, first.url);
  tunnel.socket.write(`CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: ${new URL(first.url).host}\r\n\r\n`);
  await eventually(() => tunnel.text.includes('405'), 'CONNECT rejection');
  const self = { port: Number(new URL(first.url).port), hostHeader: new URL(first.url).host };
  assert.throws(() => first.setTarget(self), /own public listener/);
  assert.equal((await request(first.url)).body, 'ok', 'rejected target does not change the active route');
  const second = await gateway(t, self);
  first.setTarget({ port: Number(new URL(second.url).port), hostHeader: new URL(second.url).host });
  assert.equal((await request(first.url)).status, 508);
  const ws = await rawClient(t, first.url);
  ws.socket.write(upgradeRequest(first.url));
  await eventually(() => ws.text.includes('508'), 'WebSocket cycle bound');
  await eventually(() => upstream.sockets.size === 0, 'cycle does not keep unrelated upstream connections');
});

test('retiring old SSE requests does not close new work on a reused downstream keepalive socket', async (t) => {
  let oldClosed = false;
  const old = await backend(t, (incoming, response) => {
    if (incoming.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: old\n\n');
      response.once('close', () => { oldClosed = true; });
    } else response.end('old');
  });
  let finishNew: (() => void) | undefined;
  const next = await backend(t, (_request, response) => {
    response.write('new-');
    finishNew = () => response.end('complete');
  });
  const proxy = await gateway(t, old.target);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const initial = await request(proxy.url, { agent });
  let firstEvent = '';
  let eventResponse: http.IncomingMessage | undefined;
  const events = http.get(`${proxy.url}/events`, { agent: false }, (incoming) => {
    eventResponse = incoming;
    incoming.on('data', (chunk) => { firstEvent += chunk; });
    incoming.on('error', () => {});
  });
  events.on('error', () => {});
  t.after(() => events.destroy());
  await eventually(() => firstEvent.includes('data: old'), 'SSE data streams before response end');
  proxy.setTarget(next.target);
  const fresh = request(`${proxy.url}/slow`, { agent });
  await eventually(() => finishNew !== undefined, 'new request reaches replacement immediately');
  await proxy.drain(old.target);
  await eventually(() => oldClosed && Boolean(eventResponse?.destroyed), 'old SSE connection retired');
  finishNew!();
  const result = await fresh;
  assert.equal(result.body, 'new-complete');
  assert.equal(result.clientPort, initial.clientPort, 'same downstream keepalive connection serves the new target');
  assert.equal(old.server.listening, true, 'retirement does not stop an attached server');
});

test('preserves WebSocket handshake/subprotocol and upgrade bytes, and closes both established and pending upstreams', async (t) => {
  const upstream = await backend(t);
  let observedHost = '';
  let earlyBytes = Buffer.alloc(0);
  let pending: net.Socket | undefined;
  let established: net.Socket | undefined;
  const serverFrame = Buffer.from([0x81, 0x04, 0x70, 0x69, 0x6e, 0x67]);
  const clientFrame = Buffer.from([0x81, 0x84, 1, 2, 3, 4, 0x70 ^ 1, 0x6f ^ 2, 0x6e ^ 3, 0x67 ^ 4]);
  upstream.server.on('upgrade', (incoming, socket, head) => {
    const tcp = socket as net.Socket;
    tcp.resume();
    tcp.on('end', () => tcp.destroy());
    if (incoming.url === '/pending') { pending = tcp; return; }
    established = tcp;
    observedHost = String(incoming.headers.host);
    earlyBytes = Buffer.concat([earlyBytes, head]);
    tcp.on('data', (chunk) => { earlyBytes = Buffer.concat([earlyBytes, chunk]); });
    tcp.write(Buffer.concat([Buffer.from(acceptUpgrade(incoming)), serverFrame]));
  });
  upstream.target.hostHeader = `hmr.localhost:${upstream.target.port}`;
  const proxy = await gateway(t, upstream.target);
  const client = await rawClient(t, proxy.url);
  client.socket.write(Buffer.concat([Buffer.from(upgradeRequest(proxy.url)), clientFrame]));
  await eventually(() => client.bytes.includes(serverFrame) && earlyBytes.includes(clientFrame), 'both directions preserve upgrade bytes');
  assert.match(client.text, /^HTTP\/1.1 101 /);
  assert.match(client.text, /sec-websocket-protocol: hmr/i);
  assert.doesNotMatch(client.text, /x-private/i);
  assert.equal(observedHost, upstream.target.hostHeader);
  client.socket.destroy();
  await eventually(() => Boolean(established?.destroyed), 'established upstream closes on browser disconnect');
  const waiting = await rawClient(t, proxy.url);
  waiting.socket.write(upgradeRequest(proxy.url, '/pending'));
  await eventually(() => pending !== undefined, 'pending handshake reaches upstream');
  waiting.socket.destroy();
  await eventually(() => Boolean(pending?.destroyed), 'pending handshake closes on browser disconnect');
  const retiring = await rawClient(t, proxy.url);
  retiring.socket.write(upgradeRequest(proxy.url));
  await eventually(() => retiring.bytes.includes(serverFrame), 'retiring WebSocket is established');
  const replacement = await backend(t, (_request, response) => response.end('replacement'));
  proxy.setTarget(replacement.target);
  assert.equal((await request(proxy.url)).body, 'replacement');
  await proxy.drain(upstream.target);
  await eventually(() => retiring.socket.destroyed && Boolean(established?.destroyed), 'retirement closes the old WebSocket pair');
  assert.equal(upstream.server.listening, true);
});

test('forwards WebSocket rejection bodies and terminates truncated HTTP responses without failing the gateway', async (t) => {
  const upstream = await backend(t, (incoming, response) => {
    if (incoming.url === '/truncated') {
      response.writeHead(200, { 'content-length': 10_000 });
      response.write('partial');
      setImmediate(() => response.socket?.destroy());
    } else response.end('still-working');
  });
  upstream.server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n6\r\ndenied\r\n0\r\n\r\n');
  });
  const proxy = await gateway(t, upstream.target);
  const ws = await rawClient(t, proxy.url);
  ws.socket.write(upgradeRequest(proxy.url));
  await eventually(() => ws.socket.destroyed, 'rejected WebSocket finishes');
  assert.match(ws.text, /^HTTP\/1.1 401 /);
  assert.match(ws.text, /\r\n\r\ndenied$/);
  assert.doesNotMatch(ws.text, /transfer-encoding/i);
  await assert.rejects(request(`${proxy.url}/truncated`));
  assert.equal((await request(proxy.url)).body, 'still-working');
});

test('publishes all browser routes together and drains only the retired alias streams', async (t) => {
  const old = await backend(t, (_incoming, response) => response.end('old'));
  let forwardedHost = '';
  old.server.on('upgrade', (incoming, socket) => {
    forwardedHost = String(incoming.headers['x-forwarded-host']);
    socket.on('data', () => {});
    socket.on('end', () => socket.destroy());
    socket.write(acceptUpgrade(incoming));
  });
  const next = await backend(t, (_incoming, response) => response.end('next'));
  const proxy = await gateway(t, old.target);
  const port = new URL(proxy.url).port;
  const alias = `http://shop--api.localhost:${port}`;
  proxy.setRoutes({ '127.0.0.1': old.target, 'shop--api.localhost': old.target });
  const stream = await rawClient(t, proxy.url);
  stream.socket.write(upgradeRequest(alias));
  await eventually(() => stream.text.includes('101'), 'alias WebSocket is established');
  assert.equal(forwardedHost, new URL(alias).host);
  assert.throws(() => proxy.setRoutes({
    '127.0.0.1': next.target, 'shop--api.localhost': next.target,
    'invalid.remote': next.target,
  }), /localhost label/);
  assert.equal((await request(proxy.url)).body, 'old');
  assert.equal((await request(proxy.url, { headers: { host: new URL(alias).host } })).body, 'old');
  proxy.setRoutes({ '127.0.0.1': next.target, 'shop--api.localhost': next.target });
  assert.equal((await request(proxy.url)).body, 'next');
  assert.equal((await request(proxy.url, { headers: { host: new URL(alias).host } })).body, 'next');
  assert.equal(stream.socket.destroyed, false, 'cutover retains the established old stream until drain');
  await proxy.drain(old.target);
  await eventually(() => stream.socket.destroyed && old.sockets.size === 0, 'old alias stream is drained');
  assert.equal((await request(proxy.url)).body, 'next');
  proxy.setRoutes(undefined);
  assert.equal((await request(proxy.url, { headers: { host: new URL(alias).host } })).status, 503);
  assert.equal((await request(proxy.url, { headers: { host: `unknown.localhost:${port}` } })).status, 421);
  assert.equal(old.server.listening, true, 'an externally owned backend is never stopped');
});

test('bounds stalled HTTP headers and WebSocket handshakes while keeping active streamed bodies alive', { timeout: 15_000 }, async (t) => {
  const upstream = await backend(t, (incoming, response) => {
    if (incoming.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: alive\n\n');
    }
  });
  upstream.server.on('upgrade', (_request, socket) => {
    socket.resume();
    socket.on('end', () => socket.destroy());
  });
  const proxy = await gateway(t, upstream.target);
  let stream: http.IncomingMessage | undefined;
  const events = http.get(`${proxy.url}/events`, (incoming) => {
    stream = incoming;
    incoming.on('error', () => {});
    incoming.resume();
  });
  events.on('error', () => {});
  t.after(() => events.destroy());
  const stalled = request(proxy.url);
  const ws = await rawClient(t, proxy.url);
  ws.socket.write(upgradeRequest(proxy.url));
  const started = Date.now();
  assert.equal((await stalled).status, 502);
  await eventually(() => ws.text.includes('502'), 'pending handshake has a bounded deadline');
  assert(Date.now() - started >= limits.headerTimeoutMs - 250);
  assert.equal(stream?.destroyed, false, 'an idle established SSE body has no header timeout');
  await proxy.close();
  assert.doesNotThrow(() => proxy.setTarget(undefined), 'owner cleanup can fence an already closed gateway');
  assert.throws(() => proxy.setTarget(upstream.target), /closed/);
  await eventually(() => upstream.sockets.size === 0, 'close cleans all upstream sockets');
  assert.equal(upstream.server.listening, true);
  await assert.rejects(request(proxy.url), /ECONNREFUSED/);
});

test('enforces the gateway connection limit and recovers capacity after clients leave', async (t) => {
  const upstream = await backend(t, (_request, response) => response.end('ok'));
  const proxy = await gateway(t, upstream.target);
  const clients = await Promise.all(Array.from({ length: limits.gatewayConnections }, () => rawClient(t, proxy.url)));
  const excess = await rawClient(t, proxy.url);
  await eventually(() => excess.socket.destroyed, 'excess connection is rejected');
  clients[0].socket.destroy();
  await pause(30);
  assert.equal((await request(proxy.url)).body, 'ok');
  await proxy.close();
  await eventually(() => clients.every((client) => client.socket.destroyed), 'close destroys idle downstream connections');
});

test('a pipelined client cannot bypass the in-flight proxy request bound', async (t) => {
  let accepted = 0;
  const upstream = await backend(t, () => { accepted += 1; });
  const proxy = await gateway(t, upstream.target);
  const client = await rawClient(t, proxy.url);
  client.socket.write(`GET / HTTP/1.1\r\nHost: ${new URL(proxy.url).host}\r\n\r\n`.repeat(limits.gatewayConnections + 64));
  await eventually(() => accepted >= limits.gatewayConnections, 'upstream requests reach the configured bound');
  await pause(50);
  assert.equal(accepted, limits.gatewayConnections);
  await proxy.close();
  await eventually(() => upstream.sockets.size === 0, 'all pending upstreams observe gateway closure');
});

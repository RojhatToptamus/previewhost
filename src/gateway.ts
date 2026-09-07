// HTTP forwarding is adapted from Task Monki's PreviewGateway (MIT).
// Copyright (c) 2026 Rojhat Toptamus. See LICENSE and NOTICE.
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import { limits } from './contracts.js';
import { PreviewError } from './errors.js';
import type { HttpTarget } from './resources.js';

export interface Gateway {
  readonly url: string;
  setTarget(target: HttpTarget | undefined): void;
  drain(target: HttpTarget): Promise<void>;
  close(): Promise<void>;
}

const hopHeader = 'x-previewd-hops';
const maxHops = 8;
const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

interface TargetWork {
  cleanups: Set<() => void>;
  idle: Promise<void>;
  resolveIdle(): void;
}

/** An IPv4 loopback HTTP gateway. Target object identity owns its in-flight work. */
export async function createGateway(options: { onError?: (error: Error) => void } = {}): Promise<Gateway> {
  let active: HttpTarget | undefined;
  let authority = '';
  let bound = false;
  let closing: Promise<void> | undefined;
  const sockets = new Set<net.Socket>();
  const work = new Map<HttpTarget, TargetWork>();
  const server = http.createServer(proxyRequest);
  server.headersTimeout = limits.headerTimeoutMs;
  server.maxConnections = limits.gatewayConnections;
  server.on('connection', trackSocket);
  server.on('upgrade', proxyUpgrade);
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
  });
  server.on('error', unexpectedFailure);
  server.on('close', () => {
    if (bound && !closing) unexpectedFailure(new Error('The preview gateway closed unexpectedly.'));
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new PreviewError('START_FAILED', 'The preview gateway has no listening address.'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  authority = `127.0.0.1:${port}`;
  bound = true;

  return {
    url: `http://${authority}`,
    setTarget(target) {
      if (closing) {
        if (!target) return;
        throw new PreviewError('CLOSED', 'The preview gateway is closed.');
      }
      if (target) {
        if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535
          || !/^(?:127\.0\.0\.1|localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost):[0-9]+$/.test(target.hostHeader)
          || Number(target.hostHeader.split(':')[1]) !== target.port) {
          throw new PreviewError('INVALID_INPUT', 'The preview target must be an IPv4 loopback HTTP authority.');
        }
        if (target.port === port) {
          throw new PreviewError('INVALID_INPUT', 'A preview cannot attach to its own public listener.');
        }
      }
      active = target;
    },
    async drain(target) {
      const pending = work.get(target);
      if (!pending) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          pending.idle,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              for (const cleanup of [...pending.cleanups]) cleanup();
              resolve();
            }, limits.drainMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    close,
  };

  function trackSocket(socket: net.Socket): void {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // Raw upgraded sockets no longer have the HTTP parser's error handling.
    socket.on('error', () => socket.destroy());
    if (closing) socket.destroy();
  }

  function own(target: HttpTarget, cleanup: () => void): () => void {
    let pending = work.get(target);
    if (!pending) {
      let resolveIdle!: () => void;
      const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
      pending = { cleanups: new Set(), idle, resolveIdle };
      work.set(target, pending);
    }
    const owner = pending;
    owner.cleanups.add(cleanup);
    return () => {
      owner.cleanups.delete(cleanup);
      if (owner.cleanups.size === 0) {
        if (work.get(target) === owner) work.delete(target);
        owner.resolveIdle();
      }
    };
  }

  function close(): Promise<void> {
    if (closing) return closing;
    active = undefined;
    // Install the fence before close callbacks can observe a server close.
    closing = Promise.resolve().then(async () => {
      const socketClosures = [...sockets].map((socket) => new Promise<void>((resolve) => {
        if (socket.closed) resolve();
        else socket.once('close', () => resolve());
      }));
      for (const pending of work.values()) {
        for (const cleanup of [...pending.cleanups]) cleanup();
      }
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      await Promise.all(socketClosures);
    });
    return closing;
  }

  function unexpectedFailure(error: Error): void {
    if (!bound || closing) return;
    void close().catch(() => {});
    options.onError?.(error);
  }

  function admission(request: IncomingMessage): { status: number; message: string } | undefined {
    if (singleHeader(request, 'host') !== authority) return { status: 421, message: 'Unknown preview Host.' };
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || /[\x00-\x20\x7f#]/.test(request.url)) {
      return { status: 400, message: 'Use an origin-relative request path.' };
    }
    const hops = singleHeader(request, hopHeader);
    if (hops !== undefined && !/^(?:0|[1-9][0-9]{0,2})$/.test(hops)) {
      return { status: 400, message: 'Invalid proxy hop header.' };
    }
    if (Number(hops ?? 0) >= maxHops) return { status: 508, message: 'Preview proxy loop detected.' };
    if (!active || closing) return { status: 503, message: 'The preview is not ready.' };
    // One TCP connection can pipeline many requests before any response arrives.
    let pendingRequests = 0;
    for (const pending of work.values()) pendingRequests += pending.cleanups.size;
    if (pendingRequests >= limits.gatewayConnections) return { status: 503, message: 'The preview is at its request limit.' };
    return undefined;
  }

  function headers(request: IncomingMessage, target: HttpTarget): http.OutgoingHttpHeaders {
    const result = stripHopByHop(request.headers);
    for (const key of Object.keys(result)) {
      if (key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-')) delete result[key];
    }
    return {
      ...result,
      host: target.hostHeader,
      'x-forwarded-host': authority,
      'x-forwarded-port': String(port),
      'x-forwarded-proto': 'http',
      'x-forwarded-for': request.socket.remoteAddress ?? '127.0.0.1',
      [hopHeader]: String(Number(singleHeader(request, hopHeader) ?? 0) + 1),
    };
  }

  function responseHeaders(source: IncomingHttpHeaders, target: HttpTarget): http.OutgoingHttpHeaders {
    const result = stripHopByHop(source);
    if (typeof result.location === 'string') {
      try {
        const location = new URL(result.location);
        if (!location.username && !location.password && location.origin === new URL(`http://${target.hostHeader}`).origin) {
          location.host = authority;
          result.location = location.toString();
        }
      } catch { /* A relative or non-URL Location is already forwarded unchanged. */ }
    }
    return result;
  }

  function proxyRequest(request: IncomingMessage, response: http.ServerResponse): void {
    const rejected = admission(request);
    if (rejected) {
      request.resume();
      sendError(response, rejected.status, rejected.message);
      return;
    }
    const target = active!;
    const upstream = http.request({
      host: '127.0.0.1', port: target.port, method: request.method,
      path: request.url, headers: headers(request, target), agent: false,
    });
    let done = false;
    const deadline = setTimeout(() => upstream.destroy(new Error('Upstream headers timed out.')), limits.headerTimeoutMs);
    const release = own(target, destroy);
    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      release();
    }
    function destroy(): void {
      finish();
      upstream.destroy();
      response.destroy();
    }
    function fail(): void {
      if (done) return;
      upstream.destroy();
      if (!response.headersSent) sendError(response, 502, 'The preview target is unavailable.');
      else response.destroy();
      finish();
    }
    upstream.on('socket', trackSocket);
    upstream.once('response', (incoming) => {
      clearTimeout(deadline);
      incoming.once('error', fail);
      incoming.once('aborted', fail);
      if (done) { incoming.destroy(); return; }
      try {
        response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers, target));
      } catch { fail(); return; }
      incoming.pipe(response);
    });
    upstream.once('upgrade', (_incoming, socket) => { socket.destroy(); fail(); });
    upstream.once('error', fail);
    request.once('aborted', destroy);
    request.once('error', destroy);
    response.once('error', destroy);
    response.once('finish', finish);
    response.once('close', () => {
      if (!response.writableFinished) destroy();
      else finish();
    });
    request.pipe(upstream);
  }

  function proxyUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const rejected = admission(request);
    if (rejected || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end(serializeHeaders(rejected?.status ?? 400, { connection: 'close', 'content-length': 0 }), () => socket.destroy());
      return;
    }
    const target = active!;
    const outgoingHeaders = headers(request, target);
    outgoingHeaders.connection = 'Upgrade';
    outgoingHeaders.upgrade = 'websocket';
    // Upgrade bytes are tunnel data, not an HTTP request body.
    delete outgoingHeaders['content-length'];
    const upstream = http.request({
      host: '127.0.0.1', port: target.port, method: 'GET',
      path: request.url, headers: outgoingHeaders, agent: false,
    });
    let done = false;
    let answered = false;
    let peer: Duplex | undefined;
    const deadline = setTimeout(fail, limits.headerTimeoutMs);
    const release = own(target, destroy);
    function destroy(): void {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      upstream.destroy();
      peer?.destroy();
      socket.destroy();
      release();
    }
    function fail(): void {
      if (done) return;
      if (answered || !socket.writable) { destroy(); return; }
      done = true;
      clearTimeout(deadline);
      upstream.destroy();
      release();
      socket.end(serializeHeaders(502, { connection: 'close', 'content-length': 0 }), () => socket.destroy());
    }
    upstream.on('socket', trackSocket);
    // Install cancellation before TCP connect or an upstream handshake can finish.
    socket.once('error', destroy);
    socket.once('end', destroy);
    socket.once('close', destroy);
    socket.once('finish', destroy);
    upstream.once('error', fail);
    upstream.once('upgrade', (incoming, upstreamSocket, upstreamHead) => {
      if (done) { upstreamSocket.destroy(); return; }
      answered = true;
      clearTimeout(deadline);
      peer = upstreamSocket;
      const result = responseHeaders(incoming.headers, target);
      result.connection = 'Upgrade';
      result.upgrade = 'websocket';
      delete result['content-length'];
      socket.write(serializeHeaders(101, result));
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.once('error', destroy);
      upstreamSocket.once('end', destroy);
      upstreamSocket.once('close', destroy);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstream.once('response', (incoming) => {
      if (done) { incoming.destroy(); return; }
      answered = true;
      clearTimeout(deadline);
      const result = responseHeaders(incoming.headers, target);
      result.connection = 'close';
      socket.write(serializeHeaders(incoming.statusCode ?? 502, result));
      incoming.once('error', destroy);
      incoming.once('aborted', destroy);
      incoming.pipe(socket);
    });
    upstream.end();
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  let found: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== name) continue;
    if (found !== undefined) return ''; // Duplicates are never valid admission inputs.
    found = request.rawHeaders[index + 1];
  }
  return found;
}

function stripHopByHop(source: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const nominated = new Set(String(source.connection ?? '').split(',').map((value) => value.trim().toLowerCase()));
  return Object.fromEntries(Object.entries(source).filter(([name, value]) =>
    value !== undefined && !hopByHop.has(name) && !nominated.has(name)));
}

function serializeHeaders(status: number, headers: http.OutgoingHttpHeaders): string {
  let result = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Response'}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) result += `${name}: ${item}\r\n`;
    }
  }
  return `${result}\r\n`;
}

function sendError(response: http.ServerResponse, status: number, message: string): void {
  response.shouldKeepAlive = false;
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${message}\n`);
}

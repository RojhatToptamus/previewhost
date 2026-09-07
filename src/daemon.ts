import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { limits, requestSchemas, type PreviewApi } from './contracts.js';
import { checkTokenDirectory, defaultTokenFile, readToken } from './client.js';
import { failure, PreviewError } from './errors.js';

type OwnedRuntime = PreviewApi & { close(): Promise<void> };

async function createToken(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkTokenDirectory(path);
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString('hex')}\n`); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readToken(path);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PreviewError('INVALID_INPUT', parsed.error.issues.slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '));
  return parsed.data;
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    function cleanup() {
      req.off('data', data); req.off('end', end); req.off('error', error);
      signal.removeEventListener('abort', abort);
    }
    function error(err: Error) { cleanup(); reject(err); }
    function abort() { req.pause(); error(new PreviewError('CLOSED', 'The control request was closed.')); }
    function data(chunk: Buffer) {
      length += chunk.length;
      if (length > limits.controlBytes) {
        req.pause(); error(new PreviewError('INVALID_INPUT', 'The control request exceeds 1 MiB.'));
      } else chunks.push(chunk);
    }
    function end() {
      cleanup();
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new PreviewError('INVALID_INPUT', 'Send one valid JSON object.')); }
    }
    req.on('data', data); req.once('end', end); req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Starts an explicit foreground control listener around the supplied runtime. */
export async function startDaemon(options: { runtime: OwnedRuntime; port?: number; tokenFile?: string }): Promise<{
  endpoint: string; closed: Promise<void>; close(): Promise<void>;
}> {
  const port = options.port ?? 9400;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new PreviewError('INVALID_INPUT', 'The control port must be an integer between 0 and 65535.');
  const token = await createToken(resolve(options.tokenFile ?? defaultTokenFile()));
  const runtime = options.runtime;
  const sockets = new Set<Socket>();
  const requests = new Set<AbortController>();
  let active = 0;
  let waits = 0;
  let closing = false;
  let runtimeClose: Promise<void> | undefined;
  let serverClose: Promise<void> | undefined;
  let terminalError: unknown;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // close() callers need not also subscribe to the same failure through closed.
  void closed.catch(() => {});
  const server = createServer({ connectionsCheckingInterval: 1000 });
  server.maxConnections = limits.controlRequests * 2;
  server.headersTimeout = limits.headerTimeoutMs;
  server.requestTimeout = limits.headerTimeoutMs;
  server.keepAliveTimeout = 1000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());

  function stopRuntime(): Promise<void> {
    if (!runtimeClose) {
      closing = true;
      for (const controller of requests) controller.abort();
      runtimeClose = Promise.resolve().then(() => runtime.close()).catch((error: unknown) => {
        terminalError ??= error;
        throw error;
      });
    }
    return runtimeClose;
  }
  function closeControl(): Promise<void> {
    if (!serverClose) {
      serverClose = new Promise<void>((done) => {
        server.close(() => {
          if (terminalError) rejectClosed(terminalError); else resolveClosed();
          done();
        });
        for (const socket of sockets) socket.destroy();
      });
    }
    return serverClose;
  }
  async function close(): Promise<void> {
    try { await stopRuntime(); }
    finally { await closeControl(); }
    if (terminalError) throw terminalError;
  }
  function send(res: ServerResponse, status: number, value: object) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > limits.controlBytes) {
      send(res, 500, { error: { code: 'START_FAILED', message: 'The control response exceeds 1 MiB.' } });
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store', connection: 'close', 'x-content-type-options': 'nosniff' });
    res.end(body);
  }
  function fail(res: ServerResponse, error: unknown) {
    const info = failure(error);
    const status = info.code === 'UNAUTHORIZED' ? 401 : info.code === 'INVALID_INPUT' ? 400 :
      info.code === 'NOT_FOUND' ? 404 : info.code === 'BUSY' ? 429 : info.code === 'CLOSED' ? 503 : 500;
    send(res, status, { error: info });
  }

  async function dispatch(method: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'inspect': return runtime.inspect(parse(requestSchemas.inspect, value).spec);
      case 'start': return runtime.start(parse(requestSchemas.start, value).spec);
      case 'replace': { const p = parse(requestSchemas.replace, value); return runtime.replace(p.name, p.spec); }
      case 'list': parse(requestSchemas.list, value); return runtime.list();
      case 'get': return runtime.get(parse(requestSchemas.get, value).name);
      case 'wait': { const p = parse(requestSchemas.wait, value); return runtime.wait(p.name, p.attemptId, { timeoutMs: p.timeoutMs, signal }); }
      case 'logs': { const p = parse(requestSchemas.logs, value); return runtime.logs(p.name, p.attemptId, p.maxBytes); }
      case 'cancel': { const p = parse(requestSchemas.cancel, value); return runtime.cancel(p.name, p.attemptId); }
      case 'stop': return runtime.stop(parse(requestSchemas.stop, value).name);
      default: throw new PreviewError('NOT_FOUND', 'Unknown control operation.');
    }
  }

  server.on('request', (req, res) => {
    let counted = false;
    let countedWait = false;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort();
      fail(res, new PreviewError('TIMEOUT', 'The control request timed out.'));
    }, limits.waitMs + limits.headerTimeoutMs);
    const finish = () => {
      clearTimeout(deadline);
      controller.abort(); requests.delete(controller);
      if (counted) { counted = false; active--; }
      if (countedWait) { countedWait = false; waits--; }
    };
    res.once('close', finish);
    req.once('aborted', () => controller.abort());
    void (async () => {
      const authority = `127.0.0.1:${(server.address() as { port: number }).port}`;
      const headerCount = (name: string) => req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
      if (req.headers.host !== authority || headerCount('host') !== 1 || req.headers.origin !== undefined) {
        throw new PreviewError('UNAUTHORIZED', 'Control requests require the exact loopback Host and no Origin.');
      }
      const supplied = req.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (headerCount('authorization') !== 1 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw new PreviewError('UNAUTHORIZED', 'A valid daemon bearer token is required.');
      }
      if (closing) throw new PreviewError('CLOSED', 'The daemon is shutting down.');
      if (req.method !== 'POST' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
        throw new PreviewError('INVALID_INPUT', 'Use POST with Content-Type: application/json.');
      }
      const method = req.url?.slice(1) ?? '';
      if (!Object.hasOwn(requestSchemas, method) && method !== 'shutdown') throw new PreviewError('NOT_FOUND', 'Unknown control operation.');
      const cleanup = ['stop', 'cancel', 'shutdown'].includes(method);
      if (active >= limits.controlRequests - (cleanup ? 0 : 2) || (method === 'wait' && waits >= limits.controlWaits)) {
        throw new PreviewError('BUSY', 'Control request capacity is full; stop and cancel retain reserved capacity.');
      }
      active++; counted = true;
      if (method === 'wait') { waits++; countedWait = true; }
      requests.add(controller);
      if (Number(req.headers['content-length']) > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'The control request exceeds 1 MiB.');
      const value = await readBody(req, controller.signal);
      if (controller.signal.aborted) throw new PreviewError('CLOSED', 'The control request was closed.');
      if (method === 'shutdown') {
        parse(requestSchemas.list, value);
        try { await stopRuntime(); send(res, 200, { result: null }); }
        catch (error) { fail(res, error); }
        finally {
          if (res.destroyed || res.writableFinished) await closeControl();
          else res.once('finish', () => { void closeControl(); });
        }
      } else send(res, 200, { result: await dispatch(method, value, controller.signal) });
    })().catch((error: unknown) => fail(res, error));
  });

  await new Promise<void>((ready, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); ready(); });
  });
  server.on('error', (error) => {
    terminalError ??= new PreviewError('DAEMON_UNAVAILABLE', `The control listener failed: ${error.message}`);
    void close().catch(() => {});
  });
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, closed, close };
}

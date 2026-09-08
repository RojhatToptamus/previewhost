import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { limits, requestSchemas, secretRequestSchemas } from './contracts.js';
import type { PreviewRuntime } from './runtime.js';
import { checkTokenDirectory, defaultTokenFile, readToken } from './client.js';
import { failure, PreviewError } from './errors.js';
import { SecretSetup } from './secrets-setup.js';
import { secretsPage, secretsScript, secretsStyle } from './secrets-page.js';

async function createToken(path: string, runtime: PreviewRuntime): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkTokenDirectory(path);
  await runtime.protectDirectory(dirname(path));
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
      try { resolveBody(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new PreviewError('INVALID_INPUT', 'Send one valid JSON object.')); }
    }
    req.on('data', data); req.once('end', end); req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Starts an explicit foreground control listener around the supplied runtime. */
export async function startDaemon(options: { runtime: PreviewRuntime; port?: number; tokenFile?: string }): Promise<{
  endpoint: string; closed: Promise<void>; close(): Promise<void>;
}> {
  const port = options.port ?? 9400;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new PreviewError('INVALID_INPUT', 'The control port must be an integer between 0 and 65535.');
  const token = await createToken(resolve(options.tokenFile ?? defaultTokenFile()), options.runtime);
  const runtime = options.runtime;
  let secrets: SecretSetup;
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
      runtimeClose = Promise.resolve().then(async () => { await secrets.close(); await runtime.close(); }).catch((error: unknown) => {
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
      case 'stop': { const p = parse(requestSchemas.stop, value); return runtime.stop(p.name, { afterEngineRestart: p.afterEngineRestart }); }
      case 'deleteData': return runtime.deleteData(parse(requestSchemas.deleteData, value).name);
      case 'secrets/setup': { const p = parse(secretRequestSchemas.setup, value); return secrets.setup(p.spec, signal, p.reopen); }
      case 'secrets/status': return secrets.status(parse(secretRequestSchemas.status, value).id);
      case 'secrets/edit': return secrets.setup(parse(secretRequestSchemas.edit, value).id, signal);
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
      if (req.headers.host !== authority || headerCount('host') !== 1) {
        throw new PreviewError('UNAUTHORIZED', 'Requests require the exact numeric loopback Host.');
      }
      const browser = ['/secrets/form', '/secrets/save', '/secrets/cancel'].includes(req.url ?? '');
      const asset = req.url === '/secrets' ? [secretsPage, 'text/html'] : req.url === '/secrets.js' ? [secretsScript, 'text/javascript'] :
        req.url === '/secrets.css' ? [secretsStyle, 'text/css'] : undefined;
      if (asset && req.method === 'GET') {
        if (req.headers.origin !== undefined && (req.headers.origin !== secrets.origin || headerCount('origin') !== 1)) throw new PreviewError('UNAUTHORIZED', 'Use the same origin for this private page.');
        res.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8`, 'content-length': Buffer.byteLength(asset[0]),
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", connection: 'close' });
        res.end(asset[0]); return;
      }
      if (browser ? req.headers.origin !== secrets.origin || headerCount('origin') !== 1 : req.headers.origin !== undefined) {
        throw new PreviewError('UNAUTHORIZED', browser ? 'Private form requests require the exact page Origin.' : 'Control requests cannot carry an Origin.');
      }
      const supplied = req.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (headerCount('authorization') !== 1 || !browser && (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))) {
        throw new PreviewError('UNAUTHORIZED', 'A valid daemon bearer token is required.');
      }
      if (closing) throw new PreviewError('CLOSED', 'The daemon is shutting down.');
      if (req.method !== 'POST' || headerCount('content-type') !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
        throw new PreviewError('INVALID_INPUT', 'Use POST with Content-Type: application/json.');
      }
      const method = req.url?.slice(1) ?? '';
      if (!Object.hasOwn(requestSchemas, method) && !['secrets/setup', 'secrets/status', 'secrets/edit'].includes(method) && !browser && method !== 'shutdown') throw new PreviewError('NOT_FOUND', 'Unknown control operation.');
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
      if (browser) {
        const result = method === 'secrets/save' ? await secrets.save(supplied, value) : (parse(requestSchemas.list, value),
          method === 'secrets/cancel' ? secrets.cancel(supplied) : secrets.form(supplied));
        send(res, 200, { result });
      } else if (method === 'shutdown') {
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
    server.listen(port, '127.0.0.1', () => {
      secrets = new SecretSetup(runtime, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
      server.off('error', reject); ready();
    });
  });
  server.on('error', (error) => {
    terminalError ??= new PreviewError('DAEMON_UNAVAILABLE', `The control listener failed: ${error.message}`);
    void close().catch(() => {});
  });
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, closed, close };
}

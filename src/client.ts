import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { request, type ClientRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { limits, type ErrorCode, type PreviewApi, type SecretSetupApi } from './contracts.js';
import { PreviewError } from './errors.js';

export interface ClientOptions { endpoint?: string; tokenFile?: string }
export const defaultEndpoint = 'http://127.0.0.1:9400';
// Retain the existing token path so renamed clients reconnect without moving secrets.
export const defaultTokenFile = (): string => join(homedir(), '.local', 'share', 'previewd', 'token');

/** Shared by the local transport's reader and creator, not a permission grant. */
export async function checkTokenDirectory(path: string): Promise<void> {
  const info = await lstat(dirname(path));
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new PreviewError('UNAUTHORIZED', 'The token directory must be owned by this user, private (0700), and not a symlink.');
  }
}

export async function readToken(path: string): Promise<string> {
  try {
    await checkTokenDirectory(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 65 ||
          (process.getuid && info.uid !== process.getuid())) {
        throw new PreviewError('UNAUTHORIZED', 'The token file must be a private (0600) regular file owned by this user.');
      }
      const buffer = Buffer.alloc(66);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65) throw new PreviewError('UNAUTHORIZED', 'The token file is invalid.');
      const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new PreviewError('UNAUTHORIZED', 'The token file is invalid.');
      return token;
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PreviewError('DAEMON_UNAVAILABLE', `No daemon token exists at ${path}. Start previewhost serve with this --token-file.`);
    }
    throw new PreviewError('UNAUTHORIZED', 'Cannot read the token file safely. Check its ownership, permissions, and symlinks.');
  }
}

/** Connects on demand. Closing this client never stops daemon-owned previews. */
export function connectPreviewDaemon(options: ClientOptions = {}): PreviewApi & SecretSetupApi & {
  close(): Promise<void>; shutdown(): Promise<void>;
} {
  let endpoint: URL;
  const endpointText = options.endpoint ?? defaultEndpoint;
  try { endpoint = new URL(endpointText); }
  catch { throw new PreviewError('INVALID_INPUT', 'Use an HTTP control endpoint at 127.0.0.1 with an explicit port.'); }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      !/:\d+\/?$/.test(endpointText) || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      endpoint.username || endpoint.password) {
    throw new PreviewError('INVALID_INPUT', 'Use an HTTP control endpoint at 127.0.0.1 with an explicit port and no path or credentials.');
  }
  const port = endpoint.port || '80';
  const tokenFile = resolve(options.tokenFile ?? defaultTokenFile());
  const pending = new Set<ClientRequest>();
  let closed = false;

  async function call<T>(method: string, args: object, signal?: AbortSignal): Promise<T> {
    if (closed || signal?.aborted) throw new PreviewError('CLOSED', 'The client request was closed.');
    let body: string;
    try { body = JSON.stringify(args); }
    catch { throw new PreviewError('INVALID_INPUT', 'The request must contain JSON data without cycles.'); }
    if (Buffer.byteLength(body) > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'The request exceeds 1 MiB.');
    const token = await readToken(tokenFile);
    if (closed || signal?.aborted) throw new PreviewError('CLOSED', 'The client request was closed.');
    return new Promise<T>((resolveResult, reject) => {
      const req = request(new URL(`/${method}`, endpoint), {
        method: 'POST', agent: false,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      pending.add(req);
      let settled = false;
      const finish = (error?: PreviewError, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { req.destroy(); reject(error); }
        else resolveResult(value as T);
      };
      const abort = () => finish(new PreviewError('CLOSED', 'The client request was closed.'));
      const timer = setTimeout(() => finish(new PreviewError('TIMEOUT', 'The daemon request timed out; use get/list to check whether a mutation completed.')), limits.waitMs + 10_000);
      signal?.addEventListener('abort', abort, { once: true });
      req.once('close', () => {
        pending.delete(req);
        finish(new PreviewError('DAEMON_UNAVAILABLE', 'The daemon response ended before completion. Check get/list before retrying a mutation.'));
      });
      req.once('error', (error) => {
        finish(error instanceof PreviewError ? error : new PreviewError('DAEMON_UNAVAILABLE',
          `Cannot reach previewhost at ${endpoint.origin}. Start previewhost serve --port ${port} with the same --token-file. A failed mutation response does not prove the operation stopped.`));
      });
      req.once('upgrade', (_res, socket) => {
        socket.destroy();
        finish(new PreviewError('DAEMON_UNAVAILABLE', 'The control endpoint unexpectedly upgraded the connection. Check the endpoint and get/list before retrying a mutation.'));
      });
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > limits.controlBytes) finish(new PreviewError('DAEMON_UNAVAILABLE', 'The daemon response exceeds 1 MiB.'));
          else chunks.push(chunk);
        });
        res.once('error', () => {
          finish(new PreviewError('DAEMON_UNAVAILABLE', 'The daemon response ended before completion. Check get/list before retrying a mutation.'));
        });
        res.once('end', () => {
          try {
            const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object') throw new Error('Invalid response');
            if ('error' in data) {
              const err = data.error;
              if (!err || typeof err !== 'object' || !('code' in err) || typeof err.code !== 'string' ||
                  !('message' in err) || typeof err.message !== 'string') throw new Error('Invalid error');
              finish(new PreviewError(err.code as ErrorCode, err.message, {
                ...('requirements' in err && Array.isArray(err.requirements) ? { requirements: err.requirements } : {}),
                ...('outcome' in err && err.outcome === 'unknown' ? { outcome: 'unknown' as const } : {}),
              }));
            } else if (res.statusCode === 200 && 'result' in data) finish(undefined, data.result as T);
            else throw new Error('Invalid response');
          } catch {
            finish(new PreviewError('DAEMON_UNAVAILABLE', 'The control endpoint returned an invalid previewhost response.'));
          }
        });
      });
      req.end(body);
    });
  }

  return {
    inspect: (spec) => call('inspect', { spec }),
    start: (spec) => call('start', { spec }),
    replace: (name, spec) => call('replace', { name, spec }),
    list: () => call('list', {}),
    get: (name) => call('get', { name }),
    wait: (name, attemptId, opts = {}) => call('wait', { name, attemptId, timeoutMs: opts.timeoutMs }, opts.signal),
    logs: (name, attemptId, maxBytes) => call('logs', { name, attemptId, maxBytes }),
    cancel: (name, attemptId) => call('cancel', { name, attemptId }),
    stop: (name, opts = {}) => call('stop', { name, afterEngineRestart: opts.afterEngineRestart }),
    deleteData: (name) => call('deleteData', { name }),
    secretsSetup: (spec, opts = {}) => call('secrets/setup', { spec, reopen: opts.reopen }, opts.signal),
    secretsStatus: (id) => call('secrets/status', { id }),
    secretsEdit: (id, opts = {}) => call('secrets/edit', { id }, opts.signal),
    shutdown: async () => { await call('shutdown', {}); },
    close: async () => {
      closed = true;
      await Promise.all([...pending].map((req) => new Promise<void>((done) => {
        req.once('close', done);
        req.destroy(new PreviewError('CLOSED', 'The previewhost client was closed.'));
      })));
    },
  };
}

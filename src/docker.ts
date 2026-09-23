import http from 'node:http';
import type { Socket } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { PreviewError, throwIfAborted } from './errors.js';
import { connectWindowsPipe } from './windows.js';

export function defaultDockerEndpoint(): string {
  if (process.platform === 'win32') return String.raw`\\.\pipe\docker_engine`;
  return process.platform === 'darwin' ? join(homedir(), '.docker/run/docker.sock') : '/var/run/docker.sock';
}

/** Only local transports. Explicit paths win; ambient Docker contexts never retarget retained data. */
export function normalizeDockerEndpoint(value: string, platform = process.platform): string {
  if (platform === 'win32') {
    const pipe = value.replace(/^npipe:\/\/\/\/\.\/pipe\//i, '\\\\.\\pipe\\');
    if (/^\\\\\.\\pipe\\[a-z0-9_.-]+$/i.test(pipe)) return pipe.toLowerCase();
  } else {
    const path = value.startsWith('unix://') ? value.slice(7) : value;
    if (!path.includes('://') && !path.startsWith('\\') && (!value.startsWith('unix://') || posix.isAbsolute(path))) return posix.resolve(path);
  }
  throw new PreviewError('INVALID_INPUT', 'Select a local Docker Unix socket or Windows named pipe. Remote Docker endpoints are not supported.');
}

export interface DockerResponse { status: number; body: unknown }
export interface DockerAttach { send(value: string): void; close(): Promise<void> }

/** Direct local Engine transport. Mutations deliberately have no cancellation signal. */
export class Docker {
  constructor(readonly socket: string) {}

  private connectionOptions(signal: AbortSignal): http.RequestOptions {
    // agent:false would override createConnection with Node's default, unverified pipe connection.
    return process.platform === 'win32' ? { createConnection: (_options, callback) => {
      void connectWindowsPipe(this.socket, signal).then(socket => callback!(null, socket), error => callback!(error, undefined!));
      return undefined;
    } } : { agent: false };
  }

  static async connect(socket: string): Promise<Docker> {
    const endpoint = normalizeDockerEndpoint(socket);
    if (process.platform === 'win32') return new Docker(endpoint);
    try {
      const canonical = await realpath(endpoint);
      if (!(await stat(canonical)).isSocket()) throw new Error();
      return new Docker(canonical);
    } catch {
      throw new PreviewError('START_FAILED', 'The configured local Docker socket is unavailable.');
    }
  }

  request(method: string, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DockerResponse> {
    if (options.signal) throwIfAborted(options.signal);
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      let result: DockerResponse | undefined;
      let error: Error | undefined;
      let ended = false;
      const connecting = new AbortController();
      const req = http.request({ ...this.connectionOptions(connecting.signal), socketPath: this.socket, path: `/v1.40${path}`, method,
        headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {} }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) fail(); else chunks.push(chunk);
        });
        res.once('error', fail);
        res.once('end', () => {
          ended = true;
          try {
            result = { status: res.statusCode ?? 0, body: size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined };
          } catch { fail(); }
        });
        res.once('close', () => { if (!ended) fail(); });
      });
      const fail = (cause?: Error) => {
        error ??= cause instanceof PreviewError ? cause : new PreviewError('CLEANUP_INCOMPLETE', 'The local Docker request did not complete.');
        connecting.abort(error);
        req.destroy();
      };
      const abort = () => {
        error = new PreviewError('CLOSED', 'The Docker observation was canceled.');
        connecting.abort(error);
        req.destroy();
      };
      const timer = options.timeoutMs === 0 ? undefined : setTimeout(fail, options.timeoutMs ?? 15_000);
      options.signal?.addEventListener('abort', abort, { once: true });
      req.once('error', cause => {
        fail(cause);
        // A rejected createConnection emits error without assigning a socket or emitting close.
        if (!req.socket) finish();
      });
      req.once('upgrade', (_res, socket) => { socket.destroy(); fail(); });
      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error || !result) reject(error ?? new PreviewError('CLEANUP_INCOMPLETE', 'The local Docker response was incomplete.'));
        else resolve(result);
      };
      req.once('close', finish);
      req.end(encoded);
    });
  }

  async engineId(options: { signal?: AbortSignal } = {}): Promise<string> {
    const result = await this.request('GET', '/info', undefined, options);
    const id = object(result.body).ID;
    if (result.status !== 200 || typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) {
      throw new PreviewError('CLEANUP_INCOMPLETE', 'The local Docker engine identity could not be verified.');
    }
    return id;
  }

  async image(type: 'postgres' | 'redis', options: { signal?: AbortSignal } = {}): Promise<string> {
    const tag = type === 'postgres' ? 'postgres:17-alpine' : 'redis:7-alpine';
    const inspected = await this.request('GET', `/images/docker.io/library/${tag}/json`, undefined, options);
    const id = object(inspected.body).Id;
    if (inspected.status !== 200 || typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) {
      throw new PreviewError('START_FAILED', `Install the local Docker image ${tag} before starting this environment.`);
    }
    return id;
  }

  attach(id: string): Promise<DockerAttach> {
    return new Promise((resolve, reject) => {
      let socket: Socket | undefined;
      let delivered = false;
      const connecting = new AbortController();
      const req = http.request({ ...this.connectionOptions(connecting.signal), socketPath: this.socket,
        path: `/v1.40/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        method: 'POST', headers: { connection: 'Upgrade', upgrade: 'tcp' } });
      const fail = (cause?: Error) => {
        connecting.abort(cause);
        clearTimeout(timer); req.destroy(); socket?.destroy();
        if (!delivered) reject(cause instanceof PreviewError ? cause : new PreviewError('START_FAILED', 'Docker could not open the database initialization stream.'));
      };
      const timer = setTimeout(fail, 15_000);
      req.once('error', fail);
      req.once('response', (res) => { res.destroy(); fail(); });
      req.once('upgrade', (res, stream, head) => {
        socket = stream;
        if (res.statusCode !== 101) { fail(); return; }
        clearTimeout(timer);
        let size = head.length;
        const closed = new Promise<void>((done) => stream.once('close', () => done()));
        stream.on('error', () => {});
        stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65_536) stream.destroy(); });
        delivered = true;
        resolve({
          send(value) {
            if (Buffer.byteLength(value) > 4096 || stream.destroyed) throw new PreviewError('START_FAILED', 'Database initialization input could not be delivered.');
            stream.end(value);
          },
          async close() { stream.destroy(); await closed; },
        });
      });
      req.end();
    });
  }
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

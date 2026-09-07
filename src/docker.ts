import http from 'node:http';
import type { Socket } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import { PreviewError, throwIfAborted } from './errors.js';

export interface DockerResponse { status: number; body: unknown }
export interface DockerAttach { send(value: string): void; close(): Promise<void> }

/** Direct local Engine transport. Mutations deliberately have no cancellation signal. */
export class Docker {
  constructor(readonly socket: string) {}

  static async connect(socket: string): Promise<Docker> {
    try {
      const canonical = await realpath(socket);
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
      const req = http.request({ socketPath: this.socket, path: `/v1.40${path}`, method, agent: false,
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
      const fail = () => {
        error ??= new PreviewError('CLEANUP_INCOMPLETE', 'The local Docker request did not complete.');
        req.destroy();
      };
      const abort = () => {
        error = new PreviewError('CLOSED', 'The Docker observation was canceled.');
        req.destroy();
      };
      const timer = options.timeoutMs === 0 ? undefined : setTimeout(fail, options.timeoutMs ?? 15_000);
      options.signal?.addEventListener('abort', abort, { once: true });
      req.once('error', fail);
      req.once('upgrade', (_res, socket) => { socket.destroy(); fail(); });
      req.once('close', () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error || !result) reject(error ?? new PreviewError('CLEANUP_INCOMPLETE', 'The local Docker response was incomplete.'));
        else resolve(result);
      });
      req.end(encoded);
    });
  }

  async engineId(): Promise<string> {
    const result = await this.request('GET', '/info');
    const id = object(result.body).ID;
    if (result.status !== 200 || typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) {
      throw new PreviewError('CLEANUP_INCOMPLETE', 'The local Docker engine identity could not be verified.');
    }
    return id;
  }

  async image(type: 'postgres' | 'redis'): Promise<string> {
    const tag = type === 'postgres' ? 'postgres:17-alpine' : 'redis:7-alpine';
    const listed = await this.request('GET', '/images/json');
    if (listed.status !== 200 || !Array.isArray(listed.body)) throw new PreviewError('START_FAILED', 'The local Docker images could not be checked.');
    const image = listed.body.map(object).find((item) => Array.isArray(item.RepoTags) && item.RepoTags.includes(tag));
    if (typeof image?.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) {
      throw new PreviewError('START_FAILED', `Install the local Docker image ${tag} before starting this environment.`);
    }
    const inspected = await this.request('GET', `/images/${image.Id}/json`);
    if (inspected.status !== 200 || object(inspected.body).Id !== image.Id) throw new PreviewError('START_FAILED', 'The local Docker image changed during inspection.');
    return image.Id;
  }

  attach(id: string): Promise<DockerAttach> {
    return new Promise((resolve, reject) => {
      let socket: Socket | undefined;
      let delivered = false;
      const req = http.request({ socketPath: this.socket,
        path: `/v1.40/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        method: 'POST', agent: false, headers: { connection: 'Upgrade', upgrade: 'tcp' } });
      const fail = () => {
        clearTimeout(timer); req.destroy(); socket?.destroy();
        if (!delivered) reject(new PreviewError('START_FAILED', 'Docker could not open the database initialization stream.'));
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

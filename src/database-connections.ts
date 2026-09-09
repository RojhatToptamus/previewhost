import { Socket } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { Client } from 'pg';
import { createClient } from 'redis';
import { PreviewError, throwIfAborted } from './errors.js';

type DatabaseType = 'postgres' | 'redis';

export function validateDatabaseUrl(type: DatabaseType, value: string): string {
  try {
    if (value.length > 4096 || /[\s\\\0]/u.test(value)) throw new Error();
    const url = new URL(value);
    const parts = value.match(/^[a-z]+:\/\/([^/]+)(\/.*)$/);
    const authority = parts?.[1];
    if (!authority || !/^(?:[^@]*@)?127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(authority)
      || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) > 65535
      || url.search || url.hash || parts?.[2] !== url.pathname) throw new Error();
    if (!(type === 'postgres' ? ['postgres:', 'postgresql:'] : ['redis:']).includes(url.protocol)) throw new Error();
    if (type === 'postgres' && !url.username) throw new Error();
    if (type === 'redis' && url.username && !url.password) throw new Error();
    const database = decodeURIComponent(url.pathname.slice(1));
    if (type === 'postgres' ? !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(database) : !/^(?:0|[1-9][0-9]{0,4})$/.test(database)) throw new Error();
    for (const part of [url.username, url.password]) {
      if (/[\x00-\x1f\x7f]/.test(decodeURIComponent(part))) throw new Error();
    }
    return url.href;
  } catch {
    throw new PreviewError('INVALID_INPUT', 'Use 127.0.0.1 with an explicit port and database, without query or fragment. PostgreSQL requires a username; a Redis username requires a password.');
  }
}

export function databaseRedactions(value: string): string[] {
  const url = new URL(value);
  return [...new Set([value, url.href, url.username, url.password,
    decodeURIComponent(url.username), decodeURIComponent(url.password)].filter(Boolean))];
}

/** One authenticated protocol query. Driver errors never cross the credential boundary. */
export async function probeDatabase(type: DatabaseType, value: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<void> {
  const url = new URL(validateDatabaseUrl(type, value));
  throwIfAborted(options.signal);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, options.timeoutMs))]);
  let dispose: () => void = () => {};
  let joined: Promise<unknown> = Promise.resolve();
  const abort = () => dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (type === 'postgres') {
      const socket = new Socket();
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      const config = {
        host: '127.0.0.1', port: Number(url.port), user: decodeURIComponent(url.username),
        database: decodeURIComponent(url.pathname.slice(1)), password: () => decodeURIComponent(url.password),
        ssl: false, sslnegotiation: 'postgres' as const, stream: () => socket,
        connectionTimeoutMillis: options.timeoutMs, query_timeout: options.timeoutMs,
        application_name: 'previewhost', client_encoding: 'UTF8', options: ' ', replication: 'false',
      };
      const client = new Client(config);
      client.on('error', () => {});
      dispose = () => { socket.destroy(); };
      joined = closed;
      await client.connect();
      const result = await client.query('SELECT 1 AS ready');
      if (result.rows[0]?.ready !== 1) throw new Error();
    } else {
      const controller = new AbortController();
      const client = createClient({
        socket: { host: '127.0.0.1', port: Number(url.port), tls: false, connectTimeout: options.timeoutMs,
          reconnectStrategy: false, signal: controller.signal },
        username: decodeURIComponent(url.username) || undefined, password: decodeURIComponent(url.password) || undefined,
        database: Number(url.pathname.slice(1)), disableOfflineQueue: true, commandsQueueMaxLength: 8,
      });
      client.on('error', () => {});
      dispose = () => { if (client.isOpen) client.destroy(); controller.abort(); };
      // The client joins connection initialization; destroy rejects any pending command.
      joined = client.connect();
      await joined;
      if (await client.ping() !== 'PONG') throw new Error();
    }
    throwIfAborted(signal);
  } catch {
    throw new PreviewError(options.signal.aborted ? 'CLOSED' : signal.aborted ? 'TIMEOUT' : 'START_FAILED',
      options.signal.aborted ? 'The database check was canceled.' : 'The authenticated database check failed.');
  } finally {
    signal.removeEventListener('abort', abort);
    dispose();
    await joined.catch(() => {});
    // Redis destroys its socket synchronously; let pending close callbacks settle.
    await setImmediate();
  }
}

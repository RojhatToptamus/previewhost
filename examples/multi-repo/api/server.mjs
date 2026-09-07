import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from 'redis';

const database = new URL(process.env.DATABASE_URL);
const redisUrl = new URL(process.env.REDIS_URL);
const revision = process.env.REVISION ?? 'v1';
const origins = new Set([process.env.FRONTEND_ORIGIN, process.env.FRONTEND_NUMERIC_ORIGIN]);
const pool = new pg.Pool({
  host: database.hostname, port: Number(database.port), database: decodeURIComponent(database.pathname.slice(1)),
  user: decodeURIComponent(database.username), password: () => decodeURIComponent(database.password), ssl: false,
  max: 4, connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000, idleTimeoutMillis: 1000,
});
const cache = createClient({
  socket: { host: redisUrl.hostname, port: Number(redisUrl.port), connectTimeout: 2000, reconnectStrategy: false },
  username: decodeURIComponent(redisUrl.username) || 'default', password: decodeURIComponent(redisUrl.password),
  database: Number(redisUrl.pathname.slice(1) || '0'), disableOfflineQueue: true, commandsQueueMaxLength: 32,
});
pool.on('error', () => console.error('api: PostgreSQL connection failed.'));
cache.on('error', () => console.error('api: Redis connection failed.'));
const redis = () => cache.withCommandOptions({ timeout: 2000 });

const server = http.createServer((request, response) => { void handle(request, response); });
server.requestTimeout = server.headersTimeout = 5000;
server.maxConnections = server.maxRequestsPerSocket = 32;

function json(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function handle(request, response) {
  const origin = request.headers.origin;
  response.setHeader('vary', 'Origin');
  if (origin && !origins.has(origin)) { json(response, 403, { error: 'This browser origin is not allowed.' }); return; }
  if (origin) response.setHeader('access-control-allow-origin', origin);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
    response.end(); return;
  }
  try {
    if (request.method === 'GET' && request.url === '/ready') {
      await Promise.all([pool.query('SELECT 1'), redis().ping()]);
      json(response, 200, { ready: true, service: 'api', revision });
    } else if (request.method === 'GET' && request.url === '/notes') {
      const notes = await pool.query('SELECT id, text, revision, created_at AS "createdAt" FROM previewd_demo_notes ORDER BY created_at DESC, id DESC LIMIT 20');
      json(response, 200, { service: 'api', revision, notes: notes.rows });
    } else if (request.method === 'POST' && request.url === '/notes') {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2048) { json(response, 413, { error: 'The note request is too large.' }); return; }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(response, 400, { error: 'Send one JSON note.' }); return; }
      const text = typeof input?.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 160) { json(response, 400, { error: 'Write a note with 1 to 160 characters.' }); return; }
      const saved = await pool.query('INSERT INTO previewd_demo_notes (id, text, revision) VALUES ($1, $2, $3) RETURNING id, text, revision, created_at AS "createdAt"', [randomUUID(), text, revision]);
      const note = saved.rows[0];
      // PostgreSQL owns the note. A cache failure does not undo an accepted write.
      const cacheUpdated = await redis().set('previewd:demo:latest-note', JSON.stringify(note)).then(() => true, () => false);
      json(response, 201, { note, cacheUpdated, revision });
    } else json(response, 404, { error: 'Use /notes or /ready.' });
  } catch {
    json(response, 503, { error: 'The API cannot reach a dependency. Retry after the services recover.' });
  }
}

let stopping;
function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    const closed = server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
    server.closeAllConnections();
    if (cache.isOpen) cache.destroy();
    await Promise.all([closed, pool.end()]);
  })();
  return stopping;
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });

try {
  await cache.connect();
  // This demo application owns its table. previewd does not run migrations.
  await pool.query('CREATE TABLE IF NOT EXISTS previewd_demo_notes (id uuid PRIMARY KEY, text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 160), revision text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
  if (!stopping) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1', resolve);
    });
    console.log(`api ${revision}: ready for HTTP requests.`);
  }
} catch {
  console.error('api: startup failed. Check the database and cache.');
  process.exitCode = 1;
  await stop();
}

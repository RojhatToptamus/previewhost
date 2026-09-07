import http from 'node:http';
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
pool.on('error', () => console.error('reporting: PostgreSQL connection failed.'));
cache.on('error', () => console.error('reporting: Redis connection failed.'));
const redis = () => cache.withCommandOptions({ timeout: 2000 });

async function apiReady() {
  const response = await fetch(new URL('/ready', process.env.API_URL), { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('API unavailable');
  return response.json();
}
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
    response.writeHead(204, { 'access-control-allow-methods': 'GET, OPTIONS' }); response.end(); return;
  }
  try {
    if (request.method === 'GET' && request.url === '/ready') {
      const [api] = await Promise.all([apiReady(), pool.query('SELECT 1'), redis().ping()]);
      json(response, 200, { ready: true, service: 'reporting', revision, apiRevision: api.revision });
    } else if (request.method === 'GET' && request.url === '/summary') {
      const [notes, latest, api] = await Promise.all([
        pool.query('SELECT count(*)::int AS total FROM previewd_demo_notes'),
        redis().get('previewd:demo:latest-note'), apiReady(),
      ]);
      json(response, 200, { service: 'reporting', revision, apiRevision: api.revision, totalNotes: notes.rows[0].total, cachedNote: latest ? JSON.parse(latest) : null });
    } else json(response, 404, { error: 'Use /summary or /ready.' });
  } catch {
    json(response, 503, { error: 'Reporting cannot reach the API, PostgreSQL, or Redis. Retry after the services recover.' });
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
  if (!stopping) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1', resolve);
    });
    console.log(`reporting ${revision}: ready for HTTP requests.`);
  }
} catch {
  console.error('reporting: startup failed. Check the cache.');
  process.exitCode = 1;
  await stop();
}

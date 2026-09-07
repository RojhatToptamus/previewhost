import http from 'node:http';
import { readFile } from 'node:fs/promises';

const revision = process.env.REVISION ?? 'v1';
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const server = http.createServer((request, response) => { void handle(request, response); });
server.requestTimeout = server.headersTimeout = 5000;
server.maxConnections = server.maxRequestsPerSocket = 32;

function json(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function handle(request, response) {
  try {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (request.url === '/ready') {
      const dependencies = await Promise.all([process.env.API_URL, process.env.REPORTING_URL].map(async (url) => {
        const reply = await fetch(new URL('/ready', url), { signal: AbortSignal.timeout(2000) });
        if (!reply.ok) throw new Error('Backend unavailable');
        return reply.json();
      }));
      json(response, 200, { ready: true, service: 'frontend', revision, dependencies: Object.fromEntries(dependencies.map((item) => [item.service, item.revision])) });
    } else if (request.url === '/config') {
      json(response, 200, { revision, apiUrl: process.env.PUBLIC_API_URL, reportingUrl: process.env.PUBLIC_REPORTING_URL });
    } else if (files.has(request.url)) {
      const [file, type] = files.get(request.url);
      const body = await readFile(new URL(file, import.meta.url));
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(body);
    } else { response.writeHead(404); response.end('Not found.'); }
  } catch {
    if (!response.destroyed) json(response, 503, { error: 'The frontend cannot reach the API or reporting service.' });
  }
}
function stop() { server.close(); server.closeAllConnections(); }
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
server.listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1', () => console.log(`frontend ${revision}: ready for HTTP requests.`));

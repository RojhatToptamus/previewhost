import http from 'node:http';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Socket } from 'node:net';
import { isWithin } from './spec.js';
import type { Resource } from './resources.js';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.map': 'application/json',
};

export async function startStatic(directory: string, spa: boolean, privateDirectories: ReadonlySet<string> = new Set()): Promise<Resource> {
  const sockets = new Set<Socket>();
  let stopping: Promise<void> | undefined;
  let lost!: (error: Error) => void;
  const exited = new Promise<Error>((resolve) => { lost = resolve; });
  const server = http.createServer((request, response) => {
    void serve(directory, spa, privateDirectories, request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(500); response.end('File could not be read.'); }
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('error', (error) => { if (!stopping) lost(error); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static listener address is unavailable.');
  return {
    target: { port: address.port, hostHeader: `127.0.0.1:${address.port}` }, exited,
    stop() {
      stopping ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => error ? reject(error) : resolve());
      });
      return stopping;
    },
  };
}

async function serve(directory: string, spa: boolean, privateDirectories: ReadonlySet<string>, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const error = (status: number, message: string) => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); response.end(message); };
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('allow', 'GET, HEAD'); error(405, 'Method not allowed.'); return; }
  const raw = request.url ?? '/';
  const question = raw.indexOf('?');
  const rawPath = question < 0 ? raw : raw.slice(0, question);
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { error(400, 'Invalid URL path.'); return; }
  const segments = decoded.split('/').filter(Boolean);
  if (!decoded.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(decoded) || segments.some((part) => part.startsWith('.'))) {
    error(403, 'Path is not available.'); return;
  }
  let filename = path.join(directory, ...segments);
  const available = (filename: string) => isWithin(directory, filename)
    && ![...privateDirectories].some((root) => isWithin(root, filename));
  try {
    filename = await fs.realpath(filename);
    if (!available(filename)) { error(403, 'Path is not available.'); return; }
    if ((await fs.stat(filename)).isDirectory()) {
      if (!decoded.endsWith('/')) {
        response.writeHead(301, { location: `${rawPath}/${question < 0 ? '' : raw.slice(question)}` }); response.end(); return;
      }
      filename = await fs.realpath(path.join(filename, 'index.html'));
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') { error(404, 'File not found.'); return; }
    if (!spa || path.extname(decoded)) { error(404, 'File not found.'); return; }
    try { filename = await fs.realpath(path.join(directory, 'index.html')); } catch { error(404, 'File not found.'); return; }
  }
  if (!available(filename)
    || path.relative(directory, filename).split(path.sep).some((part) => part.startsWith('.'))) { error(403, 'Path is not available.'); return; }
  if (!(await fs.stat(filename)).isFile()) { error(404, 'File not found.'); return; }
  let file: fs.FileHandle;
  try { file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { error(404, 'File not found.'); return; }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) { error(404, 'File not found.'); await file.close(); return; }
    if (response.destroyed) { await file.close(); return; }
    response.writeHead(200, { 'content-type': mime[path.extname(filename).toLowerCase()] ?? 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (request.method === 'HEAD') { response.end(); await file.close(); return; }
    const stream = file.createReadStream();
    response.once('close', () => stream.destroy());
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  } catch (cause) { await file.close(); throw cause; }
}

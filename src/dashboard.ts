import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { connectPreviewDaemon } from './client.js';
import { limits, requestSchemas } from './contracts.js';
import { readBody } from './daemon.js';
import { failure, PreviewError } from './errors.js';
import { openLocalBrowser } from './local-browser.js';
import { discoverProjectOwners, ownerInfoSchema } from './project.js';
import { dashboardPage, dashboardScript, dashboardStyle } from './dashboard-page.js';

const ownerId = z.string().regex(/^[a-f0-9]{64}$/);
const actionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  requestSchemas.stop.omit({ afterEngineRestart: true }).extend({ action: z.literal('stop'), owner: ownerId }).required({ expected: true }),
  requestSchemas.cancel.extend({ action: z.literal('cancel'), owner: ownerId }),
  requestSchemas.startAgain.extend({ action: z.literal('startAgain'), owner: ownerId }),
  requestSchemas.saveConfiguration.extend({ action: z.literal('saveConfiguration'), owner: ownerId }),
  requestSchemas.describe.extend({ action: z.literal('describe'), owner: ownerId }),
  requestSchemas.logs.extend({ action: z.literal('logs'), owner: ownerId }),
  z.strictObject({ action: z.literal('secretsOpen'), owner: ownerId, id: z.uuid() }),
]);

/** An optional browser client of existing owners. It never starts or shuts down an owner. */
export async function startDashboard(options: {
  discover?: typeof discoverProjectOwners;
  openBrowser?: typeof openLocalBrowser;
} = {}) {
  const discover = options.discover ?? discoverProjectOwners;
  const capability = randomBytes(32).toString('hex');
  const clients = new Set<ReturnType<typeof connectPreviewDaemon>>();
  const controller = new AbortController();
  const server = createServer({ connectionsCheckingInterval: 1000 });
  server.maxConnections = 32;
  server.headersTimeout = limits.headerTimeoutMs;
  server.requestTimeout = limits.headerTimeoutMs;
  server.keepAliveTimeout = 1000;
  let active = 0;
  let origin = '';
  let closing: Promise<void> | undefined;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());

  async function withOwner<T>(owner: Awaited<ReturnType<typeof discover>>[number], operation: (client: ReturnType<typeof connectPreviewDaemon>) => Promise<T>, readBudget?: number): Promise<T> {
    if (controller.signal.aborted) throw new PreviewError('CLOSED', 'The dashboard is closed.');
    if (!owner.connection) throw new PreviewError('UNAUTHORIZED', 'The project owner record is unavailable or unsafe.');
    const client = connectPreviewDaemon({ endpoint: owner.connection.endpoint, tokenFile: owner.tokenFile });
    clients.add(client);
    let expired = false;
    const timer = readBudget === undefined ? undefined : setTimeout(() => { expired = true; void client.close(); }, readBudget);
    try {
      const info = ownerInfoSchema.safeParse(await client.info());
      if (!info.success || info.data.projectDirectory !== owner.connection.projectDirectory || info.data.pid !== owner.connection.pid) {
        throw new PreviewError('UNAUTHORIZED', 'The responding owner does not match its project record.');
      }
      return await operation(client);
    } catch (error) {
      if (expired) throw new PreviewError('TIMEOUT', 'This owner did not respond. Other projects remain available.');
      throw error;
    } finally { clearTimeout(timer); clients.delete(client); await client.close(); }
  }

  async function dispatch(input: unknown) {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) throw new PreviewError('INVALID_INPUT', 'Invalid dashboard action. Refresh the page and try again.');
    const p = parsed.data;
    const owners = await discover();
    if (p.action === 'list') {
      return Promise.all(owners.map(async owner => {
        const identity = { id: owner.id, project: owner.connection?.projectDirectory };
        try {
          if (owner.error) return { ...identity, error: owner.error };
          return await withOwner(owner, async client => {
            const previews = await client.list();
            try { return { ...identity, previews, requests: await client.secretsList() }; }
            catch (error) {
              if (!(error instanceof PreviewError) || error.code !== 'NOT_FOUND') throw error;
              return { ...identity, previews, requests: [], legacy: true };
            }
          }, 3000);
        } catch (error) { return { ...identity, error: failure(error) }; }
      }));
    }
    const owner = owners.find(owner => owner.id === p.owner);
    if (!owner) throw new PreviewError('NOT_FOUND', 'This owner is no longer available. Refresh the list.');
    return withOwner<unknown>(owner, async client => {
      switch (p.action) {
        case 'stop': return client.stop(p.name, { expected: p.expected });
        case 'cancel': return client.cancel(p.name, p.attemptId);
        case 'startAgain': return client.startAgain(p.name, p.attemptId);
        case 'saveConfiguration': return client.saveConfiguration(p.name, p.attemptId);
        case 'describe': return client.describe(p.name, p.attemptId);
        case 'logs': return client.logs(p.name, p.attemptId, p.maxBytes);
        case 'secretsOpen': return client.secretsOpen(p.id);
      }
    });
  }

  function send(res: ServerResponse, status: number, value: object) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > limits.controlBytes) {
      send(res, 500, { error: { code: 'BUSY', message: 'The dashboard response is too large. Inspect individual projects through the CLI.' } });
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  }

  server.on('request', (req, res) => {
    const abort = new AbortController();
    const timer = setTimeout(() => { abort.abort(); res.destroy(); }, limits.waitMs + limits.headerTimeoutMs);
    res.once('close', () => { clearTimeout(timer); abort.abort(); });
    void (async () => {
      const count = (name: string) => req.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === name).length;
      if (req.headers.host !== new URL(origin).host || count('host') !== 1) throw new PreviewError('UNAUTHORIZED', 'Use the numeric dashboard address.');
      const asset = req.url === '/' ? [dashboardPage, 'text/html'] : req.url === '/dashboard.js' ? [dashboardScript, 'text/javascript'] :
        req.url === '/dashboard.css' ? [dashboardStyle, 'text/css'] : undefined;
      if (asset && req.method === 'GET') {
        if (req.headers.origin !== undefined && (req.headers.origin !== origin || count('origin') !== 1)) throw new PreviewError('UNAUTHORIZED', 'Use the dashboard origin.');
        res.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(asset[0]); return;
      }
      const supplied = req.headers.authorization ?? '';
      const expected = `Bearer ${capability}`;
      if (req.headers.origin !== origin || count('origin') !== 1 || count('authorization') !== 1 ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw new PreviewError('UNAUTHORIZED', 'Open the dashboard through previewhost dashboard.');
      }
      if (req.url !== '/api' || req.method !== 'POST' || count('content-type') !== 1 || req.headers['content-type'] !== 'application/json') {
        throw new PreviewError('INVALID_INPUT', 'Use the dashboard JSON API.');
      }
      if (active >= 8) throw new PreviewError('BUSY', 'The dashboard is busy. Try again shortly.');
      active++;
      try { send(res, 200, { result: await dispatch(await readBody(req, AbortSignal.any([abort.signal, controller.signal]))) }); }
      finally { active--; }
    })().catch(error => send(res, error instanceof PreviewError && error.code === 'UNAUTHORIZED' ? 401 : 400, { error: failure(error) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    endpoint: origin,
    open: () => (options.openBrowser ?? openLocalBrowser)(`${origin}/#${capability}`, controller.signal),
    close: () => closing ??= (async () => {
      controller.abort();
      await Promise.all([...clients].map(client => client.close()));
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    })(),
  };
}

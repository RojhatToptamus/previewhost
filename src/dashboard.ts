import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { readProjectGit } from './dashboard-identity.js';
import { loadPreviewSpec, resolvePreviewFile } from './config.js';
import { normalizeSources, parseSpec } from './spec.js';
import { z } from 'zod';
import { connectPreviewDaemon } from './client.js';
import { limits, requestSchemas, secretIdSchema } from './contracts.js';
import { readBody } from './daemon.js';
import { failure, PreviewError, throwIfAborted } from './errors.js';
import { openLocalBrowser } from './local-browser.js';
import { reviewStaleProject, removeStaleProject, projectRecordSchema, deleteOfflineData, offlinePreviews, removeOfflineProject, discoverProjectOwners, ownerInfoSchema, type ProjectOwnerInfo } from './project.js';
import { Keystore, secretListSchema, unlockSchema } from './keystore.js';

const ownerId = z.string().regex(/^[a-f0-9]{64}$/);
const actionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), after: ownerId.optional() }),
  z.strictObject({ action: z.literal('recheck'), owner: ownerId }),
  z.strictObject({ action: z.literal('reviewRemoval'), owner: ownerId }),
  z.strictObject({ action: z.literal('removeStale'), owner: ownerId, expected: projectRecordSchema, cleanupVerified: z.literal(true) }),
  secretListSchema.extend({ action: z.literal('listSecrets') }),
  unlockSchema.extend({ action: z.literal('unlockKeystore') }),
  z.strictObject({ action: z.enum(['rememberKeystore', 'forgetKeystore']) }),
  z.strictObject({ action: z.literal('updateSecret'), id: secretIdSchema, value: z.string().max(limits.secretBytes) }),
  requestSchemas.stop.omit({ afterEngineRestart: true }).extend({ action: z.literal('stop'), owner: ownerId }).required({ expected: true }),
  requestSchemas.stop.omit({ afterEngineRestart: true }).extend({ action: z.literal('resetData'), owner: ownerId, resources: requestSchemas.deleteData.shape.expected.unwrap().shape.resources }).required({ expected: true }),
  requestSchemas.remove.extend({ action: z.literal('remove'), owner: ownerId }),
  requestSchemas.deleteData.extend({ action: z.literal('deleteData'), owner: ownerId }).required({ expected: true }),
  requestSchemas.cancel.extend({ action: z.literal('cancel'), owner: ownerId }),
  requestSchemas.rerunJob.extend({ action: z.literal('rerunJob'), owner: ownerId }),
  requestSchemas.startAgain.extend({ action: z.literal('startAgain'), owner: ownerId }),
  requestSchemas.saveConfiguration.extend({ action: z.literal('saveConfiguration'), owner: ownerId }),
  requestSchemas.describe.extend({ action: z.literal('describe'), owner: ownerId }),
  requestSchemas.logs.extend({ action: z.literal('logs'), owner: ownerId }),
  z.strictObject({ action: z.literal('secretsOpen'), owner: ownerId, id: z.uuid() }),
]);

/** An authenticated browser client of existing project operations. It never starts application owners. */
export async function startDashboard(options: {
  discover?: typeof discoverProjectOwners;
  openBrowser?: typeof openLocalBrowser;
} = {}) {
  const discover = options.discover ?? discoverProjectOwners;
  const [geist, geistMono, dashboardPage, dashboardScript, dashboardStyle, dashboardIcon, dashboardPng] = await Promise.all([
    './fonts/geist.woff2', './fonts/geist-mono.woff2',
    './dashboard/index.html', './dashboard/dashboard.js', './dashboard/dashboard.css', './dashboard/dashboard.svg', './dashboard/dashboard.png',
  ].map(file => readFile(new URL(file, import.meta.url))));
  const capability = randomBytes(32).toString('hex');
  const clients = new Set<ReturnType<typeof connectPreviewDaemon>>();
  const controller = new AbortController();
  const updates = new Set<Promise<unknown>>();
  const store = new Keystore();
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

  async function withOwner<T>(owner: Awaited<ReturnType<typeof discover>>[number], operation: (client: ReturnType<typeof connectPreviewDaemon>, info: ProjectOwnerInfo) => Promise<T>, readBudget?: number): Promise<T> {
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
      return await operation(client, info.data);
    } catch (error) {
      if (expired) throw new PreviewError('TIMEOUT', 'This owner did not respond. Other projects remain available.');
      throw error;
    } finally { clearTimeout(timer); clients.delete(client); await client.close(); }
  }

  async function readOwner(owner: Awaited<ReturnType<typeof discover>>[number]) {
    const project = (owner.connection ?? owner.retained)?.projectDirectory;
    const identity = { id: owner.id, project, git: project ? await readProjectGit(project, controller.signal) : undefined };
    if (owner.retained) {
      try { return { ...identity, offline: true, previews: await offlinePreviews(owner.retained), requests: [] }; }
      catch (error) { return { ...identity, offline: true, error: failure(error) }; }
    }
    try {
      if (owner.error) return { ...identity, error: owner.error };
      return await withOwner(owner, async (client, info) => {
        let file = join(info.projectDirectory, 'preview.yaml');
        let configuration: { file: string; error?: ReturnType<typeof failure> } | undefined;
        try {
          file = await resolvePreviewFile(info.projectDirectory);
          await lstat(file);
          configuration = { file };
          await normalizeSources(parseSpec(await loadPreviewSpec(file, { allowedRoots: info.allowedRoots, signal: controller.signal })), info.allowedRoots);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') configuration = { file, error: failure(error, 'INVALID_INPUT') };
        }
        const previews = await client.list();
        return { ...identity, configuration, previews, requests: await client.secretsList() };
      }, 3000);
    } catch (error) {
      const problem = failure(error);
      if (problem.code === 'DAEMON_UNAVAILABLE') problem.message = 'The owner is not responding. Application processes may still be running. Recheck status or review removal before clearing this entry.';
      return { ...identity, error: problem };
    }
  }

  async function dispatch(input: unknown, signal: AbortSignal) {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) throw new PreviewError('INVALID_INPUT', 'Invalid dashboard action. Refresh the page and try again.');
    const p = parsed.data;
    if (p.action === 'listSecrets' || p.action === 'unlockKeystore' || p.action === 'rememberKeystore' || p.action === 'forgetKeystore') {
      const work = (async () => {
        if (p.action === 'unlockKeystore') { const { action: _, ...input } = p; return store.unlock(input, { signal }); }
        if (p.action === 'rememberKeystore') { await store.remember({ signal }); return {}; }
        if (p.action === 'forgetKeystore') { await store.forget({ signal }); return {}; }
        const keystore = await store.status({ signal });
        return { ...(keystore.state === 'unlocked' ? await store.list({ ...p, signal }) : { ids: [] }), keystore };
      })();
      updates.add(work);
      try { return await work; } finally { updates.delete(work); }
    }
    if (p.action === 'updateSecret') {
      const update = store.update('user', p.id, p.value, { signal });
      updates.add(update);
      try {
        if (!await update) throw new PreviewError('SECRET_REQUIRED', 'This reference was removed. Refresh the list; its value was not recreated.');
        return { id: p.id };
      } finally { updates.delete(update); }
    }
    if (!('owner' in p) && p.action !== 'list') throw new PreviewError('INVALID_INPUT', 'Invalid dashboard action.');
    const owners = await discover();
    if (p.action === 'list') {
      const candidates = owners.filter(owner => !p.after || owner.id > p.after).sort((a, b) => a.id.localeCompare(b.id));
      // Bound network fan-out and response size independently of the number of known projects.
      const results = await Promise.all(candidates.slice(0, 16).map(readOwner));
      const page: typeof results = [];
      let bytes = 128;
      for (const result of results) {
        let item = result;
        if (Buffer.byteLength(JSON.stringify(item)) > limits.controlBytes - 128) {
          item = { id: item.id, project: item.project, git: item.git, error: { code: 'BUSY', message: 'This project has too much detail to display. Inspect it through the CLI.' } };
        }
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes + size > limits.controlBytes) break;
        page.push(item); bytes += size;
      }
      return { owners: page, ...(page.length < candidates.length ? { next: page.at(-1)!.id } : {}) };
    }
    const owner = owners.find(owner => owner.id === p.owner);
    if (!owner) throw new PreviewError('NOT_FOUND', 'This owner is no longer available. Refresh the list.');
    if (p.action === 'recheck') {
      const result = await readOwner(owner);
      if ('error' in result && result.error) throw new PreviewError(result.error.code, result.error.message);
      return result;
    }
    if (p.action === 'reviewRemoval') {
      try { return { expected: await reviewStaleProject(dirname(owner.tokenFile)) }; }
      catch (error) { return { blocked: failure(error).message }; }
    }
    if (p.action === 'removeStale') {
      throwIfAborted(signal);
      const update = removeStaleProject(dirname(owner.tokenFile), p.expected);
      updates.add(update);
      try { await update; return null; } finally { updates.delete(update); }
    }
    if (owner.retained) {
      const directory = dirname(owner.tokenFile);
      if (p.action === 'deleteData' || p.action === 'remove') {
        const update = p.action === 'deleteData' ? deleteOfflineData(directory, p.name, { expected: p.expected }, signal, store) : removeOfflineProject(directory);
        updates.add(update);
        try { return await update ?? null; } finally { updates.delete(update); }
      }
      throw new PreviewError('DAEMON_UNAVAILABLE', 'This project is offline. Start through your agent or CLI to run it again.');
    }
    return withOwner<unknown>(owner, async client => {
      switch (p.action) {
        case 'remove': await client.remove(p.name, p.attemptId); return null;
        case 'deleteData': return client.deleteData(p.name, { expected: p.expected });
        case 'stop': return client.stop(p.name, { expected: p.expected });
        case 'resetData': {
          const attemptId = p.expected.active ?? p.expected.latest;
          if (!attemptId) throw new PreviewError('INVALID_INPUT', 'Reset needs a retained configuration. Start through your agent first.');
          if (p.expected.candidate) throw new PreviewError('BUSY', 'Finish or cancel startup before resetting data.');
          // Stop and delete keep their own authorization and concurrency guards.
          throwIfAborted(signal);
          const stopped = await client.stop(p.name, { expected: p.expected });
          if (stopped.latest?.id !== attemptId || !['stopped', 'failed', 'canceled'].includes(stopped.latest.state)) {
            throw new PreviewError('STALE_ATTEMPT', 'No restartable configuration remains. Data was not deleted; ask your agent to start the preview.');
          }
          throwIfAborted(signal);
          await client.deleteData(p.name, { expected: { attemptId, resources: p.resources } });
          try {
            throwIfAborted(signal);
            return await client.startAgain(p.name, attemptId);
          } catch (error) {
            throw new PreviewError('START_FAILED', 'Data was deleted, but startup could not begin. Review the preview and use Start preview to retry without deleting again. ' + failure(error).message);
          }
        }
        case 'cancel': return client.cancel(p.name, p.attemptId);
        case 'rerunJob': return client.rerunJob(p.name, p.attemptId, p.job);
        case 'startAgain': return client.startAgain(p.name, p.attemptId);
        case 'saveConfiguration': return client.saveConfiguration(p.name, p.attemptId);
        case 'describe': return client.describe(p.name, p.attemptId);
        case 'logs': return client.logs(p.name, p.attemptId, p);
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
      const asset: [string | Buffer, string] | undefined = req.url === '/' ? [dashboardPage, 'text/html; charset=utf-8'] :
        req.url === '/dashboard.js' ? [dashboardScript, 'text/javascript; charset=utf-8'] :
        req.url === '/dashboard.css' ? [dashboardStyle, 'text/css; charset=utf-8'] :
        req.url === '/dashboard.svg' ? [dashboardIcon, 'image/svg+xml'] :
        req.url === '/dashboard.png' ? [dashboardPng, 'image/png'] :
        req.url === '/fonts/geist.woff2' ? [geist, 'font/woff2'] : req.url === '/fonts/geist-mono.woff2' ? [geistMono, 'font/woff2'] : undefined;
      if (asset && req.method === 'GET') {
        // Radix and Sonner insert presentation styles. Scripts, connections, and API authorization remain restricted.
        if (req.headers.origin !== undefined && (req.headers.origin !== origin || count('origin') !== 1)) throw new PreviewError('UNAUTHORIZED', 'Use the dashboard origin.');
        res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
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
      const signal = AbortSignal.any([abort.signal, controller.signal]);
      try { send(res, 200, { result: await dispatch(await readBody(req, signal), signal) }); }
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
      await Promise.all([Promise.allSettled(updates), ...[...clients].map(client => client.close())]);
      store.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    })(),
  };
}

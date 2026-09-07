import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PreviewError, throwIfAborted } from './errors.js';
import type { HttpTarget } from './resources.js';

/** Observe response headers without following redirects or retaining response bodies. */
export async function waitForHttp(target: HttpTarget, readyPath: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      lastStatus = await probe(target, readyPath, Math.min(2000, deadline - Date.now()), signal);
      if (lastStatus >= 200 && lastStatus < 400) return;
    } catch {
      throwIfAborted(signal);
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new PreviewError('START_FAILED', `HTTP readiness timed out${lastStatus ? ` (last status ${lastStatus})` : ''}. Read the attempt logs and verify the readiness path and port.`);
}

function probe(target: HttpTarget, pathname: string, timeoutMs: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: target.port, path: pathname, headers: { host: target.hostHeader, connection: 'close' } });
    let settled = false;
    const finish = (error?: Error, status = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      request.destroy();
      if (error) reject(error); else resolve(status);
    };
    const abort = () => finish(new Error('Readiness request canceled.'));
    const timer = setTimeout(() => finish(new Error('Readiness request timed out.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    request.once('response', (response) => {
      response.destroy();
      finish(undefined, response.statusCode);
    });
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      finish(undefined, response.statusCode);
    });
    request.once('error', finish);
    request.once('close', () => finish(new Error('Readiness connection closed before response headers.')));
    if (signal.aborted) abort();
  });
}

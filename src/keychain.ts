import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { limits } from './contracts.js';
import { PreviewError, throwIfAborted } from './errors.js';

export type SecretNamespace = 'user' | 'database' | 'migration';
export interface KeychainOptions { signal?: AbortSignal; interactive?: boolean }
interface NativeRequest {
  operation: 'get' | 'has' | 'add' | 'update' | 'remove' | 'list';
  namespace: SecretNamespace;
  id?: string;
  value?: string;
}
const replySchema = z.strictObject({
  status: z.number().int(), data: z.string().max(Math.ceil(limits.secretBytes / 3) * 4).optional(),
  ids: z.array(z.string().max(512)).max(limits.secrets).optional(), truncated: z.boolean().optional(),
});
type NativeReply = z.infer<typeof replySchema>;
const missing = -25300;
const duplicate = -25299;

export function validateSecretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.includes('\0')
    || Buffer.byteLength(value) > limits.secretBytes || Buffer.from(value).toString('utf8') !== value) {
    throw new PreviewError('INVALID_INPUT', 'A secret must contain 1–4096 valid UTF-8 bytes without NUL.');
  }
}

/** One concrete native bridge. Each operation owns and joins its helper process. */
export class Keychain {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly executable = fileURLToPath(new URL('./native/keychain', import.meta.url)),
    private readonly arguments_: string[] = [],
  ) {}

  async get(namespace: SecretNamespace, id: string, options: KeychainOptions = {}): Promise<string | undefined> {
    const reply = await this.invoke({ operation: 'get', namespace, id }, options);
    if (reply.status === missing) return undefined;
    this.check(reply);
    try {
      if (reply.data === undefined) throw new Error();
      const bytes = Buffer.from(reply.data, 'base64');
      if (bytes.toString('base64') !== reply.data) throw new Error();
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      validateSecretValue(value);
      return value;
    } catch { throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'Keychain returned invalid credential data.'); }
  }
  async has(namespace: SecretNamespace, id: string, options: KeychainOptions = {}): Promise<boolean> {
    const reply = await this.invoke({ operation: 'has', namespace, id }, options);
    if (reply.status === missing) return false;
    this.check(reply);
    return true;
  }
  async list(options: KeychainOptions = {}): Promise<{ ids: string[]; truncated: boolean }> {
    const reply = await this.invoke({ operation: 'list', namespace: 'user' }, options);
    if (reply.status === missing) return { ids: [], truncated: false };
    this.check(reply);
    if (!reply.ids || reply.truncated === undefined) throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'Keychain returned an invalid inventory.');
    return { ids: reply.ids.sort(), truncated: reply.truncated };
  }
  async add(namespace: SecretNamespace, id: string, value: string, options: KeychainOptions = {}): Promise<boolean> {
    validateSecretValue(value);
    const reply = await this.invoke({ operation: 'add', namespace, id, value }, options);
    if (reply.status === duplicate) return false;
    this.check(reply);
    return true;
  }
  async update(namespace: SecretNamespace, id: string, value: string, options: KeychainOptions = {}): Promise<boolean> {
    validateSecretValue(value);
    const reply = await this.invoke({ operation: 'update', namespace, id, value }, options);
    if (reply.status === missing) return false;
    this.check(reply);
    return true;
  }
  async remove(namespace: SecretNamespace, id: string, options: KeychainOptions = {}): Promise<void> {
    const reply = await this.invoke({ operation: 'remove', namespace, id }, options);
    if (reply.status !== missing) this.check(reply);
  }

  private check(reply: NativeReply): void {
    if (!reply.status) return;
    if (reply.status === -25293 || reply.status === -128) {
      throw new PreviewError('SECRET_DENIED', 'Keychain denied access. Allow the previewd helper in Keychain Access, then retry.');
    }
    throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'Keychain is locked or unavailable. Unlock it and check the helper’s item access in Keychain Access, then retry.');
  }

  // Kept on the concrete bridge so integration fixtures can target a disposable Keychain.
  async invoke(request: NativeRequest, options: KeychainOptions = {}): Promise<NativeReply> {
    if (process.platform !== 'darwin') throw new PreviewError('UNSUPPORTED_PLATFORM', 'Stored secrets currently require macOS Keychain.');
    const { signal } = options;
    if (signal) throwIfAborted(signal);
    await this.acquire(signal);
    try {
      if (signal) throwIfAborted(signal);
      return await new Promise<NativeReply>((resolve, reject) => {
        const mutating = ['add', 'update', 'remove'].includes(request.operation);
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
        const child = spawn(this.executable, this.arguments_, { stdio: ['pipe', 'pipe', 'pipe'], env });
        const chunks: Buffer[] = [];
        let size = 0;
        let problem: PreviewError | undefined;
        const interrupted = (message: string) => new PreviewError('SECRET_STORE_UNAVAILABLE', message,
          mutating ? { outcome: 'unknown' } : {});
        const stop = (error: PreviewError) => { problem ??= error; child.kill('SIGKILL'); };
        const abort = () => stop(interrupted('Keychain access was canceled. A dispatched write can still have completed.'));
        const timer = setTimeout(() => stop(interrupted('Keychain did not respond in time. A dispatched write can still have completed.')),
          options.interactive ? 30_000 : 10_000);
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', () => { problem ??= new PreviewError('SECRET_STORE_UNAVAILABLE', 'The packaged Keychain helper could not start. Reinstall a macOS build of previewd.'); });
        child.stdin.on('error', () => stop(interrupted('The Keychain request ended without a result.')));
        child.stderr.resume(); // Native diagnostics must never enter application logs or transports.
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limits.controlBytes) stop(interrupted('The Keychain response exceeded its limit.'));
          else chunks.push(chunk);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (problem) { reject(problem); return; }
          if (code !== 0) { reject(interrupted('The Keychain helper exited without a result.')); return; }
          try {
            const parsed = replySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (!parsed.success) throw new Error();
            resolve(parsed.data);
          } catch { reject(interrupted('Keychain returned an invalid response.')); }
        });
        if (signal?.aborted) abort();
        else {
          // Keep opaque UTF-8 bytes out of Foundation's text/JSON string normalization.
          const { value, ...metadata } = request;
          child.stdin.end(JSON.stringify({ ...metadata, ...(value === undefined ? {} : { data: Buffer.from(value).toString('base64') }),
            interactive: options.interactive === true }));
        }
      });
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < limits.secretOperations) { this.active++; return; }
    if (this.waiting.length >= limits.secretQueue) throw new PreviewError('BUSY', 'Keychain request capacity is full. Retry after current requests finish.');
    await new Promise<void>((resolve, reject) => {
      const proceed = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = this.waiting.indexOf(proceed);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        reject(new PreviewError('CLOSED', 'The queued Keychain request was canceled.'));
      };
      this.waiting.push(proceed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

export const keychain = new Keychain();

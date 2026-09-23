import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { lstatSync, openSync, closeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { limits, secretIdSchema } from './contracts.js';
import { PreviewError, throwIfAborted } from './errors.js';
import { keychain } from './keychain.js';
import { isPrivate, makePrivateDirectory } from './private-files.js';

export type SecretNamespace = 'user' | 'database';
export interface StoreOptions { signal?: AbortSignal }
export interface KeystoreStatus { state: 'new' | 'locked' | 'unlocked'; canRemember: boolean; warning?: string }
export const secretListSchema = z.strictObject({ query: z.string().max(128).optional(), after: secretIdSchema.optional() });
export interface SecretList { ids: string[]; next?: string }
export const unlockSchema = z.strictObject({ password: z.string().min(1).max(4096), create: z.boolean().default(false),
  confirmation: z.string().max(4096).optional(), remember: z.boolean().default(false) });
const contentsSchema = z.strictObject({ user: z.record(secretIdSchema, z.string()), database: z.record(z.string().regex(/^[a-f0-9]{32}$/), z.string()) });
type Contents = z.infer<typeof contentsSchema>;
interface Row { salt: Uint8Array; nonce: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }
const unavailable = () => new PreviewError('SECRET_STORE_UNAVAILABLE', 'The keystore is unavailable or damaged. Check its directory permissions and retry. Preserve its files before restoring a complete backup.');
export function validateSecretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || Buffer.byteLength(value) > limits.secretBytes
    || Buffer.from(value).toString('utf8') !== value) throw new PreviewError('INVALID_INPUT', 'A secret must contain 1–4096 valid UTF-8 bytes without NUL.');
}

/** One encrypted payload. SQLite owns cross-process locking, atomic commit and crash recovery. */
export class Keystore {
  private db?: DatabaseSync;
  private key?: Buffer;
  private salt?: Buffer;
  private closed = false;
  private pending = false;
  constructor(readonly directory = join(homedir(), '.local', 'share', 'previewhost', 'keystore')) {}

  private open(): DatabaseSync {
    if (this.closed) throw new PreviewError('CLOSED', 'This keystore session is closed.');
    if (this.db) return this.db;
    try {
      makePrivateDirectory(this.directory);
      const root = lstatSync(this.directory);
      if (!root.isDirectory() || !isPrivate(this.directory, root)) throw unavailable();
      const file = join(this.directory, 'secrets.sqlite');
      const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || !isPrivate(file, stat)) throw unavailable();
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
      const db = new DatabaseSync(file);
      try {
        db.exec('PRAGMA busy_timeout = 3000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL)');
      } catch (error) { db.close(); throw error; }
      return this.db = db;
    } catch (error) { if (error instanceof PreviewError) throw error; throw unavailable(); }
  }
  private row(): Row | undefined {
    try {
      const row = this.open().prepare('SELECT salt, nonce, tag, ciphertext FROM vault WHERE id=1').get() as unknown as Row | undefined;
      if (row && (!(row.salt instanceof Uint8Array) || row.salt.length !== 16 || row.nonce.length !== 12 || row.tag.length !== 16 || row.ciphertext.length > 16 * 1024 * 1024)) throw unavailable();
      return row;
    } catch (error) { if (error instanceof PreviewError) throw error; throw unavailable(); }
  }
  private decrypt(row: Row, key: Buffer): Contents {
    let clear: Buffer | undefined;
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      cipher.setAuthTag(row.tag);
      clear = Buffer.concat([cipher.update(row.ciphertext), cipher.final()]);
      const contents = contentsSchema.parse(JSON.parse(clear.toString('utf8')));
      for (const values of Object.values(contents)) for (const value of Object.values(values)) validateSecretValue(value);
      return contents;
    } catch { throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'The password is incorrect or the keystore is damaged. Retry your password or restore a complete backup. Nothing was reset.'); }
    finally { clear?.fill(0); }
  }
  private write(contents: Contents, key: Buffer, salt: Buffer): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const clear = Buffer.from(JSON.stringify(contents));
    try {
      const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
      if (encrypted.length > 16 * 1024 * 1024) throw new PreviewError('BUSY', 'The keystore is full. Remove unused entries before adding more.');
      this.open().prepare('INSERT OR REPLACE INTO vault VALUES (1, ?, ?, ?, ?)').run(salt, nonce, cipher.getAuthTag(), encrypted);
    } finally { clear.fill(0); }
  }
  private transaction<T>(operation: () => T, signal?: AbortSignal): T {
    if (signal) throwIfAborted(signal);
    const db = this.open();
    try { db.exec('BEGIN IMMEDIATE'); }
    catch { throw new PreviewError('BUSY', 'Another process is updating the keystore. Retry shortly.'); }
    try {
      const result = operation();
      if (signal) throwIfAborted(signal);
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async status(options: StoreOptions = {}): Promise<KeystoreStatus> {
    if (options.signal) throwIfAborted(options.signal);
    const row = this.row();
    const canRemember = process.platform === 'darwin';
    if (!row) { this.lock(); return { state: 'new', canRemember }; }
    if (this.salt && !this.salt.equals(row.salt)) this.lock();
    if (!this.key && canRemember && !this.pending) {
      try {
        const cached = await keychain.get('unlock', Buffer.from(row.salt).toString('hex'), options);
        if (options.signal) throwIfAborted(options.signal);
        if (this.closed) throw new PreviewError('CLOSED', 'This keystore session is closed.');
        if (cached && /^[a-f0-9]{64}$/.test(cached)) {
          const key = Buffer.from(cached, 'hex');
          try { this.decrypt(row, key); this.key = key; this.salt = Buffer.from(row.salt); }
          catch { key.fill(0); throw unavailable(); }
        }
      } catch {
        if (options.signal) throwIfAborted(options.signal);
        return { state: 'locked', canRemember, warning: 'Automatic unlock is unavailable. Enter your keystore password.' };
      }
    }
    return { state: this.key ? 'unlocked' : 'locked', canRemember };
  }
  async unlock(input: z.input<typeof unlockSchema>, options: StoreOptions = {}): Promise<KeystoreStatus> {
    const parsed = unlockSchema.safeParse(input);
    if (!parsed.success) throw new PreviewError('INVALID_INPUT', 'Supply a keystore password in private input.');
    const { password, create, confirmation, remember } = parsed.data;
    validateSecretValue(password);
    if (create && (password.length < 12 || password !== confirmation)) throw new PreviewError('INVALID_INPUT', 'Use at least 12 characters and enter the same password twice.');
    if (this.pending) throw new PreviewError('BUSY', 'Keystore unlock is already in progress.');
    this.pending = true;
    let key: Buffer | undefined;
    try {
      const previous = this.row();
      if (create === Boolean(previous)) throw new PreviewError('SECRET_STORE_UNAVAILABLE', create ? 'A keystore already exists. Refresh the dashboard, or cancel and reopen private setup, to unlock it.' : 'Create a keystore before unlocking it.');
      const salt = previous ? Buffer.from(previous.salt) : randomBytes(16);
      key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)));
      if (options.signal) throwIfAborted(options.signal);
      this.transaction(() => {
        const current = this.row();
        if (create) {
          if (current) throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'Another process created the keystore. Refresh the dashboard, or cancel and reopen private setup, to unlock it.');
          this.write({ user: {}, database: {} }, key!, salt);
        } else {
          if (!current || !salt.equals(current.salt)) throw unavailable();
          this.decrypt(current, key!);
        }
      }, options.signal);
      this.lock(); this.key = key; this.salt = salt; key = undefined;
      if (remember) {
        try { await this.remember(options); }
        catch { return { state: 'unlocked', canRemember: process.platform === 'darwin', warning: 'Unlocked for this session. Automatic unlock could not be confirmed. Keep your password; retry Remember or use Forget on macOS.' }; }
      }
      return { state: 'unlocked', canRemember: process.platform === 'darwin' };
    } finally { key?.fill(0); this.pending = false; }
  }
  async remember(options: StoreOptions = {}): Promise<void> {
    if (process.platform !== 'darwin') throw new PreviewError('UNSUPPORTED_PLATFORM', 'Automatic unlock is available only on macOS. Use your password on this platform.');
    if (!this.key || !this.salt) throw new PreviewError('SECRET_STORE_UNAVAILABLE', 'Unlock the keystore before remembering it.');
    const id = this.salt.toString('hex'), value = this.key.toString('hex');
    if (!await keychain.add('unlock', id, value, { ...options, interactive: true }) && !await keychain.update('unlock', id, value, { ...options, interactive: true })) throw unavailable();
  }
  async forget(options: StoreOptions = {}): Promise<void> {
    const row = this.row();
    if (row && process.platform === 'darwin') await keychain.remove('unlock', Buffer.from(row.salt).toString('hex'), { ...options, interactive: true });
  }
  lock(): void { this.key?.fill(0); this.key = undefined; this.salt = undefined; }
  close(): void { this.closed = true; this.lock(); this.db?.close(); this.db = undefined; }
  private async ready(options: StoreOptions): Promise<void> {
    const status = await this.status(options);
    if (status.state !== 'unlocked') throw new PreviewError('SECRET_STORE_UNAVAILABLE', status.state === 'new' ? 'Create the keystore in private setup or run previewhost secrets init.' : 'Unlock the keystore in private setup. Unattended runs can use explicitly selected environment inputs.');
  }
  private contents(): Contents {
    const row = this.row();
    if (!row || !this.key || !this.salt?.equals(row.salt)) { this.lock(); throw unavailable(); }
    return this.decrypt(row, this.key);
  }
  async get(namespace: SecretNamespace, id: string, options: StoreOptions = {}): Promise<string | undefined> {
    await this.ready(options);
    const values = this.contents()[namespace];
    return Object.hasOwn(values, id) ? values[id] : undefined;
  }
  async has(namespace: SecretNamespace, id: string, options: StoreOptions = {}): Promise<boolean> { return (await this.get(namespace, id, options)) !== undefined; }
  async list(options: StoreOptions & z.infer<typeof secretListSchema> = {}): Promise<SecretList> {
    const parsed = secretListSchema.safeParse({ query: options.query, after: options.after });
    if (!parsed.success) throw new PreviewError('INVALID_INPUT', 'Search must be at most 128 characters; use the returned next reference to continue.');
    await this.ready(options);
    const query = parsed.data.query?.trim().toLowerCase() ?? '';
    const matching = Object.keys(this.contents().user)
      .filter(id => (!parsed.data.after || id > parsed.data.after) && id.toLowerCase().includes(query)).sort();
    const ids = matching.slice(0, limits.secrets);
    return { ids, ...(matching.length > ids.length ? { next: ids.at(-1)! } : {}) };
  }
  async add(namespace: SecretNamespace, id: string, value: string, options: StoreOptions = {}): Promise<boolean> { return this.mutate(namespace, id, value, 'add', options); }
  async update(namespace: SecretNamespace, id: string, value: string, options: StoreOptions = {}): Promise<boolean> { return this.mutate(namespace, id, value, 'update', options); }
  async set(namespace: SecretNamespace, id: string, value: string, options: StoreOptions = {}): Promise<void> { await this.mutate(namespace, id, value, 'set', options); }
  async remove(namespace: SecretNamespace, id: string, options: StoreOptions = {}): Promise<void> { await this.mutate(namespace, id, undefined, 'remove', options); }
  private async mutate(namespace: SecretNamespace, id: string, value: string | undefined, operation: 'add' | 'update' | 'set' | 'remove', options: StoreOptions): Promise<boolean> {
    if (!(namespace === 'user' ? secretIdSchema.safeParse(id).success : /^[a-f0-9]{32}$/.test(id))) throw new PreviewError('INVALID_INPUT', 'Invalid stored secret reference.');
    if (value !== undefined) validateSecretValue(value);
    await this.ready(options);
    return this.transaction(() => {
      const contents = this.contents(), exists = Object.hasOwn(contents[namespace], id);
      if ((operation === 'add' && exists) || (operation === 'update' && !exists)) return false;
      if (operation === 'remove') delete contents[namespace][id];
      else Object.defineProperty(contents[namespace], id, { value, enumerable: true, configurable: true, writable: true });
      this.write(contents, this.key!, this.salt!);
      return true;
    }, options.signal);
  }
}

import { isUtf8 } from 'node:buffer';
import { constants, type Stats } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { configurationBindingChangeSchema, limits, previewSpecSchema, type ConfigurationBindingChange, type ConfigurationBindingRow, type EffectiveSpec, type PreviewSpec } from './contracts.js';
import { PreviewError } from './errors.js';
import { canonicalDirectory, isWithin, normalizeSources, parseSpec } from './spec.js';

/** Redacted declarations only: literal values never leave the configuration owner. */
export function configurationBindings(input: PreviewSpec): ConfigurationBindingRow[] {
  const spec = parseSpec(input);
  const services = spec.type === 'environment' ? Object.entries(spec.services) : [[undefined, spec] as const];
  return services.flatMap(([service, value]) => value.type === 'command' || value.type === 'job'
    ? Object.entries(value.env).sort(([a], [b]) => a.localeCompare(b)).map(([key, binding]) => ({
      ...(service === undefined ? {} : { service }), key, value: typeof binding === 'string' ? null : { ...binding },
    })) : []);
}

/** Changes only command/job bindings, retaining all untouched declarations and literals. */
export function changeConfigurationBindings(input: PreviewSpec, changes: ConfigurationBindingChange[]): EffectiveSpec {
  const parsed = configurationBindingChangeSchema.array().max(limits.environmentServices * 128).safeParse(changes);
  if (!parsed.success) throw new PreviewError('INVALID_INPUT', 'Use valid environment binding changes.');
  const spec = parseSpec(input);
  for (const change of parsed.data) {
    const service = spec.type === 'environment' && change.service !== undefined
      ? spec.services[change.service] : change.service === undefined && spec.type === 'command' ? spec : undefined;
    if (!service || (service.type !== 'command' && service.type !== 'job')) {
      throw new PreviewError('INVALID_INPUT', 'Select an existing command or job for each binding change.');
    }
    if (change.value === null) delete service.env[change.key];
    else Object.defineProperty(service.env, change.key, { value: change.value, enumerable: true, configurable: true, writable: true });
  }
  return parseSpec(spec);
}

/** Server-only edit state. Never serialize text or spec to the browser. */
export interface ConfigurationDocument {
  file: string;
  format: 'yaml' | 'json';
  text: string;
  spec: EffectiveSpec;
  bindings: ConfigurationBindingRow[];
  identity: Pick<Stats, 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs' | 'size' | 'mode'>;
}

type DocumentOptions = { allowedRoots: string[]; signal?: AbortSignal };

function documentIdentity(info: Stats): ConfigurationDocument['identity'] {
  const { dev, ino, mtimeMs, ctimeMs, size, mode } = info;
  return { dev, ino, mtimeMs, ctimeMs, size, mode };
}

function staleDocument(): never {
  throw new PreviewError('STALE_ATTEMPT', 'The configuration file changed. Reload it before saving.');
}

/** Reads an editable regular file and validates its sources without resolving inputs or secrets. */
export async function readConfigurationDocument(file: string, options: DocumentOptions): Promise<ConfigurationDocument> {
  try {
    const requested = resolve(file);
    const path = join(await canonicalDirectory(dirname(requested)), basename(requested));
    const roots = await Promise.all(options.allowedRoots.map(canonicalDirectory));
    if (!roots.some(root => isWithin(root, path))) throw new PreviewError('SOURCE_DENIED', 'The configuration file is outside the allowed roots.');
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limits.controlBytes) {
      throw new PreviewError('INVALID_INPUT', 'Edit a regular configuration file of at most 1 MiB, without a symbolic link.');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    const identity = documentIdentity(before);
    try {
      if (!isDeepStrictEqual(identity, documentIdentity(await handle.stat()))) staleDocument();
      text = await readSpecText(handle.createReadStream({ autoClose: false }), options.signal);
      if (!isDeepStrictEqual(identity, documentIdentity(await handle.stat()))) staleDocument();
    } finally { await handle.close(); }
    if (!isDeepStrictEqual(identity, documentIdentity(await lstat(path)))) staleDocument();
    const format = /\.ya?ml$/i.test(extname(path)) ? 'yaml' : 'json';
    const spec = await normalizeSources(parseSpec(await readPreviewSpec(Readable.from([text]), {
      baseDirectory: dirname(path), format, signal: options.signal,
    })), roots);
    if (path !== requested) {
      const selected = await normalizeSources(parseSpec(await readPreviewSpec(Readable.from([text]), {
        baseDirectory: dirname(requested), format, signal: options.signal,
      })), roots);
      if (!isDeepStrictEqual(selected, spec)) throw new PreviewError('INVALID_INPUT', `A symbolic parent changes relative source folders. Select the real configuration path explicitly: ${path}`);
    }
    return { file: path, format, text, identity, spec, bindings: configurationBindings(spec) };
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', 'Cannot read the configuration file for editing.');
  }
}

/** Patches the selected declarations in place; callers serialize their own edit sessions. */
export async function updateConfigurationDocument(document: ConfigurationDocument, changes: ConfigurationBindingChange[], options: DocumentOptions): Promise<ConfigurationDocument> {
  let temporary: string | undefined;
  const checkCurrent = async () => {
    const current = await readConfigurationDocument(document.file, options);
    if (current.text !== document.text || !isDeepStrictEqual(current.identity, document.identity)) staleDocument();
    return current;
  };
  try {
    changes = structuredClone(changes);
    const spec = changeConfigurationBindings(document.spec, changes);
    if (isDeepStrictEqual(spec, document.spec)) return await checkCurrent();
    let text: string;
    if (document.format === 'yaml') {
      const yaml = await parseYamlDocument(document.text);
      const { isNode } = await import('yaml');
      for (const change of changes) {
        const path = [...(change.service === undefined ? [] : ['services', change.service]), 'env', change.key];
        if (change.value === null) yaml.deleteIn(path);
        else {
          const previous = yaml.getIn(path, true);
          const next = yaml.createNode(change.value);
          if (isNode(previous)) { next.comment = previous.comment; next.commentBefore = previous.commentBefore; }
          yaml.setIn(path, next);
        }
      }
      text = yaml.toString();
    } else {
      const value = JSON.parse(document.text);
      for (const change of changes) {
        const service = change.service === undefined ? value : value.services[change.service];
        if (change.value === null) { if (service.env) delete service.env[change.key]; }
        else {
          service.env ??= {};
          Object.defineProperty(service.env, change.key, { value: change.value, enumerable: true, configurable: true, writable: true });
        }
      }
      text = `${JSON.stringify(value, null, 2)}\n`;
    }
    const roots = await Promise.all(options.allowedRoots.map(canonicalDirectory));
    const restored = await normalizeSources(parseSpec(await readPreviewSpec(Readable.from([text]), {
      baseDirectory: dirname(document.file), format: document.format, signal: options.signal,
    })), roots);
    if (!isDeepStrictEqual(restored, spec)) throw new PreviewError('INVALID_INPUT', 'The configuration cannot be saved without changing its meaning.');
    await checkCurrent();
    const candidate = join(dirname(document.file), `.preview-${randomUUID()}.tmp`);
    const handle = await open(candidate, 'wx', 0o600);
    temporary = candidate;
    try { await handle.writeFile(text); await handle.chmod(document.identity.mode & 0o777); await handle.sync(); }
    finally { await handle.close(); }
    // Recheck immediately before publication. An unrelated editor must still avoid writing during this final rename.
    await checkCurrent();
    await rename(temporary, document.file);
    const saved = await readConfigurationDocument(document.file, options);
    if (saved.text !== text) staleDocument();
    return saved;
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', 'Cannot update the configuration file. Check write access and reload before retrying.');
  } finally { if (temporary) await unlink(temporary).catch(() => {}); }
}

async function existingPreviewFiles(project: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of ['preview.yaml', 'preview.yml']) {
    const file = join(project, name);
    try { await lstat(file); files.push(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PreviewError('INVALID_INPUT', `${file}: Cannot check the preview configuration file.`);
      }
    }
  }
  return files;
}

export async function resolvePreviewFile(project: string): Promise<string> {
  const files = await existingPreviewFiles(project);
  if (files.length > 1) {
    throw new PreviewError('INVALID_INPUT', `${project}: Both preview.yaml and preview.yml exist. Keep one default configuration or select a file explicitly.`);
  }
  return files[0] ?? join(project, 'preview.yaml');
}

/** Loads one JSON/YAML file. Source paths resolve relative to that file. */
export async function loadPreviewSpec(file: string, options: { allowedRoots?: string[]; signal?: AbortSignal } = {}): Promise<PreviewSpec> {
  const path = resolve(file);
  try {
    const target = await realpath(path);
    if (options.allowedRoots) {
      const roots = await Promise.all(options.allowedRoots.map(canonicalDirectory));
      if (!roots.some(root => isWithin(root, target))) throw new PreviewError('SOURCE_DENIED', 'The spec file must be inside the project or an explicitly allowed root.');
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'Use a regular spec file of at most 1 MiB. Pipes belong on JSON stdin.');
      return await readPreviewSpec(handle.createReadStream(), {
        baseDirectory: dirname(path), format: /\.ya?ml$/i.test(extname(path)) ? 'yaml' : 'json', signal: options.signal,
      });
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof PreviewError) throw new PreviewError(error.code, `${path}: ${error.message}`);
    throw new PreviewError('INVALID_INPUT', `${path}: Cannot read the preview spec file.`);
  }
}

/** Shared with CLI stdin, which deliberately accepts JSON only. */
export async function readPreviewSpec(input: Readable, options: {
  baseDirectory: string; format: 'json' | 'yaml'; signal?: AbortSignal; fallbackProject?: string; onFile?: (file: string) => void;
}): Promise<PreviewSpec> {
  const text = await readSpecText(input, options.signal);
  if (!text.trim() && options.fallbackProject) {
    const file = await resolvePreviewFile(options.fallbackProject);
    const spec = await loadPreviewSpec(file, { signal: options.signal });
    options.onFile?.(resolve(file));
    return spec;
  }
  let value: unknown;
  if (options.format === 'yaml') value = (await parseYamlDocument(text)).toJS({ maxAliasCount: 0 });
  else {
    try { value = JSON.parse(text); }
    catch { throw new PreviewError('INVALID_INPUT', 'The spec must be one valid JSON object.'); }
  }
  const parsed = previewSpecSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PreviewError('INVALID_INPUT', `${issue.path.join('.') || 'spec'}: ${issue.message}`);
  }
  const spec = parsed.data;
  const source = (service: { type: string; directory?: string; cwd?: string }) => {
    if (service.type === 'static' && service.directory !== undefined) service.directory = resolve(options.baseDirectory, service.directory);
    if ((service.type === 'command' || service.type === 'job') && service.cwd !== undefined) service.cwd = resolve(options.baseDirectory, service.cwd);
  };
  if (spec.type === 'environment') Object.values(spec.services).forEach(source);
  else source(spec);
  return spec;
}

async function readSpecText(input: Readable, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => input.destroy(new PreviewError('CLOSED', 'Reading the preview spec was interrupted.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const data of input) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      size += chunk.length;
      if (size > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'The spec exceeds 1 MiB.');
      chunks.push(chunk);
    }
  } finally { signal?.removeEventListener('abort', abort); }
  const bytes = Buffer.concat(chunks);
  if (!isUtf8(bytes)) throw new PreviewError('INVALID_INPUT', 'The configuration must contain valid UTF-8 text.');
  return bytes.toString('utf8');
}

/** Creates project-root preview.yaml from declarative input. Never overwrites or resolves secrets/inputs. */
export async function savePreviewSpec(input: PreviewSpec, options: {
  projectDirectory: string; allowedRoots?: string[]; signal?: AbortSignal;
}): Promise<{ file: string; externalSources: string[] }> {
  const checkCanceled = () => {
    if (options.signal?.aborted) throw new PreviewError('CLOSED', 'Configuration saving was canceled.');
  };
  let temporary: string | undefined;
  try {
    checkCanceled();
    if (Buffer.byteLength(JSON.stringify(input)) > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'The spec exceeds 1 MiB.');
    const project = await canonicalDirectory(options.projectDirectory);
    const roots = await Promise.all((options.allowedRoots ?? [project]).map(canonicalDirectory));
    const spec = await normalizeSources(parseSpec(input), roots);
    const portable = structuredClone(spec);
    const externalSources = new Set<string>();
    for (const service of portable.type === 'environment' ? Object.values(portable.services) : [portable]) {
      if (service.type !== 'command' && service.type !== 'job' && service.type !== 'static') continue;
      const source = (service.type === 'command' || service.type === 'job') ? service.cwd : service.directory;
      if (!isWithin(project, source)) { externalSources.add(source); continue; }
      const local = relative(project, source) || '.';
      if (service.type === 'command' || service.type === 'job') service.cwd = local; else service.directory = local;
    }
    const { stringify } = await import('yaml');
    const text = stringify(portable, { aliasDuplicateObjects: false });
    const restored = await readPreviewSpec(Readable.from([text]), { baseDirectory: project, format: 'yaml', signal: options.signal });
    if (!isDeepStrictEqual(parseSpec(restored), spec)) throw new PreviewError('INVALID_INPUT', 'The configuration cannot be saved without changing its meaning.');
    const file = join(project, 'preview.yaml');
    checkCanceled();
    const candidate = join(project, `.preview-${randomUUID()}.tmp`);
    const handle = await open(candidate, 'wx', 0o600);
    temporary = candidate;
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    checkCanceled();
    const existing = await existingPreviewFiles(project);
    if (existing.length) throw new PreviewError('ALREADY_EXISTS', `A default configuration already exists (${existing.map(file => relative(project, file)).join(', ')}). Edit the existing configuration instead.`);
    // Exclusive publication: readers see a complete file, and existing files/symlinks always win.
    await link(temporary, file);
    return { file, externalSources: [...externalSources].sort() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PreviewError('ALREADY_EXISTS', 'preview.yaml already exists. Use your normal editor for explicitly requested updates, then validate the file.');
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', 'Cannot save preview.yaml. Check source paths and project write access; inspect the destination before retrying.');
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

async function parseYamlDocument(text: string) {
  try {
    const { isAlias, isScalar, parseDocument, visit } = await import('yaml');
    const document = parseDocument(text, {
      schema: 'core', version: '1.2', stringKeys: true, uniqueKeys: true,
      resolveKnownTags: false, merge: false, customTags: [], prettyErrors: false,
    });
    const issue = document.errors[0] ?? document.warnings[0];
    if (issue) {
      const before = text.slice(0, issue.pos[0]);
      const line = before.split('\n').length;
      const column = before.length - before.lastIndexOf('\n');
      // Location and parser code help repair the file without echoing credential-bearing lines.
      throw new PreviewError('INVALID_INPUT', `Invalid YAML at line ${line}, column ${column} (${issue.code}). Use YAML 1.2 without duplicate keys, aliases, merge keys, or tags.`);
    }
    if (document.directives?.yaml.version !== '1.2') throw new Error('Invalid YAML');
    visit(document, {
      Node(_key, node) { if (isAlias(node) || node.tag) throw new Error('Aliases and tags are unsupported'); },
      Pair(_key, pair) { if (isScalar(pair.key) && pair.key.value === '<<') throw new Error('Merge keys are unsupported'); },
    });
    return document;
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', 'Use one YAML 1.2 object without duplicate keys, aliases, merge keys, or tags.');
  }
}

import { constants } from 'node:fs';
import { link, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { limits, previewSpecSchema, type PreviewSpec } from './contracts.js';
import { PreviewError } from './errors.js';
import { canonicalDirectory, isWithin, normalizeSources, parseSpec } from './spec.js';

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
  baseDirectory: string; format: 'json' | 'yaml'; signal?: AbortSignal; fallbackFile?: string;
}): Promise<PreviewSpec> {
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => input.destroy(new PreviewError('CLOSED', 'Reading the preview spec was interrupted.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    for await (const data of input) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      size += chunk.length;
      if (size > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'The spec exceeds 1 MiB.');
      chunks.push(chunk);
    }
  } finally { options.signal?.removeEventListener('abort', abort); }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim() && options.fallbackFile) return loadPreviewSpec(options.fallbackFile, { signal: options.signal });
  let value: unknown;
  if (options.format === 'yaml') value = await parseYaml(text);
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

/** Creates project-root preview.yml from declarative input. Never overwrites or resolves secrets/inputs. */
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
    const file = join(project, 'preview.yml');
    checkCanceled();
    const candidate = join(project, `.preview-${randomUUID()}.tmp`);
    const handle = await open(candidate, 'wx', 0o600);
    temporary = candidate;
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    checkCanceled();
    // Exclusive publication: readers see a complete file, and existing files/symlinks always win.
    await link(temporary, file);
    return { file, externalSources: [...externalSources].sort() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PreviewError('ALREADY_EXISTS', 'preview.yml already exists. Use your normal editor for explicitly requested updates, then validate the file.');
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', 'Cannot save preview.yml. Check source paths and project write access; inspect the destination before retrying.');
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

async function parseYaml(text: string): Promise<unknown> {
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
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', 'Use one YAML 1.2 object without duplicate keys, aliases, merge keys, or tags.');
  }
}

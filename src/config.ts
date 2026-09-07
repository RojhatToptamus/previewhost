import { createReadStream } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { limits, previewSpecSchema, type PreviewSpec } from './contracts.js';
import { PreviewError } from './errors.js';

/** Loads one JSON/YAML file. Source paths resolve relative to that file. */
export async function loadPreviewSpec(file: string, options: { signal?: AbortSignal } = {}): Promise<PreviewSpec> {
  const path = resolve(file);
  try {
    return await readPreviewSpec(createReadStream(path), {
      baseDirectory: dirname(path), format: /\.ya?ml$/i.test(extname(path)) ? 'yaml' : 'json', signal: options.signal,
    });
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('INVALID_INPUT', 'Cannot read the preview spec file.');
  }
}

/** Shared with CLI stdin, which deliberately accepts JSON only. */
export async function readPreviewSpec(input: Readable, options: {
  baseDirectory: string; format: 'json' | 'yaml'; signal?: AbortSignal;
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
    if (service.type === 'command' && service.cwd !== undefined) service.cwd = resolve(options.baseDirectory, service.cwd);
  };
  if (spec.type === 'environment') Object.values(spec.services).forEach(source);
  else source(spec);
  return spec;
}

async function parseYaml(text: string): Promise<unknown> {
  try {
    const { isAlias, isScalar, parseDocument, visit } = await import('yaml');
    const document = parseDocument(text, {
      schema: 'core', version: '1.2', stringKeys: true, uniqueKeys: true,
      resolveKnownTags: false, merge: false, customTags: [], prettyErrors: false,
    });
    if (document.errors.length || document.warnings.length || document.directives?.yaml.version !== '1.2') throw new Error('Invalid YAML');
    visit(document, {
      Node(_key, node) { if (isAlias(node) || node.tag) throw new Error('Aliases and tags are unsupported'); },
      Pair(_key, pair) { if (isScalar(pair.key) && pair.key.value === '<<') throw new Error('Merge keys are unsupported'); },
    });
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new PreviewError('INVALID_INPUT', 'Use one YAML 1.2 object without duplicate keys, aliases, merge keys, or tags.');
  }
}

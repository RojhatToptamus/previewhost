#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connectPreviewDaemon, defaultTokenFile } from './client.js';
import { limits, previewSpecSchema, type PreviewSpec } from './contracts.js';
import { startDaemon } from './daemon.js';
import { failure, PreviewError } from './errors.js';

const help = `previewd — local HTTP previews

Owner:
  previewd serve [--root DIR ...] [--allow-exec] [--port 9400] [--token-file PATH]
  previewd mcp [--endpoint http://127.0.0.1:9400] [--token-file PATH]

Preview operations:
  previewd inspect --file spec.json
  previewd start --file spec.json [--no-wait] [--timeout-ms 30000]
  previewd replace --file spec.json [--no-wait] [--timeout-ms 30000]
  previewd list
  previewd get NAME
  previewd wait NAME ATTEMPT_ID [--timeout-ms 30000]
  previewd logs NAME [ATTEMPT_ID] [--max-bytes 65536]
  previewd cancel NAME ATTEMPT_ID
  previewd stop NAME
  previewd shutdown

All client commands accept --endpoint and --token-file. The default token file is
~/.local/share/previewd/token. Serve stays in the foreground; its default allowed
root is the current directory. Native commands require --allow-exec at owner
startup. This permits normal user-level execution; it is not a sandbox.

Use --file - (or omit --file with piped stdin) to read JSON. Source paths in a file
resolve relative to that file; stdin paths resolve relative to the current directory.
Start/replace wait up to 30 seconds by default. A timeout or interrupted wait does
not cancel the preview. Use get/list after an uncertain response, or cancel with
the exact attempt id. A disconnected MCP adapter leaves daemon previews running.

Results are JSON on stdout. Errors are JSON on stderr with a nonzero exit code.
`;

function integer(value: string | undefined, name: string, maximum: number, minimum = 1): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new PreviewError('INVALID_INPUT', `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

async function readSpec(file: string | undefined, signal: AbortSignal): Promise<PreviewSpec> {
  if ((!file || file === '-') && process.stdin.isTTY) throw new PreviewError('INVALID_INPUT', 'Use --file spec.json or pipe one JSON spec to stdin.');
  const input = file && file !== '-' ? createReadStream(resolve(file)) : process.stdin;
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => input.destroy(new PreviewError('CLOSED', 'Reading the preview spec was interrupted.'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for await (const data of input) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      size += chunk.length;
      if (size > limits.controlBytes) throw new PreviewError('INVALID_INPUT', 'The spec exceeds 1 MiB.');
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PreviewError('INVALID_INPUT', 'The spec must be one valid JSON object.'); }
  const base = file && file !== '-' ? dirname(resolve(file)) : process.cwd();
  if (value && typeof value === 'object' && 'type' in value) {
    if (value.type === 'static' && 'directory' in value && typeof value.directory === 'string') value.directory = resolve(base, value.directory);
    if (value.type === 'command' && 'cwd' in value && typeof value.cwd === 'string') value.cwd = resolve(base, value.cwd);
  }
  const parsed = previewSpecSchema.safeParse(value);
  if (!parsed.success) throw new PreviewError('INVALID_INPUT', parsed.error.issues[0].message);
  return parsed.data;
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try { parsed = parseCliArgs(); }
  catch (error) { throw new PreviewError('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid command arguments.'); }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command || command === 'help') { process.stdout.write(help); return; }
  const accepted: Record<string, string[]> = {
    serve: ['root', 'allow-exec', 'port', 'token-file'],
    mcp: ['endpoint', 'token-file'],
    inspect: ['file', 'endpoint', 'token-file'],
    start: ['file', 'no-wait', 'timeout-ms', 'endpoint', 'token-file'],
    replace: ['file', 'no-wait', 'timeout-ms', 'endpoint', 'token-file'],
    list: ['endpoint', 'token-file'], get: ['endpoint', 'token-file'],
    wait: ['timeout-ms', 'endpoint', 'token-file'], logs: ['max-bytes', 'endpoint', 'token-file'],
    cancel: ['endpoint', 'token-file'], stop: ['endpoint', 'token-file'], shutdown: ['endpoint', 'token-file'],
  };
  if (!Object.hasOwn(accepted, command)) throw new PreviewError('INVALID_INPUT', 'Unknown command. Run previewd --help.');
  for (const key of Object.keys(values)) if (!accepted[command].includes(key)) throw new PreviewError('INVALID_INPUT', `--${key} is not supported for ${command}.`);
  const counts: Record<string, [number, number]> = { get: [2, 2], wait: [3, 3], logs: [2, 3], cancel: [3, 3], stop: [2, 2] };
  const [minimum, maximum] = counts[command] ?? [1, 1];
  if (positionals.length < minimum || positionals.length > maximum) throw new PreviewError('INVALID_INPUT', `Invalid arguments for ${command}. Run previewd --help.`);
  const endpoint = values.endpoint;
  const tokenFile = values['token-file'] ? resolve(values['token-file']) : defaultTokenFile();
  const timeoutMs = integer(values['timeout-ms'], '--timeout-ms', limits.waitMs);
  const maxBytes = integer(values['max-bytes'], '--max-bytes', limits.logBytes);

  if (command === 'serve') {
    const { createPreviewRuntime } = await import('./runtime.js');
    const allowedRoots = (values.root ?? [process.cwd()]).map((root) => resolve(root));
    const runtime = await createPreviewRuntime({ allowedRoots,
      ...(values['allow-exec'] ? { authorize: () => true } : {}),
    });
    let daemon: Awaited<ReturnType<typeof startDaemon>>;
    try { daemon = await startDaemon({ runtime, port: integer(values.port, '--port', 65_535, 0), tokenFile }); }
    catch (error) { await runtime.close(); throw error; }
    const stop = () => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      void daemon.close().catch(() => {});
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const detach = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); };
    void daemon.closed.then(detach, (error: unknown) => {
      detach(); process.stderr.write(`${JSON.stringify({ error: failure(error) })}\n`); process.exitCode = 1;
    });
    process.stdout.write(`${JSON.stringify({ endpoint: daemon.endpoint, tokenFile, allowedRoots, execution: values['allow-exec'] ? 'enabled' : 'disabled' })}\n`);
    return;
  }
  if (command === 'mcp') {
    const { runMcp } = await import('./mcp.js');
    runMcp({ endpoint, tokenFile });
    return;
  }

  const client = connectPreviewDaemon({ endpoint, tokenFile });
  const inputController = new AbortController();
  const interrupt = () => { process.exitCode = 130; inputController.abort(); void client.close(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let attempt: { name: string; attemptId: string } | undefined;
  try {
    let result: unknown;
    switch (command) {
      case 'inspect': result = await client.inspect(await readSpec(values.file, inputController.signal)); break;
      case 'start': case 'replace': {
        const spec = await readSpec(values.file, inputController.signal);
        const status = command === 'start' ? await client.start(spec) : await client.replace(spec.name, spec);
        result = status;
        if (!values['no-wait']) {
          const id = status.candidate?.id ?? status.latest?.id ?? status.active?.id;
          if (!id) throw new PreviewError('START_FAILED', 'The daemon returned no attempt id. Use get/list before retrying.');
          attempt = { name: spec.name, attemptId: id };
          const outcome = await client.wait(spec.name, id, { timeoutMs });
          if (outcome.state !== 'ready') throw new PreviewError(outcome.error?.code ?? 'CLOSED', outcome.error?.message ?? `The preview attempt is ${outcome.state}.`);
          result = outcome;
        }
        break;
      }
      case 'list': result = await client.list(); break;
      case 'get': result = await client.get(positionals[1]); break;
      case 'wait': attempt = { name: positionals[1], attemptId: positionals[2] }; result = await client.wait(attempt.name, attempt.attemptId, { timeoutMs }); break;
      case 'logs': result = await client.logs(positionals[1], positionals[2], maxBytes); break;
      case 'cancel': result = await client.cancel(positionals[1], positionals[2]); break;
      case 'stop': result = await client.stop(positionals[1]); break;
      case 'shutdown': await client.shutdown(); result = { stopped: true }; break;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: failure(error), ...attempt })}\n`);
    process.exitCode ??= 1;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    await client.close();
  }
}

function parseCliArgs() {
  return parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, root: { type: 'string', multiple: true },
    'allow-exec': { type: 'boolean' }, port: { type: 'string' },
    endpoint: { type: 'string' }, 'token-file': { type: 'string' },
    file: { type: 'string', short: 'f' }, 'no-wait': { type: 'boolean' },
    'timeout-ms': { type: 'string' }, 'max-bytes': { type: 'string' },
  } });
}

await main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: failure(error, 'INVALID_INPUT') })}\n`);
  process.exitCode ??= 1;
});

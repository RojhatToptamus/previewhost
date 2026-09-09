#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connectPreviewDaemon, defaultTokenFile } from './client.js';
import { limits, type PreviewSpec } from './contracts.js';
import { loadPreviewSpec, readPreviewSpec } from './config.js';
import { startDaemon } from './daemon.js';
import { failure, PreviewError } from './errors.js';
import { listSecrets, removeSecret, setSecret, validateSecretId } from './secrets.js';
import { readSecretInput } from './secret-input.js';

const help = `previewhost — local previews and application environments

Owner:
  previewhost serve [--root DIR ...] [--allow-exec] [--env NAME ...] [--secret ID ...]
                    [--data-dir DIR] [--docker-socket PATH] [--port 9400] [--token-file PATH]
  previewhost mcp [--endpoint http://127.0.0.1:9400] [--token-file PATH]

Preview operations:
  previewhost inspect --file spec.yaml
  previewhost start --file spec.yaml [--no-wait] [--timeout-ms 30000]
  previewhost replace --file spec.yaml [--no-wait] [--timeout-ms 30000]
  previewhost list
  previewhost get NAME
  previewhost wait NAME ATTEMPT_ID [--timeout-ms 30000]
  previewhost logs NAME [ATTEMPT_ID] [--max-bytes 65536]
  previewhost cancel NAME ATTEMPT_ID
  previewhost stop NAME [--after-engine-restart]
  previewhost delete-data NAME
  previewhost shutdown

Secrets:
  previewhost secrets setup --file spec.yaml [--reopen]
  previewhost secrets edit ID
  previewhost secrets status REQUEST_ID
  previewhost secrets set ID [--stdin]
  previewhost secrets list
  previewhost secrets remove ID

All client commands accept --endpoint and --token-file. The default token file is
~/.local/share/previewd/token. Serve stays in the foreground; its default allowed
root is the current directory. --allow-exec grants native execution, managed
database operations, and explicit data deletion/recovery. It is not a sandbox.
--env NAME selects that host environment value once at startup. Values stay out
of status. Managed PostgreSQL/Redis require --data-dir and local Docker images.
--docker-socket selects a local Engine socket and requires --data-dir.
--secret ID selects an exact macOS Keychain entry for {secret: ID} bindings.
--allow-exec selects no secrets by itself. Private browser setup/edit needs owner
authorization. Save starts nothing; retry the ordinary preview operation afterward.
Set/list/remove work without a daemon. Set uses hidden terminal input or bounded
UTF-8 stdin, never an argument value. Stdin preserves whitespace and newlines.
Terminal Enter submits; bracketed paste preserves pasted newlines. Ctrl-C cancels.
An edit affects future readers; running applications retain their delivered values.

Use --file - (or omit --file with piped stdin) to read JSON. Source paths in a file
resolve relative to that file; stdin paths resolve relative to the current directory.
YAML files reject aliases, tags, merge keys, and duplicate keys. previewhost does not
load .env files. Application commands can. Source directories stay live and caller-owned.
Environment status includes each service and retained database data.
Start/replace wait up to 30 seconds by default. A timeout or interrupted wait does
not cancel the preview. Use get/list after an uncertain response, or cancel with
the exact attempt id. A disconnected MCP adapter leaves daemon previews running.

Stop preserves database data. delete-data removes only a stopped environment's
owned data and requires owner authorization. For an unresolved missing Docker
creation, use --after-engine-restart only after the operator restarts the actual
local Engine. The flag confirms that action; it never restarts Docker itself.

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
  return file && file !== '-' ? loadPreviewSpec(file, { signal }) :
    readPreviewSpec(process.stdin, { baseDirectory: process.cwd(), format: 'json', signal });
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try { parsed = parseCliArgs(); }
  catch { throw new PreviewError('INVALID_INPUT', 'Invalid command arguments. Run previewhost --help.'); }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command || command === 'help') { process.stdout.write(help); return; }
  if (command === 'secrets') { await secretCommand(positionals.slice(1), values); return; }
  const accepted: Record<string, string[]> = {
    serve: ['root', 'allow-exec', 'env', 'secret', 'data-dir', 'docker-socket', 'port', 'token-file'],
    mcp: ['endpoint', 'token-file'],
    inspect: ['file', 'endpoint', 'token-file'],
    start: ['file', 'no-wait', 'timeout-ms', 'endpoint', 'token-file'],
    replace: ['file', 'no-wait', 'timeout-ms', 'endpoint', 'token-file'],
    list: ['endpoint', 'token-file'], get: ['endpoint', 'token-file'],
    wait: ['timeout-ms', 'endpoint', 'token-file'], logs: ['max-bytes', 'endpoint', 'token-file'],
    cancel: ['endpoint', 'token-file'], stop: ['after-engine-restart', 'endpoint', 'token-file'],
    'delete-data': ['endpoint', 'token-file'], shutdown: ['endpoint', 'token-file'],
  };
  if (!Object.hasOwn(accepted, command)) throw new PreviewError('INVALID_INPUT', 'Unknown command. Run previewhost --help.');
  for (const key of Object.keys(values)) if (!accepted[command].includes(key)) throw new PreviewError('INVALID_INPUT', `--${key} is not supported for ${command}.`);
  const counts: Record<string, [number, number]> = { get: [2, 2], wait: [3, 3], logs: [2, 3], cancel: [3, 3], stop: [2, 2], 'delete-data': [2, 2] };
  const [minimum, maximum] = counts[command] ?? [1, 1];
  if (positionals.length < minimum || positionals.length > maximum) throw new PreviewError('INVALID_INPUT', `Invalid arguments for ${command}. Run previewhost --help.`);
  const endpoint = values.endpoint;
  const tokenFile = values['token-file'] ? resolve(values['token-file']) : defaultTokenFile();
  const timeoutMs = integer(values['timeout-ms'], '--timeout-ms', limits.waitMs);
  const maxBytes = integer(values['max-bytes'], '--max-bytes', limits.logBytes);

  if (command === 'serve') {
    const { createPreviewRuntime } = await import('./runtime.js');
    const allowedRoots = (values.root ?? [process.cwd()]).map((root) => resolve(root));
    const inputs: Record<string, string> = {};
    for (const key of values.env ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new PreviewError('INVALID_INPUT', '--env requires an environment key name.');
      const value = process.env[key];
      if (value === undefined) throw new PreviewError('INVALID_INPUT', `The selected environment input ${key} is missing.`);
      inputs[key] = value;
    }
    const dataDirectory = values['data-dir'] ? resolve(values['data-dir']) : undefined;
    const dockerSocket = values['docker-socket'] ? resolve(values['docker-socket']) : undefined;
    if (dockerSocket && !dataDirectory) throw new PreviewError('INVALID_INPUT', '--docker-socket requires --data-dir.');
    const runtime = await createPreviewRuntime({ allowedRoots, inputs, secretIds: values.secret, dataDirectory, dockerSocket,
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
    process.stdout.write(`${JSON.stringify({ endpoint: daemon.endpoint, tokenFile, allowedRoots, execution: values['allow-exec'] ? 'enabled' : 'disabled',
      inputKeys: Object.keys(inputs).sort(), secretIds: values.secret ?? [], dataDirectory, dockerSocket })}\n`);
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
          if (outcome.state !== 'ready') throw new PreviewError(outcome.error?.code ?? 'CLOSED', outcome.error?.message ?? `The preview attempt is ${outcome.state}.`, outcome.error);
          result = outcome;
        }
        break;
      }
      case 'list': result = await client.list(); break;
      case 'get': result = await client.get(positionals[1]); break;
      case 'wait': attempt = { name: positionals[1], attemptId: positionals[2] }; result = await client.wait(attempt.name, attempt.attemptId, { timeoutMs }); break;
      case 'logs': result = await client.logs(positionals[1], positionals[2], maxBytes); break;
      case 'cancel': result = await client.cancel(positionals[1], positionals[2]); break;
      case 'stop': result = await client.stop(positionals[1], { afterEngineRestart: values['after-engine-restart'] }); break;
      case 'delete-data': result = await client.deleteData(positionals[1]); break;
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

async function secretCommand(positionals: string[], values: ReturnType<typeof parseCliArgs>['values']): Promise<void> {
  const command = positionals[0];
  const accepted: Record<string, string[]> = {
    setup: ['file', 'endpoint', 'token-file', 'reopen'], edit: ['endpoint', 'token-file'], status: ['endpoint', 'token-file'],
    set: ['stdin'], list: [], remove: [],
  };
  if (!Object.hasOwn(accepted, command) || Object.keys(values).some((key) => !accepted[command].includes(key))
    || positionals.length !== (['setup', 'list'].includes(command) ? 1 : 2)) {
    throw new PreviewError('INVALID_INPUT', 'Invalid secrets command arguments. Values belong only in hidden terminal input or --stdin. Run previewhost --help.');
  }
  if (['set', 'edit', 'remove'].includes(command)) validateSecretId(positionals[1]);
  const controller = new AbortController();
  let client: ReturnType<typeof connectPreviewDaemon> | undefined;
  const interrupt = () => { process.exitCode = 130; controller.abort(); void client?.close(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    let result: unknown;
    if (command === 'set') {
      const value = await readSecretInput(values.stdin === true, controller.signal);
      await setSecret(positionals[1], value, { signal: controller.signal, interactive: true });
      result = { saved: positionals[1] };
    } else if (command === 'remove') {
      await removeSecret(positionals[1], { signal: controller.signal, interactive: true });
      result = { removed: positionals[1] };
    } else if (command === 'list') result = await listSecrets({ signal: controller.signal });
    else {
      client = connectPreviewDaemon({ endpoint: values.endpoint, tokenFile: values['token-file'] });
      result = command === 'setup' ? await client.secretsSetup(await readSpec(values.file, controller.signal), { reopen: values.reopen, signal: controller.signal }) :
        command === 'edit' ? await client.secretsEdit(positionals[1], { signal: controller.signal }) : await client.secretsStatus(positionals[1]);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    await client?.close();
  }
}

function parseCliArgs() {
  return parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, root: { type: 'string', multiple: true },
    'allow-exec': { type: 'boolean' }, port: { type: 'string' },
    env: { type: 'string', multiple: true }, secret: { type: 'string', multiple: true }, 'data-dir': { type: 'string' }, 'docker-socket': { type: 'string' },
    stdin: { type: 'boolean' }, reopen: { type: 'boolean' },
    'after-engine-restart': { type: 'boolean' },
    endpoint: { type: 'string' }, 'token-file': { type: 'string' },
    file: { type: 'string', short: 'f' }, 'no-wait': { type: 'boolean' },
    'timeout-ms': { type: 'string' }, 'max-bytes': { type: 'string' },
  } });
}

await main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: failure(error, 'INVALID_INPUT') })}\n`);
  process.exitCode ??= 1;
});

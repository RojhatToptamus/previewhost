import { resolve } from 'node:path';
import { z } from 'zod';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { connectProject, type ProjectOptions } from './project.js';
import { limits, requestSchemas, secretRequestSchemas, type PreviewApi, type SecretSetupApi } from './contracts.js';
import { failure, PreviewError } from './errors.js';
import { loadPreviewSpec, savePreviewSpec } from './config.js';
import { version } from './version.js';

/** All tools call the same public API; the MCP host owns tool approval UI. */
export function createMcpServer(client: PreviewApi & Partial<Pick<SecretSetupApi, 'secretsSetup' | 'secretsStatus'>> & { shutdown?(): Promise<void> }, options: {
  projectDirectory?: string; allowedRoots?: string[];
} = {}): McpServer {
  const project = resolve(options.projectDirectory ?? process.cwd());
  const inputShape = { spec: requestSchemas.start.shape.spec.optional(), file: z.string().min(1).max(4096).optional()
    .describe('One regular JSON/YAML file within the project or an explicitly allowed root, relative to the project directory. Sources resolve relative to this file. Omit both file and spec to use root preview.yml.') };
  const exclusive = (input: { file?: string; spec?: unknown }) => !(input.file !== undefined && input.spec !== undefined);
  const inputSchema = z.strictObject(inputShape).refine(exclusive, 'Supply either file or spec, never both.');
  const load = (input: z.output<typeof inputSchema>, signal?: AbortSignal) => input.spec ?? loadPreviewSpec(resolve(project, input.file ?? 'preview.yml'), {
    allowedRoots: [project, ...(options.allowedRoots ?? [])], signal,
  });
  const server = new McpServer({ name: 'previewhost', version }, {
    instructions:
      'Use project-root preview.yml when present; invalid files must be fixed. Otherwise inspect the project and ' +
      'supply a spec directly. Start, then wait for the returned attempt ID. For secrets, supply {secret: ID}; ' +
      'request private setup, wait on status, then retry startup. Never request values in chat or inspect the private form. ' +
      'Save preview.yml only on an explicit user request, using the original spec. An active owner survives MCP disconnect. ' +
      'Commands are argv without a shell; use {port} and 127.0.0.1 or injected PORT/HOST. Reuse current task sources, ' +
      'including uncommitted changes. Prepare dependencies with existing project commands. Keep a stable preview name. ' +
      'Wait timeout or cancellation leaves startup running. After an uncertain mutation, check get/list before retrying. ' +
      'Replacement overlaps processes and cannot undo source edits or migrations. Stop affected previews before ' +
      'conflicting shared preparation or source removal. While cleanup is uncertain, retain sources and block conflicting retries. ' +
      'Stop preserves data; delete only on explicit request. Set afterEngineRestart only after confirmed local Docker Engine restart. ' +
      'Owner authority is separate from host tool approval. Private secret approval lasts until owner shutdown and permits ' +
      'any execution-authorized preview on that owner to bind those exact shared names. Saving secrets starts no code. ' +
      'Re-read file-based specs after private entry. If your turn ends, the owner can send “Secrets saved—continue”. ' +
      'A locked Keychain needs owner unlock. Never retry through another interface to bypass a denial.',

  });
  let active = 0;
  let waits = 0;
  async function run(kind: 'request' | 'wait' | 'cleanup', fn: () => Promise<unknown>): Promise<CallToolResult> {
    let counted = false;
    try {
      if (active >= limits.controlRequests - (kind === 'cleanup' ? 0 : 2) || (kind === 'wait' && waits >= limits.controlWaits)) {
        throw new PreviewError('BUSY', 'MCP request capacity is full; stop and cancel retain reserved capacity.');
      }
      active++; counted = true;
      if (kind === 'wait') waits++;
      const value = { result: await fn() };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const value = { error: failure(error) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } finally {
      if (counted) { active--; if (kind === 'wait') waits--; }
    }
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const cleanup = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  server.registerTool('preview_inspect', {
    description: 'Validate one preview or environment spec and describe sources, commands, bindings, and cleanup. Does not install dependencies, check application health, start resources, or grant permission. Environment values and database credentials are omitted.',
    inputSchema, annotations: read,
  }, (input, context) => run('request', async () => client.inspect(await load(input, context.mcpReq.signal))));
  server.registerTool('preview_start', {
    description: 'Start a named preview or environment from existing source. Commands run as argv without shell expansion. Use {port} and 127.0.0.1 for explicit listen arguments, or honor injected PORT/HOST. PREVIEW_URL is the public origin. Returns a starting attempt; use preview_wait with its id. An environment becomes ready only after all its services. Execution and managed databases require daemon owner permission.',
    inputSchema, annotations: write,
  }, (input, context) => run('request', async () => client.start(await load(input, context.mcpReq.signal))));
  server.registerTool('preview_replace', {
    description: 'Prepare a replacement while keeping active routes. All environment services become ready before the routes change together. Shared database data stays in place. Wait for the returned candidate id. Candidate failure keeps the old preview.',
    inputSchema: z.strictObject({ name: requestSchemas.replace.shape.name, ...inputShape }).refine(exclusive, 'Supply either file or spec, never both.'), annotations: { ...write, destructiveHint: true },
  }, (input, context) => run('request', async () => client.replace(input.name, await load(input, context.mcpReq.signal))));
  server.registerTool('preview_save_config', {
    description: 'Only on an explicit user request, create project-root preview.yml from the original prepared spec, never an inspect result. Validates sources, schema and dependencies, and preserves declarative references without reading secrets or owner inputs. Does not start or health-test an application. Project-local paths become relative; externalSources identifies nonportable paths. Create-only: an existing file or symlink is left untouched. Use the host editor for explicitly requested updates. Credential values must never enter this tool; use {secret: ID}.',
    inputSchema: requestSchemas.start, annotations: { ...write, openWorldHint: false },
  }, ({ spec }, context) => run('request', () => savePreviewSpec(spec, { projectDirectory: project, allowedRoots: options.allowedRoots, signal: context.mcpReq.signal })));
  server.registerTool('preview_list', {
    description: 'List bounded preview observations, source directories and retained database data, including names restored after owner restart. Use after a lost mutation response before retrying.',
    inputSchema: requestSchemas.list, annotations: read,
  }, () => run('request', () => client.list()));
  server.registerTool('preview_get', {
    description: 'Read active/candidate attempts, source directories, per-service outcomes, the latest result, retained database data, and incomplete cleanup for a name. Database credentials are omitted.',
    inputSchema: requestSchemas.get, annotations: read,
  }, ({ name }) => run('request', () => client.get(name)));
  server.registerTool('preview_wait', {
    description: 'Wait up to 30 seconds for one exact attempt. Timeout or canceling this wait leaves the preview running.',
    inputSchema: requestSchemas.wait, annotations: read,
  }, ({ name, attemptId, timeoutMs }, context) => run('wait', () => client.wait(name, attemptId, { timeoutMs, signal: context.mcpReq.signal })));
  server.registerTool('preview_logs', {
    description: 'Read a bounded log tail for an attempt. Known supplied environment values are redacted; other application output can contain secrets.',
    inputSchema: requestSchemas.logs, annotations: read,
  }, ({ name, attemptId, maxBytes }) => run('request', () => client.logs(name, attemptId, maxBytes)));
  server.registerTool('preview_cancel', {
    description: 'Cancel only the specified pending candidate and join its cleanup. A stale id never cancels a later attempt.',
    inputSchema: requestSchemas.cancel, annotations: cleanup,
  }, ({ name, attemptId }) => run('cleanup', () => client.cancel(name, attemptId)));
  server.registerTool('preview_stop', {
    description: 'Stop the named preview and join owned application/container cleanup. Preserves database data, attached services, and source files. Set afterEngineRestart only after the operator confirms an actual local Engine restart. This resolves an absent indeterminate creation and requires recovery authorization. It never restarts Docker.',
    inputSchema: requestSchemas.stop, annotations: cleanup,
  }, ({ name, afterEngineRestart }) => run('cleanup', () => client.stop(name, { afterEngineRestart })));
  server.registerTool('preview_delete_data', {
    description: 'Permanently delete a stopped environment\'s verified owned database data. Requires an explicit user request and daemon owner authorization. Rejects live applications or unresolved cleanup. Never deletes attached databases or source directories. Stop alone preserves data.',
    inputSchema: requestSchemas.deleteData, annotations: cleanup,
  }, ({ name }) => run('request', () => client.deleteData(name)));
  if (client.secretsSetup && client.secretsStatus) {
    server.registerTool('preview_secrets_setup', {
      description: 'Request exact secret names for this spec through the owner’s private browser form. The owner approves runtime access to unselected names, then enters only missing values privately. Existing entries are reused, never overwritten. Any authorized preview on this owner can use approved names until shutdown. Returns public metadata only. Never supply values or inspect the private form. Requires owner setup authorization. Saving starts no code; check status, then retry ordinary start/replace with the current spec.',
      inputSchema, annotations: write,
    }, (input, context) => run('request', async () => client.secretsSetup!(await load(input, context.mcpReq.signal), { signal: context.mcpReq.signal })));
    server.registerTool('preview_secrets_status', {
      description: 'Read or wait up to 25000ms for the public result of private secret setup. No values are read or returned. Complete records access approval and observed presence, not credential validity or future Keychain access. Check current preview state before startup with the current spec. Partial is terminal: its private form cannot be reused. After the owner fixes the reported issue, request fresh setup; do not keep waiting on a partial result or ask the owner to resubmit the old form. Retain this request ID with its original project connection. If the agent turn ends, the owner can send “Secrets saved—continue” to resume.',
      inputSchema: secretRequestSchemas.status, annotations: read,
    }, ({ id, timeoutMs }, context) => run(timeoutMs ? 'wait' : 'request', () => client.secretsStatus!(id, { timeoutMs, signal: context.mcpReq.signal })));
  }
  if (client.shutdown) server.registerTool('preview_shutdown', {
    description: 'Shut down this project owner and stop every preview it owns. Preserves managed data and stored Keychain values. Ends runtime secret access approvals and private forms. Use only when the user requests owner teardown.',
    inputSchema: requestSchemas.list, annotations: cleanup,
  }, () => run('cleanup', async () => { await client.shutdown!(); return { stopped: true }; }));
  return server;
}

/** Stdio is an adapter lifetime; EOF closes requests, never daemon previews. */
export function runMcp(options: ProjectOptions = {}): { close(): Promise<void> } {
  const client = connectProject(options);
  let closing: Promise<void> | undefined;
  const handle = serveStdio(() => createMcpServer(client, options), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: limits.controlBytes }),
    onerror: () => { process.stderr.write('previewhost MCP transport error.\n'); void close(); },
  });
  function close(): Promise<void> {
    if (!closing) {
      process.stdin.off('end', onEnd);
      process.off('SIGINT', onEnd); process.off('SIGTERM', onEnd);
      closing = (async () => { await client.close(); await handle.close(); })();
    }
    return closing;
  }
  const onEnd = () => { void close(); };
  process.stdin.once('end', onEnd);
  process.once('SIGINT', onEnd); process.once('SIGTERM', onEnd);
  return { close };
}

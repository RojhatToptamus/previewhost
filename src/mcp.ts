import { resolve } from 'node:path';
import { z } from 'zod';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { connectProject, selectMcpProject, type ProjectOptions } from './project.js';
import { limits, requestSchemas, secretRequestSchemas } from './contracts.js';
import { failure, PreviewError } from './errors.js';
import { loadPreviewSpec, savePreviewSpec } from './config.js';
import { McpAccess, accessSchema } from './mcp-access.js';
import { canonicalDirectory, normalizeSources, parseSpec } from './spec.js';
import { version } from './version.js';

/** All tools call the same public API; the MCP host owns tool approval UI. */
export function createMcpServer(options: ProjectOptions = {}): { server: McpServer; close(): Promise<void> } {
  const fixed = options.endpoint !== undefined || options.tokenFile !== undefined;
  const access = !fixed && !options.projectDirectory && !options.allowedRoots ? new McpAccess(options) : undefined;
  const clients = new Set<ReturnType<typeof connectProject>>();
  let closed = false;
  const projectField = z.string().min(1).max(4096).describe(
    'Absolute root of this chat’s actual checkout/worktree. Supply the same project on every call, including status, secrets, stop and restart. Never substitute the main checkout. Request preview_access first when this project or a required backend source has not been approved. Explicitly configured roots remain restrictions.');
  const scope = { project: fixed ? z.never().optional() : options.projectDirectory ? projectField.optional() : projectField };
  const inputShape = { ...scope, spec: requestSchemas.start.shape.spec.optional()
    .describe('Direct spec: all cwd and directory paths must be absolute, even with project. Omit injected PORT, HOST and PREVIEW_URL from env. Use file instead for JSON/YAML with file-relative paths.'), file: z.string().min(1).max(4096).optional()
    .describe('One regular JSON/YAML file within the project or an explicitly allowed root, relative to the project directory. Sources resolve relative to this file. Omit both file and spec to use root preview.yml.') };
  const exclusive = (input: { file?: string; spec?: unknown }) => !(input.file !== undefined && input.spec !== undefined);
  const inputSchema = z.strictObject(inputShape).refine(exclusive, 'Supply either file or spec, never both.');
  const rootsFor = (project: string) => access ? access.roots(project) : Promise.resolve([project, ...(options.allowedRoots ?? [])]);
  const load = async (input: z.output<typeof inputSchema>, project: string, signal?: AbortSignal) => {
    const allowedRoots = await rootsFor(project);
    const spec = input.spec ?? await loadPreviewSpec(resolve(project, input.file ?? 'preview.yml'), { allowedRoots, signal });
    if (access) {
      try { return await normalizeSources(parseSpec(spec), allowedRoots); }
      catch (error) {
        if (error instanceof PreviewError && error.code === 'SOURCE_DENIED') throw new PreviewError('SOURCE_DENIED', 'A source needs approval. Request preview_access with this project and its required backend/source directories, then retry the original configuration. Never relocate sources to bypass approval.');
        throw error;
      }
    }
    return spec;
  };
  const loadForStartup = async (input: z.output<typeof inputSchema>, project: string, client: ReturnType<typeof connectProject>, signal: AbortSignal) => {
    const spec = await load(input, project, signal);
    // Owner shutdown ends runtime grants, but not this connection's source approval.
    if (access) await client.allowSources(await access.roots(project), signal);
    return spec;
  };
  const server = new McpServer({ name: 'previewhost', version }, {
    instructions:
      (fixed ? 'This connection uses one fixed owner; do not supply project. ' :
        'Supply this chat’s actual worktree as project on every call; connections can be shared. ') +
      'Use project-root preview.yml when present; fix invalid files. Otherwise inspect the project and ' +
      'supply a spec directly. Start, then wait for the returned attempt ID. For secrets, supply {secret: ID}; ' +
      'request private setup, wait on status, then retry startup only after complete. Never request values in chat or inspect the private form. ' +
      'Save preview.yml only on an explicit user request, using the original spec. An active owner survives MCP disconnect. ' +
      'Use preview_access for unapproved projects and backend source directories when available; do not edit registration or relocate sources. Denial or cancellation means stop until the user asks to continue. ' +
      'When the user wants to compare or manage local previews, suggest previewhost dashboard; it can inspect, stop, rerun, and explicitly save a retained configuration. Use preview_replace for replacement; the dashboard does not replace previews. ' +
      'If secret setup is canceled, stop and wait for an explicit user request before new setup or startup. Never assume accidental browser closure. ' +
      'Use absolute cwd/directory paths in direct specs, even with project. Omit injected PORT, HOST and PREVIEW_URL from env. ' +
      'For new secret bindings, choose project-specific stored references, distinct from environment-variable names. Preserve existing references; share exact references only intentionally. Required credential variables use private secret bindings even for dummy local values; never invent credential literals. ' +
      'Commands are argv without a shell; use {port} and 127.0.0.1 or injected PORT/HOST. Reuse current task sources, ' +
      'including uncommitted changes. Inspect imports, API calls, package scripts and existing configuration to identify required backend repositories, databases and migrations. Run the complete environment; a frontend alone is insufficient when it needs an API. Ask for a backend location only when you cannot determine it. Prepare dependencies with existing project commands. Keep a stable preview name. ' +
      'Preview wait timeout or interruption leaves startup running. After an uncertain mutation, check get/list before retrying. ' +
      'Replacement overlaps processes and cannot undo source edits or migrations. Stop affected previews before ' +
      'conflicting shared preparation or source removal. While cleanup is uncertain, retain sources and block conflicting retries. ' +
      'Stop preserves data; delete only on explicit request. Set afterEngineRestart only after confirmed local Docker Engine restart. ' +
      'Owner authority is separate from host tool approval. Private secret approval lasts until owner shutdown and permits ' +
      'any execution-authorized preview on that owner to bind those exact shared names. Saving secrets starts no code. ' +
      'Re-read file-based specs after private entry. If your turn ends while setup is pending, the owner can finish the form and send “Secrets saved—continue”. ' +
      'A locked keystore needs owner password entry through private setup. Unlocking never approves names or execution. Never retry through another interface to bypass a denial.',

  });
  let active = 0;
  let waits = 0;
  async function run(kind: 'request' | 'wait' | 'cleanup', input: { project?: string }, fn: (client: ReturnType<typeof connectProject>, project: string) => Promise<unknown>): Promise<CallToolResult> {
    let counted = false;
    let client: ReturnType<typeof connectProject> | undefined;
    try {
      if (active >= limits.controlRequests - (kind === 'cleanup' ? 0 : 2) || (kind === 'wait' && waits >= limits.controlWaits)) {
        throw new PreviewError('BUSY', 'MCP request capacity is full; stop and cancel retain reserved capacity.');
      }
      active++; counted = true;
      if (kind === 'wait') waits++;
      if (access) await access.roots(input.project);
      const selected = access
        ? { ...options, projectDirectory: await canonicalDirectory(input.project!) }
        : fixed ? options : await selectMcpProject(input.project, options);
      if (closed) throw new PreviewError('CLOSED', 'The MCP adapter is closed.');
      client = connectProject(selected); clients.add(client);
      const value = { result: await fn(client, resolve(selected.projectDirectory ?? process.cwd())) };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const value = { error: failure(error) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } finally {
      if (client) { clients.delete(client); await client.close(); }
      if (counted) { active--; if (kind === 'wait') waits--; }
    }
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const cleanup = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  if (access) server.registerTool('preview_access', {
    description: 'Request user approval for this chat’s actual project and additional backend source directories. Call before using an unapproved project. Never supplies or approves secrets. Decline/cancel ends the workflow until the user explicitly asks to resume. No registration edits are needed.',
    inputSchema: accessSchema, annotations: write,
  }, (input, context) => access.request(input, context));
  server.registerTool('preview_inspect', {
    description: 'Validate one preview or environment spec and describe sources, commands, bindings, and cleanup. Does not install dependencies, check application health, start resources, or grant permission. Environment values and database credentials are omitted.',
    inputSchema, annotations: read,
  }, (input, context) => run('request', input, async (client, project) => client.inspect(await load(input, project, context.mcpReq.signal))));
  server.registerTool('preview_start', {
    description: 'Start a named preview or environment from existing source. Commands run as argv without shell expansion. Use {port} and 127.0.0.1 for explicit listen arguments, or honor injected PORT/HOST. PREVIEW_URL is the public origin. Returns a starting attempt; use preview_wait with its id. An environment becomes ready only after all services are ready and finite type: job nodes succeed. Use dependsOn for migrations and seeds; run: once retains successful seeds with managed data. Use a database-querying readyPath, not /openapi.json. Execution and managed databases require daemon owner permission.',
    inputSchema, annotations: write,
  }, (input, context) => run('request', input, async (client, project) => client.start(await loadForStartup(input, project, client, context.mcpReq.signal))));
  server.registerTool('preview_replace', {
    description: 'Prepare a replacement while keeping active routes. All environment services become ready before the routes change together. Shared database data stays in place. Wait for the returned candidate id. Candidate failure keeps the old preview, but jobs may have changed its shared database; writes are not rolled back. Always jobs run again, successful once jobs are skipped.',
    inputSchema: z.strictObject({ name: requestSchemas.replace.shape.name, ...inputShape }).refine(exclusive, 'Supply either file or spec, never both.'), annotations: { ...write, destructiveHint: true },
  }, (input, context) => run('request', input, async (client, project) => client.replace(input.name, await loadForStartup(input, project, client, context.mcpReq.signal))));
  server.registerTool('preview_save_config', {
    description: 'Only on an explicit user request, create project-root preview.yml from the original prepared spec, never an inspect result. Validates sources, schema and dependencies, and preserves declarative references without reading secrets or owner inputs. Does not start or health-test an application. Project-local paths become relative; externalSources identifies nonportable paths. Create-only: an existing file or symlink is left untouched. Use the host editor for explicitly requested updates. Credential values must never enter this tool; use {secret: ID}.',
    inputSchema: requestSchemas.start.extend(scope), annotations: { ...write, openWorldHint: false },
  }, (input, context) => run('request', input, async (_client, project) => savePreviewSpec(input.spec, { projectDirectory: project, allowedRoots: await rootsFor(project), signal: context.mcpReq.signal })));
  server.registerTool('preview_list', {
    description: 'List bounded preview observations, source directories and retained database data, including names restored after owner restart. Use after a lost mutation response before retrying.',
    inputSchema: requestSchemas.list.extend(scope), annotations: read,
  }, input => run('request', input, client => client.list()));
  server.registerTool('preview_get', {
    description: 'Read active/candidate attempts, source directories, per-service outcomes, the latest result, retained database data, and incomplete cleanup for a name. Database credentials are omitted.',
    inputSchema: requestSchemas.get.extend(scope), annotations: read,
  }, input => run('request', input, client => client.get(input.name)));
  server.registerTool('preview_wait', {
    description: 'Wait up to 30 seconds for one exact attempt. Timeout or canceling this wait leaves the preview running.',
    inputSchema: requestSchemas.wait.extend(scope), annotations: read,
  }, (input, context) => run('wait', input, client => client.wait(input.name, input.attemptId, { timeoutMs: input.timeoutMs, signal: context.mcpReq.signal })));
  server.registerTool('preview_logs', {
    description: 'Read bounded output; source selects a job or service. Omit source for all output. For incremental reads, supply the same attemptId and source with the previous cursor as after. truncated means earlier output was omitted. Without after, returns a tail. Known supplied environment values are redacted; other application output can contain secrets.',
    inputSchema: requestSchemas.logs.extend(scope), annotations: read,
  }, input => run('request', input, client => client.logs(input.name, input.attemptId, input)));
  server.registerTool('preview_cancel', {
    description: 'Cancel only the specified pending candidate and join its cleanup. A stale id never cancels a later attempt.',
    inputSchema: requestSchemas.cancel.extend(scope), annotations: cleanup,
  }, input => run('cleanup', input, client => client.cancel(input.name, input.attemptId)));
  server.registerTool('preview_stop', {
    description: 'Stop the named preview and join owned application/container cleanup. Preserves database data, attached services, and source files. Set afterEngineRestart only after the operator confirms an actual local Engine restart. This resolves an absent indeterminate creation and requires recovery authorization. It never restarts Docker.',
    inputSchema: requestSchemas.stop.extend(scope), annotations: cleanup,
  }, input => run('cleanup', input, client => client.stop(input.name, { afterEngineRestart: input.afterEngineRestart, expected: input.expected })));
  server.registerTool('preview_rerun_job', {
    description: 'Only after an explicit user request: rerun a job and start the stopped environment from its latest configuration. Supply its latest attemptId. Runs normal startup dependencies and always jobs; permits this named once job to run again. Stop first. Inspect partial writes and make the command safe to repeat; no rollback is implied. Never automatically retry a once job after failure or cancellation.',
    inputSchema: requestSchemas.rerunJob.extend(scope), annotations: { ...write, destructiveHint: true },
  }, input => run('request', input, client => client.rerunJob(input.name, input.attemptId, input.job)));
  server.registerTool('preview_delete_data', {
    description: 'Permanently delete a stopped environment\'s verified owned database data. Requires an explicit user request and daemon owner authorization. Rejects live applications or unresolved cleanup. Never deletes attached databases or source directories. Stop alone preserves data.',
    inputSchema: requestSchemas.deleteData.extend(scope), annotations: cleanup,
  }, input => run('request', input, client => client.deleteData(input.name, input)));
  server.registerTool('preview_secrets_setup', {
    description: 'Request exact secret references through the owner’s private browser form. For new bindings, choose project-specific references, not generic environment-variable names such as API_SECRET. Preserve existing references; use the same exact reference only for intentional sharing. After a canceled result, do not call this tool again or retry startup until the user explicitly asks to resume. The owner approves runtime access to unselected names, then enters only missing values privately. Existing entries are reused, never overwritten. Any authorized preview on this owner can use approved names until shutdown. Returns public metadata only. Never supply values or inspect the private form. Requires owner setup authorization. Saving starts no code; check status, then retry ordinary start/replace with the current spec only after complete.',
    inputSchema, annotations: write,
  }, (input, context) => run('request', input, async (client, project) => client.secretsSetup(await loadForStartup(input, project, client, context.mcpReq.signal), { signal: context.mcpReq.signal })));
  server.registerTool('preview_secrets_status', {
    description: 'Read or wait up to 25000ms for the public result of private secret setup. canceled is terminal: stop and wait for an explicit user request before new setup or startup. Do not assume accidental closure or ask for values in the canceled form. pending or saving after a wait timeout means setup is still in progress; keep the same request ID. An interrupted status wait leaves the form available. expired is terminal; ask before new setup. browser: failed reports launch failure, not cancellation. No values are read or returned. Complete records access approval and observed presence, not credential validity or future keystore access. Check current preview state before startup with the current spec. Partial is terminal: its private form cannot be reused. After the owner fixes the reported issue, request fresh setup; do not keep waiting on a partial result or ask the owner to resubmit the old form. Retain this request ID with its original project. If the turn ends while setup is pending, the owner can finish the form and send “Secrets saved—continue” to resume.',
    inputSchema: secretRequestSchemas.status.extend(scope), annotations: read,
  }, (input, context) => run(input.timeoutMs ? 'wait' : 'request', input, client => client.secretsStatus(input.id, { timeoutMs: input.timeoutMs, signal: context.mcpReq.signal })));
  server.registerTool('preview_shutdown', {
    description: 'Shut down this project owner and stop every preview it owns. Preserves managed data and stored keystore values. Ends runtime secret access approvals and private forms. Use only when the user requests owner teardown.',
    inputSchema: requestSchemas.list.extend(scope), annotations: cleanup,
  }, input => run('cleanup', input, async client => { await client.shutdown(); return { stopped: true }; }));
  return { server, close: async () => { closed = true; access?.close(); await Promise.all([...clients].map(client => client.close())); } };
}

/** Stdio is an adapter lifetime; EOF closes requests, never daemon previews. */
export function runMcp(options: ProjectOptions = {}): { close(): Promise<void> } {
  const adapter = createMcpServer(options);
  let closing: Promise<void> | undefined;
  const handle = serveStdio(() => adapter.server, {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: limits.controlBytes }),
    onerror: () => { process.stderr.write('previewhost MCP transport error.\n'); void close(); },
  });
  function close(): Promise<void> {
    if (!closing) {
      process.stdin.off('end', onEnd);
      process.off('SIGINT', onEnd); process.off('SIGTERM', onEnd);
      closing = (async () => { await adapter.close(); await handle.close(); })();
    }
    return closing;
  }
  const onEnd = () => { void close(); };
  process.stdin.once('end', onEnd);
  process.once('SIGINT', onEnd); process.once('SIGTERM', onEnd);
  return { close };
}

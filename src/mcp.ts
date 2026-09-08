import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { connectPreviewDaemon, type ClientOptions } from './client.js';
import { limits, requestSchemas, secretRequestSchemas, type PreviewApi, type SecretSetupApi } from './contracts.js';
import { failure, PreviewError } from './errors.js';

/** All tools call the same public API; the MCP host owns tool approval UI. */
export function createMcpServer(client: PreviewApi & Partial<Pick<SecretSetupApi, 'secretsSetup' | 'secretsStatus'>>): McpServer {
  const server = new McpServer({ name: 'previewd', version: '0.1.0' }, {
    instructions:
      'Manage local previews and application environments through an explicitly started previewd daemon. Use the ' +
      'existing task directories supplied by the host, including uncommitted files. Do not clone, reset, clean, or ' +
      'delete source to start a preview. Keep one preview name for continuing task data. Run necessary project ' +
      'preparation through its existing owner before startup. For incompatible writes to shared dependencies or ' +
      'build output, stop all affected previews before preparation and start again. Replacement overlaps processes ' +
      'and cannot undo source edits or database migrations. Application commands can load existing .env files. ' +
      'Retain submitted source paths in the task context until every consuming preview finishes cleanup. Stop all ' +
      'such previews before source teardown, including previews named for another task. Get/list omit source paths. ' +
      'If the source associations or previous-owner cleanup are uncertain, retain source. Start or replace returns ' +
      'an attempt. Wait for its id before using the URL. A wait timeout does not stop startup. Cancel requires the ' +
      'exact attempt id. Stop preserves database data. Delete data only after an explicit user request with ' +
      'preview_delete_data. Set afterEngineRestart only after the operator confirms an actual local Docker Engine ' +
      'restart. Disconnecting leaves previews running. Commands, managed databases, data deletion, and recovery ' +
      'require owner authorization. After a connection error, inspect get/list before another mutation. Bind stored ' +
      'credentials with {secret: ID}. Never ask for secret values in chat or tool arguments. For SECRET_REQUIRED, ' +
      'use preview_secrets_setup when available, let the owner complete the private browser form, check ' +
      'preview_secrets_status, then retry normal start/replace with the current spec. Saving does not start code. ' +
      'SECRET_DENIED requires the owner to select the exact IDs; a locked store requires owner unlock.',
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
    description: 'Validate one preview or environment spec and describe sources, commands, bindings, and cleanup. Does not start resources or grant permission. Environment values and database credentials are omitted.',
    inputSchema: requestSchemas.inspect, annotations: read,
  }, ({ spec }) => run('request', () => client.inspect(spec)));
  server.registerTool('preview_start', {
    description: 'Start a named preview or environment. Returns a starting attempt. Use preview_wait with its id. An environment becomes ready only after all its services. Execution and managed databases require daemon owner permission.',
    inputSchema: requestSchemas.start, annotations: write,
  }, ({ spec }) => run('request', () => client.start(spec)));
  server.registerTool('preview_replace', {
    description: 'Prepare a replacement while keeping active routes. All environment services become ready before the routes change together. Shared database data stays in place. Wait for the returned candidate id. Candidate failure keeps the old preview.',
    inputSchema: requestSchemas.replace, annotations: { ...write, destructiveHint: true },
  }, ({ name, spec }) => run('request', () => client.replace(name, spec)));
  server.registerTool('preview_list', {
    description: 'List bounded preview observations and retained database data, including names restored after owner restart. Use after a lost mutation response before retrying.',
    inputSchema: requestSchemas.list, annotations: read,
  }, () => run('request', () => client.list()));
  server.registerTool('preview_get', {
    description: 'Read active/candidate attempts, per-service outcomes, the latest result, retained database data, and incomplete cleanup for a name. Database credentials are omitted.',
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
      description: 'Open the owner’s private local browser form for missing selected secret names in this spec. Returns public request metadata only. Never supply credential values. Requires daemon owner setup authorization. If browser opening fails, ask the owner to use previewd secrets set with hidden input. Existing entries are never overwritten. Saving starts no code; retry ordinary start/replace after checking status.',
      inputSchema: secretRequestSchemas.setup.omit({ reopen: true }), annotations: write,
    }, ({ spec }, context) => run('request', () => client.secretsSetup!(spec, { signal: context.mcpReq.signal })));
    server.registerTool('preview_secrets_status', {
      description: 'Read the public result of a private secret setup request. No values are read or returned. Complete records observed presence or completed writes, not issuer validity or later read permission. On completion, retry normal startup with the current spec. A partial unknown write outcome requires a fresh setup check.',
      inputSchema: secretRequestSchemas.status, annotations: read,
    }, ({ id }) => run('request', () => client.secretsStatus!(id)));
  }
  return server;
}

/** Stdio is an adapter lifetime; EOF closes requests, never daemon previews. */
export function runMcp(options: ClientOptions = {}): { close(): Promise<void> } {
  const client = connectPreviewDaemon(options);
  let closing: Promise<void> | undefined;
  const handle = serveStdio(() => createMcpServer(client), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: limits.controlBytes }),
    onerror: () => { process.stderr.write('previewd MCP transport error.\n'); void close(); },
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

# Integrations and tested support

## Platforms and interfaces

Applications can call the ESM library, execute the CLI, send local HTTP requests,
or expose MCP tools to a model. previewd does not select a model.
Remote hosts need access to this machine's files and loopback network.
previewd does not provide remote access.

The initial release supports macOS. Checks used macOS 26.5.1 on arm64 with
Node.js 22.23.1 and 24.19.0. Native execution rejects other operating systems.
Linux and Windows remain unverified, including static and attached previews.

| Interface | Verified behavior | Requirement or limit |
| --- | --- | --- |
| ESM library | Static, command, attach, replacement, cancellation, and cleanup | The application owns the runtime lifetime |
| CLI and daemon | JSON/YAML environments, selected inputs, authentication, and shutdown | Clients require a separate foreground daemon |
| MCP SDK | Environment lifecycle, secret setup/status, discovery, and tool errors | Client approval behavior requires a separate host check |
| Coding-task worktrees | Live edits, replacement, data retention, and source preservation | The host owns preparation and source teardown |
| Task Monki | HTTP attachment, approval, readiness, replacement, and independent stop | Embedded runtime and browser UI integration remain unverified |

The client results below apply to the named versions and configurations.
A configuration example or successful discovery alone does not establish a working preview workflow.

## Connect an MCP client

1. [Install previewd](../README.md#install-locally) in your application directory.
2. From that directory, start the daemon in a separate terminal:

   ```sh
   ./node_modules/.bin/previewd serve --root "$PWD" --allow-exec
   ```

   This permits project code to execute as your user. It does not provide a sandbox.
   Managed databases also require the [database prerequisites](../examples/multi-repo/README.md#install-the-dependencies).

3. Run `node -p process.execPath` to find the absolute Node executable.
4. Add the configuration for your client below.
5. Replace `/absolute/node/bin/node` and `/absolute/app` with your Node executable and application directory.
6. Ask the client to inspect the spec.
7. Ask the client to start the preview.
8. Ask the client to wait for the returned candidate ID.
9. Open the ready URL.
10. Check the application.
11. Ask the client to stop the preview.
12. After you finish, run `./node_modules/.bin/previewd shutdown` from your application directory.

Use absolute source paths in MCP specs. The [API reference](api.md#http-and-mcp)
lists tool arguments. For a custom daemon, add `--endpoint` and `--token-file`
to the MCP arguments. Keep token values out of configuration files.

The absolute Node command works without Node on the client's PATH.
An absolute `previewd` executable still uses `env node` and needs Node on PATH.
The daemon also needs a PATH that resolves application commands, or absolute command paths.

Discovery exposes twelve `preview_*` tools without a daemon. Tool operations
require the daemon. Client approval does not grant its execution permission.
A client disconnect leaves daemon previews active.

## Codex

Add this server to your [Codex MCP configuration](https://developers.openai.com/codex/mcp/):

```toml
[mcp_servers.previewd]
command = "/absolute/node/bin/node"
args = ["/absolute/app/node_modules/previewd/dist/cli.js", "mcp"]
```

### MCP approvals

Codex 0.146.0 with `gpt-5.5` passed standalone-command and API/web workflows
through `exec` and App Server. Each successful model run called inspect, start,
wait, and stop for both previews. HTTP checks covered readiness, API connectivity,
and injected origins. Process groups and listeners closed after stop and daemon shutdown.

Approval policy and reviewer selection are separate controls.
Selecting `auto_review` alone does not prove that automatic review ran.
All configurations below used a read-only sandbox.

| Client and policy | Approval configuration | Result |
| --- | --- | --- |
| `exec`, `never` | `auto_review`, default MCP approval modes | Inspect passed. Exec canceled startup elicitation before dispatch |
| App Server, `never` | The client accepted each requested operation | Both workflows passed with client-mediated approval |
| `exec`, `on-request` | `auto_review`, start/stop approval mode `prompt` | Both workflows passed. Four completed reviews preceded mutation dispatch |
| App Server, `on-request` | `auto_review`, start/stop approval mode `prompt` | Four agent decisions reported `approved`. No client approval requests occurred |

For the verified automatic-review path, use this server and approval configuration.
Replace the earlier `previewd` server entry with this example.
Place the first five options before any table headers in the Codex configuration:

```toml
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "read-only"
features.guardian_approval = true
features.tool_call_mcp_elicitation = true
[mcp_servers.previewd]
command = "/absolute/node/bin/node"
args = ["/absolute/app/node_modules/previewd/dist/cli.js", "mcp"]

[mcp_servers.previewd.tools.preview_start]
approval_mode = "prompt"

[mcp_servers.previewd.tools.preview_stop]
approval_mode = "prompt"
```

Use the same server name in the tool rules and server definition.
The `exec` trace omitted decision payloads. Its approval result is an inference
from successful dispatch after each completed review. App Server recorded the
actual decisions with `decisionSource: agent`. Each request can receive a different decision.
See [Codex automatic review](https://learn.chatgpt.com/docs/sandboxing/auto-review).

For client-mediated approval, App Server sends `mcpServer/elicitation/request`
with `_meta.codex_approval_kind: "mcp_tool_call"`.
Check the server, tool, arguments, task, and turn against the authorized operation.
For an approved call, return `{"action":"accept","content":{},"_meta":null}` with the received request ID.
This grants that call without a saved approval.
See the [App Server protocol](https://learn.chatgpt.com/docs/app-server).

Direct App Server MCP calls also passed the shared-notes database workflow:
HTTP writes, replacement, cancellation, data retention, and explicit deletion.
That check used no model turns.

### Codex Desktop

Codex Desktop in ChatGPT 26.901.51231, build 8109, remains unverified.
The computer-use tool blocked access to `com.openai.codex` before a model turn.
The block prevented selection of **Approve for me** and inspection of the effective configuration.
No desktop MCP calls or reviewer decisions were observed.
This test access restriction does not establish a previewd defect.

## Cursor and other MCP hosts

In Cursor, add this server to the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "previewd": {
      "command": "/absolute/node/bin/node",
      "args": ["/absolute/app/node_modules/previewd/dist/cli.js", "mcp"]
    }
  }
}
```

Use the host's approval controls to enable the server and its tools.
Other stdio MCP hosts can use these executable arguments.
Unlisted clients and models remain unverified.

### Cursor IDE

Cursor IDE 3.19.14 with Composer 2.5 Fast passed standalone-command and API/web
workflows through model-driven inspect, start, wait, and stop calls.
The mode was **Allowlist (with Sandbox)**, with an empty MCP allowlist and
**MCP Tools Protection** off. No MCP approval overrides applied.

Inspect, start, and wait had no observed per-call prompts.
Both stop calls required manual approval through **Run** before dispatch.
No automatic-review decision payload was captured.

HTTP checks covered readiness, API connectivity, and injected origins.
All application processes, MCP connections, and listeners closed after cleanup.
These IDE checks used Node.js 22.23.1 and no databases or stored secrets.

### Cursor Agent

Cursor Agent 2026.08.25-3e8eec8 passed the shared-notes database workflow in a
headless model turn. HTTP checks covered PostgreSQL writes, Redis values, and
replacement of all three applications at the same URL.
Stop retained data. A separate client reopened the environment, checked the
values, and explicitly deleted the fixture data. The recorded result does not
identify the model or establish IDE database support.

## Claude Code

Use the `mcpServers` JSON structure above in a file such as `previewd.mcp.json`.
From the project directory, start Claude Code with that file:

```sh
claude --mcp-config ./previewd.mcp.json --strict-mcp-config --model sonnet --effort low --permission-mode manual
```

Claude Code 2.1.239 passed both standalone-command and API/web workflows in its
interactive terminal. Sonnet with low effort was available.
The client displayed **Sonnet 5 with low effort** and recorded `claude-sonnet-5`.

The tested permissions allowed inspect/wait and required approval for start/stop.
All four start/stop calls required **Yes** for the current request before dispatch.
This was manual approval. HTTP checks covered readiness, API connectivity, and
injected origins. Stop and client exit released the application processes, MCP
process, and listeners. The separate daemon also shut down.

These checks used Node.js 22.23.1 and installed `previewd@0.1.0`.
Other models, permission modes, databases, and secret workflows remain unverified.
See [Claude Code model configuration](https://code.claude.com/docs/en/model-config).

## OpenCode

Add this server to your OpenCode configuration:

```json
{
  "mcp": {
    "previewd": {
      "type": "local",
      "command": ["/absolute/node/bin/node", "/absolute/app/node_modules/previewd/dist/cli.js", "mcp"],
      "enabled": true
    }
  },
  "permission": {
    "previewd_preview_inspect": "allow",
    "previewd_preview_wait": "allow",
    "previewd_preview_start": "ask",
    "previewd_preview_stop": "ask"
  }
}
```

OpenCode 1.18.25 with `openai/gpt-5.5` passed both workflows through its interactive
`--mini` terminal. No reasoning variant override applied.
The model called inspect, start, wait, and stop for each preview.

The tested permissions allowed inspect/wait and required approval for start/stop.
All four start/stop calls required **Allow once** before dispatch.
No automatic reviewer or saved approval was used.
HTTP checks covered readiness, API connectivity, and injected origins.
Stop and client exit released the application processes, MCP process, and listeners.
The separate daemon also shut down.

These checks used Node.js 22.23.1 and installed `previewd@0.1.0`.
Other models, permission modes, databases, and secret workflows remain unverified.
See [OpenCode permissions](https://dev.opencode.ai/docs/permissions/).

## Private secret setup

Codex App Server 0.146.0 with `gpt-5.5` and Cursor Agent 2026.09.02-c22c1a3
with **Auto** passed missing-secret setup and startup retry.
Save started no application. The retry delivered the value, and logs redacted it.
Client transcripts contained neither the value nor the private form grant or control token.

These host checks used synthetic storage and intercepted owner entry.
Separate tests used disposable macOS Keychains and the Chrome 152 owner form.
Browser checks covered validation, save, edit, cancel, partial results, expiry,
and keyboard focus on desktop/light and mobile/dark viewports.

The backend rejected `gpt-6-astra` on Codex 0.146.0 and required a newer client.
The passing check used `gpt-5.5`. Cursor **Auto** did not report its underlying model.

The packaged helper ran as arm64 and as x86_64 under Rosetta.
Native Intel hardware and interactive approval after a package update remain unverified.
See [Keychain access and updates](security.md#stored-secrets-and-private-entry).

## Existing task worktrees

The [task workflow](worktrees.md) passed with two Git worktrees that contained
staged, unstaged, and untracked changes. Startup failure, replacement,
cancellation, disconnect, and stop preserved their source files and Git metadata.
Codex App Server 0.146.0 used direct MCP calls, without model turns.
Stop/start retained one task's data and kept a second task's data separate.

Chrome 152 passed browser writes and reads through numeric and readable frontend
origins at desktop and mobile widths. The browser showed saved notes, reporting
results, and the stopped-backend state without application errors.

Codex's command runner passed installation, generation, failure, and cancellation checks.
Abrupt App Server loss left its setup processes alive.
The host must resolve that cleanup before conflicting preparation or source removal.
Setup inside an explicit daemon-owned HTTP startup command survived client loss
and stopped with its preview. This does not repair external host processes.
See [preparation ownership](worktrees.md#prepare-and-start).

## Task Monki

Task Monki can attach to previewd's numeric loopback URL.
It owns the consumer recipe, attachment, approval, worktree, and consumer process.

1. Start the backend through previewd.
2. Add an HTTP attachment and its service dependency to the Task Monki consumer recipe.
3. Pass the attachment origin through the recipe's `attached-http-origin` environment binding.
4. Bind that attachment to the ready previewd URL.
5. Resolve and approve the Task Monki preview plan.
6. Start the Task Monki consumer preview.
7. After use, stop the consumer in Task Monki.
8. Stop the backend through previewd.

Task Monki revision `aded142d47e1453d88fc028d9b060d5dd43babe0` passed this workflow
with its real service, SQLite store, Git worktree, approval, and native consumer.
The consumer fetched two backend versions at one URL.
Each system stopped its own processes independently and preserved source files.
Embedded runtime integration, Compose, the private vault, Design previews, and
the Task Monki browser UI remain unverified.

## Framework configuration

Install project dependencies before startup. The daemon requires `--allow-exec`
and access to each project directory through `--root`.
Replace the `/absolute/...` paths below with existing project directories.
Save the selected spec as `preview.json` in your application directory.

With the daemon active, run these commands from that directory:

```sh
./node_modules/.bin/previewd start --file preview.json
./node_modules/.bin/previewd get PREVIEW_NAME
```

Replace `PREVIEW_NAME` with the spec's `name`. Open the returned URL.
After use, run `./node_modules/.bin/previewd stop PREVIEW_NAME`.
To close the daemon, run `./node_modules/.bin/previewd shutdown`.

Vite 8.2.2 and Next.js 16.3.4 passed Chrome 152 checks on Node.js 22.23.1.
Both served interactive pages and source updates through numeric URLs and
`<name>--web.localhost` environment aliases, including WebSocket connections.
Desktop and mobile checks found no error overlay or application errors.
Python 3.14.6 passed HTTP and native process cleanup checks.

### Vite

```json
{
  "name": "vite-app",
  "type": "command",
  "cwd": "/absolute/vite-app",
  "command": ["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"]
}
```

Before startup, add this configuration to the Vite 8 project's `vite.config.js`:

```js
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    ws: process.env.PREVIEW_URL
      ? { clientPort: Number(new URL(process.env.PREVIEW_URL).port) }
      : undefined,
  },
});
```

This sets the WebSocket client to the public preview port.
Earlier Vite versions use `server.hmr.clientPort` and remain unverified.
See [Vite server options](https://vite.dev/config/server-options) and
[Vite command arguments](https://vite.dev/guide/cli.html).

### Next.js

```json
{
  "name": "next-app",
  "type": "command",
  "cwd": "/absolute/next-app",
  "command": ["node", "node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"],
  "timeoutMs": 120000
}
```

The CLI waits at most 30 seconds per request.
If initial compilation takes longer, run `get` and another `wait` with the returned attempt ID.
See the [Next.js CLI reference](https://nextjs.org/docs/app/api-reference/cli/next).

### Python

```json
{
  "name": "python-site",
  "type": "command",
  "cwd": "/absolute/site",
  "command": ["python3", "-m", "http.server", "{port}", "--bind", "127.0.0.1"]
}
```

Python must exist on the daemon PATH. This command uses Python's file server
and its file-access rules. Use a `static` spec for previewd's own file restrictions.

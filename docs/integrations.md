# Integrations and tested support

## Support boundary

The library and protocols do not select an AI model. A trusted application can
call the ESM library, execute the CLI, send local HTTP requests, or expose MCP
tools to its model. The model still needs a host that supports one of those interfaces.

Remote and cloud hosts need explicit access to this machine's filesystem and
loopback network. previewd does not provide that bridge.

The initial release supports macOS only.
The verification environment is macOS 26.5.1, arm64, with Node.js 22.23.1 and 24.19.0.
Native execution rejects other operating systems. Static and attach code does not
require macOS process tools, but Linux and Windows behavior remains unverified.

| Integration | Verified behavior | Boundary |
| --- | --- | --- |
| ESM library | Static, command, attach, replacement, cancellation, stop, and close | One runtime per owner |
| CLI and daemon | JSON/YAML environment startup, service outcomes, selected owner inputs, authentication, and shutdown | Foreground daemon must already run |
| MCP SDK | Environment lifecycle and private secret setup/status. Both protocol eras discover tools and return tool errors | Host-specific approval UI remains outside previewd |
| Codex App Server 0.146.0 | Model-driven command/environment startup and stop; database lifecycle; private secret setup and retry | Command/environment and secret checks use `gpt-5.5`; database checks use direct MCP. Desktop UI remains unverified |
| Cursor Agent | Three-application database lifecycle; private secret setup and retry | Headless model sessions on the versions named below. IDE behavior remains unverified |
| Task Monki | Real HTTP dependency approval, readiness, replacement, and independent stop | Engine embedding and production UI integration remain unverified |

Additional client and framework results appear in their sections. Client versions
and host behavior can change. A configuration example alone does not establish support.

## Existing task worktrees

The [task workflow](worktrees.md) runs existing directories through the same CLI
and MCP operations. The installed shared-notes recipe passed with two Git worktrees
containing staged, unstaged, and untracked changes. Git metadata and source files
remained intact through failed startup, replacement, cancellation, disconnect,
and stop. Explicit caller edits remained visible on reload.

Codex App Server 0.146.0 made eighteen direct MCP calls across two connections.
The checks retained one task's PostgreSQL and Redis data across stop/start,
kept another task independent, and stopped both source consumers before removal.
These checks made no model turns and changed no user configuration.

Chrome 152 checked real browser writes and reads through numeric and readable
frontend origins. Desktop 1280 × 900 and mobile 390 × 844 viewports showed the
saved note, reporting result, and stopped-backend state without application errors.
The example's missing favicon produced separate 404 messages.

Codex's standalone command runner passed offline installation, generation, failure,
and cancellation checks. An edited lockfile installed the new dependency and
rebuilt its generated consumer. Cancellation stopped a parent, child, and grandchild sharing stdout.
Abrupt App Server loss left those setup processes alive. Setup inside an explicit
daemon-owned application command survived that client loss and stopped with the
preview. While its setup cleanup is uncertain, a host must retain source and block
conflicting installation, generation, or build retries. This guidance does not fix
Codex's crash cleanup. The host must resolve its own process ownership before continuing.

Automatic task deletion, Task Monki engine replacement, and other hosts' setup
recovery remain outside this integration. Each host still owns its submitted
source associations and teardown ordering.

## Codex

Install the local tarball first. Start the daemon in a separate terminal:

```sh
/absolute/app/node_modules/.bin/previewd serve --root /absolute/project
```

Add the following server to your Codex MCP configuration:

```toml
[mcp_servers.previewd]
command = "/absolute/node/bin/node"
args = ["/absolute/app/node_modules/previewd/dist/cli.js", "mcp"]
```

For a custom owner, add `--endpoint` and `--token-file` to the MCP arguments.
Replace both paths with actual installed paths. `node -p process.execPath` in the
working shell prints its absolute Node executable. The ordinary previewd executable
uses `#!/usr/bin/env node`; its absolute path still requires Node on the host PATH.
The explicit Node launch above works with `PATH=/usr/bin:/bin` in the installed-package
MCP check. This verifies process launch and protocol discovery, not Codex Desktop UI.
The separately started daemon still needs a PATH that resolves project commands,
or those commands must use their own absolute executable paths.
The token value does not belong in this configuration.

The current clean package exposes twelve MCP tools, including secret setup/status.
Codex App Server 0.146.0 discovered the ten preview tools in the database scenario.
Direct MCP calls started the three-application example with owned PostgreSQL and Redis.
Independent HTTP requests wrote a note through the API and read it through reporting.
Replacement kept the public URL and both database values while all three applications switched to v2.
Canceling a pending v3 candidate preserved v2. Stop retained data; explicit
`preview_delete_data` removed it. The test preserved user configuration and used
no model turn. The Codex desktop UI remains unverified.

The [multi-repository example](../examples/multi-repo/README.md) describes owner
configuration for native applications and managed databases. The same MCP
configuration sends its complete environment spec through one start operation.

See the [official Codex MCP configuration reference](https://developers.openai.com/codex/mcp/).

### MCP approvals

In the tested configuration, Codex requests approval before `preview_start` and
`preview_stop`. A custom App Server client receives `mcpServer/elicitation/request`
in form mode, with `_meta.codex_approval_kind` set to `mcp_tool_call`.

Verify the request's server, tool, arguments, task, and turn against the authorized operation.
For an approved call, return this result with the received request ID:

```json
{"action":"accept","content":{},"_meta":null}
```

This response grants the current call without a saved approval. Other decisions
use `decline` or `cancel`, with `content: null`. See the
[App Server protocol](https://learn.chatgpt.com/docs/app-server).

Codex 0.146.0 `exec` automatically cancels elicitation requests. It can report
`user cancelled MCP tool call` before the request reaches previewd.
The [version's request handler](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/exec/src/lib.rs)
defines this behavior. The generic `approval_policy="never"` configuration did
not remove the MCP approval requirement in the tested read-only sandbox.

Codex App Server 0.146.0 with `gpt-5.5` passed both a standalone command scenario
and an API/web environment scenario using the installed `previewd@0.1.0` package.
The model called inspect, start, wait, and stop for each scenario.
The test client accepted four approvals for the exact fixture operations.
Independent HTTP checks verified readiness, API dependencies, and injected origins.
Stop removed all three application processes, their groups, and five listeners.
Global configuration, source files, and tool annotations remained unchanged.

The correction is confined to the test client's approval handling.
previewd's runtime, request contracts, and owner permissions remain unchanged.

## Cursor and other MCP hosts

Use this project-level `.cursor/mcp.json` configuration in Cursor:

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

Start the daemon separately. Use the host approval controls to enable the server
and its tools. Native execution also requires the daemon launch permission.
Substitute actual Node and CLI paths as described above. The minimal-PATH package
check verifies this launch form; Cursor IDE remains unverified.

Cursor Agent 2026.08.25-3e8eec8 discovered all ten tools and completed one headless model turn.
The turn made twelve previewd calls through inspect, start, wait, get, list,
logs, replace, and stop. Independent HTTP requests verified a PostgreSQL note
and Redis cache value before and after replacement. All three applications
switched to v2 at the same public URL.

Stop retained both databases. A separate public client reopened the environment
and verified both values before deleting the fixture data. Only previewd's MCP
server was enabled. Temporary project settings preserved global configuration.
Cursor IDE behavior remains unverified.

Other stdio MCP hosts can use the same executable and arguments. previewd supports
tool discovery without a running daemon. Actual tool operations require the daemon.
Host and model combinations that do not appear in the verified table remain unverified.

### Private secret setup

Codex App Server 0.146.0 with `gpt-5.5` and Cursor Agent
2026.09.02-c22c1a3 with `Auto` each completed eleven previewd calls:
inspect, failed start/wait, private setup/status, fresh start/wait, get, logs,
stop, and get. Independent checks verified that Save started no application.
The ordinary retry delivered the supplied value, and logs redacted it.
Captured client transcripts contained neither that value nor the private form
grant or control bearer.

These host tests used synthetic storage and intercepted owner entry. Separate
tests used disposable macOS Keychains and the rendered Chrome 152 owner form.
Browser checks covered validation, saving, edit/cancel, partial saves, expiry,
keyboard focus, a 1280 × 1000 light viewport, and a 390 × 844 dark viewport.
They found no overflow or application error; an expired grant returned the expected 401.

The installed Codex version could not run `gpt-6-astra`: its backend required a
newer client. The passing test used the compatible `gpt-5.5` catalog entry without
changing global settings. Cursor `Auto` did not report its underlying model.

The packaged helper executes as arm64 and as x86_64 under Rosetta. Native Intel
hardware and interactive reapproval after an update were not tested. Changing
the helper's code or architecture slice can require an owner access decision;
see [Keychain access and updates](security.md#stored-secrets-and-private-entry).

## Task Monki

Task Monki can use previewd through its existing local HTTP attachment workflow.
previewd supplies a numeric loopback URL. Task Monki owns its consumer recipe,
attachment binding, approval, worktree, and consumer process.

1. Start the backend through previewd.
2. Add an HTTP attachment and its service dependency to the Task Monki consumer recipe.
3. Pass the attachment origin through the recipe's `attached-http-origin` environment binding.
4. Bind that attachment to the ready previewd URL.
5. Resolve and approve the Task Monki preview plan.
6. Start the Task Monki consumer preview.

The executed integration used Task Monki revision
`aded142d47e1453d88fc028d9b060d5dd43babe0`. Its real service, SQLite store, Git
worktree, approval flow, and native consumer fetched two backend versions at one URL.
Stopping Task Monki preserved previewd. Stopping previewd released its native groups
and listener. Source files remained unchanged.

This integration requires no Task Monki source change. Replacing its PreviewManager
with the embedded library remains a separate, unverified integration.
Compose, the private vault, Design previews, and Task Monki browser UI were not exercised.

## Framework configuration

Dependencies must already exist in the selected directory. Use explicit arguments
for the allocated port and loopback binding. The daemon needs `--allow-exec`.

Vite 8.2.2 and Next.js 16.3.4 passed Chrome 152 checks through previewd on Node 22.23.1.
Both also passed environment checks through `<name>--web.localhost` aliases.
The pages accepted button clicks and reflected source changes through their alias WebSocket connections.
Desktop and mobile checks showed no framework error overlay. The browser reported
no page or console errors. Python 3.14.6 passed another HTTP request and native
process cleanup check.

### Vite

```json
{
  "name": "vite-app",
  "type": "command",
  "cwd": "/absolute/vite-app",
  "command": ["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"]
}
```

For Vite 8, configure the WebSocket client to use the public preview port:

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

Earlier Vite versions use `server.hmr.clientPort`. Those versions were not exercised.
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

The CLI waits at most 30 seconds per request. If initial compilation takes longer,
use `get` and another `wait` with the returned attempt ID.
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

Python must exist on the daemon PATH. This command serves files through a native
Python process. For previewd's static-file restrictions, use the `static` spec.
Python's server has its own file-access behavior.

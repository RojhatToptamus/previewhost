# Integrations and tested support

## Support boundary

The library and protocols do not select an AI model. A trusted application can
call the ESM library, execute the CLI, send local HTTP requests, or expose MCP
tools to its model. The model still needs a host that supports one of those interfaces.

Remote and cloud hosts need explicit access to this machine's filesystem and
loopback network. previewd does not provide that bridge.

The verification environment is macOS 26.5.1, arm64, with Node.js 22.23.1 and 24.19.0.
Native execution rejects other operating systems. Static and attach code does not
require macOS process tools, but Linux and Windows behavior remains unverified.

| Integration | Verified behavior | Boundary |
| --- | --- | --- |
| ESM library | Static, command, attach, replacement, cancellation, stop, and close | One runtime per owner |
| CLI and daemon | JSON/YAML environment startup, service outcomes, selected owner inputs, authentication, and shutdown | Foreground daemon must already run |
| MCP SDK | Environment lifecycle and private secret setup/status. Both protocol eras discover tools and return tool errors | Host-specific approval UI remains outside previewd |
| Codex App Server 0.146.0 | Three-application database lifecycle; private secret setup and retry | Database checks use direct MCP; secret checks use a `gpt-5.5` model session. Desktop UI remains unverified |
| Cursor Agent | Three-application database lifecycle; private secret setup and retry | Headless model sessions on the versions named below. IDE behavior remains unverified |
| Task Monki | Real HTTP dependency approval, readiness, replacement, and independent stop | Engine embedding and production UI integration remain unverified |

Additional client and framework results appear in their sections. Client versions
and host behavior can change. A configuration example alone does not establish support.

## Codex

Install the local tarball first. Start the daemon in a separate terminal:

```sh
/absolute/app/node_modules/.bin/previewd serve --root /absolute/project
```

Add the following server to your Codex MCP configuration:

```toml
[mcp_servers.previewd]
command = "/absolute/app/node_modules/.bin/previewd"
args = ["mcp"]
```

For a custom owner, add `--endpoint` and `--token-file` to the MCP arguments.
An absolute executable path avoids differences between GUI and shell PATH values.
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

## Cursor and other MCP hosts

Use this project-level `.cursor/mcp.json` configuration in Cursor:

```json
{
  "mcpServers": {
    "previewd": {
      "command": "/absolute/app/node_modules/.bin/previewd",
      "args": ["mcp"]
    }
  }
}
```

Start the daemon separately. Use the host approval controls to enable the server
and its tools. Native execution also requires the daemon launch permission.

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

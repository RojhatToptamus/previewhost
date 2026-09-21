# Integrations

Use MCP for a coding client, or configure an application's development server to run behind Previewhost's local URL.

## Connect an MCP client

[MCP setup](mcp.md) contains the current registration commands for Codex, Cursor, and Claude Code.
One global registration can serve multiple projects. Project approval, command execution permission, and secret access are separate checks.

If the client cannot find Previewhost or its application commands, check its [PATH](troubleshooting.md#the-client-cannot-find-previewhost).
After a package update, restart the MCP connection and any affected [project owners](installation.md#update-an-installation).

## Tested clients

These are recorded checks of earlier local builds, not certification of every client version or permission mode.
These client checks predate the encrypted keystore. See [Secrets](secrets.md) for current setup.
The September 15 checks used a local `0.1.0` development build on macOS, disposable projects, local Docker PostgreSQL, and fake credentials.

| Client | Recorded result | Limit |
| --- | --- | --- |
| Cursor 3.20.21 | Two worktree chats shared one MCP process. Each ran a frontend, backend, and database with independent updates and retained data. | Client approval behavior depends on its configuration. |
| Claude Code 2.1.271 and 2.1.272 | Interactive terminal workflows passed project approval, private secret entry, startup, and owner recovery. | Auto mode blocked project-access calls in the 2.1.271 check. |
| Codex CLI 0.154.0 | Interactive workflows passed project approval, private entry, startup, and database retention after owner recovery. | A completed agent turn can require a continuation message after private entry. |
| Codex desktop | MCP initialization was observed. | A complete desktop workflow was not verified. |
| OpenCode 1.18.25 | Earlier interactive tests passed command and API/web previews with per-call start/stop approval. | These used the former `previewd` package and a separate daemon. Global project approval, databases, and secrets remain unverified. |

The tested workflows included application requests, not only tool discovery.
An agent's successful behavior in one trial does not guarantee that it will choose correct commands in another project.

### Cursor IDE

Cursor can cache tool descriptions after **Reload MCP Server** or **Reload Window**.
If descriptions remain stale after an update, restart Cursor fully.
The [Cursor MCP guide](https://cursor.com/docs/mcp) describes its server configuration.

In a Cursor 3.20.7 check, an edited registration showed connected tools while calls timed out.
A new server name after workspace reload restored calls. This was a client workaround, not a Previewhost transport change.
Check an actual tool result after reconnection.

### Global registration and Cursor worktrees

Cursor 3.20.21 supplied each checkout path through one MCP process.
Both worktrees retained separate database notes after stop/start, even when they shared a secret reference and backend source.
Each owner required its own project and secret approval.
The previews remained available after MCP reconnection, which required fresh project approval.

## Agent skill

The optional Previewhost skill gives an agent instructions for commands, configuration, and recovery.
The npm package includes it at `dist/skills/previewhost/SKILL.md`, with its referenced documentation and examples.
An agent can read those files directly.

To install the repository skill for Codex with the [skills CLI](https://github.com/vercel-labs/skills), run:

```sh
npx skills add RojhatToptamus/previewhost --skill previewhost --agent codex --yes
```

Use the installer's corresponding agent name for another supported client.
Repeat the installation command to refresh the skill and its references.
Installation with skills 1.5.25 and explicit skill use in Codex CLI 0.146.0 passed recorded macOS checks.
Automatic skill selection and other clients' skill workflows remain unverified.

Skill installation does not install Previewhost, register MCP, or grant execution permission.
See [MCP setup](mcp.md#optional-agent-skill) for the distinction.

## Existing task worktrees

Recorded tests used two Git worktrees with staged, unstaged, and untracked changes.
Startup failure, replacement, cancellation, disconnect, and stop preserved those files and Git metadata.
Stop/start retained each task's separate managed data.

A Codex App Server 0.146.0 crash left externally started preparation processes alive.
Previewhost cannot clean up processes started by a coding client's command runner.
Stop those processes before another preparation attempt or source removal.
See the [worktree guide](worktrees.md#prepare-and-start).

## Task Monki

Task Monki can attach to a ready Previewhost HTTP URL.
Start the backend through Previewhost, then bind its returned numeric URL to the consumer's HTTP attachment in Task Monki.
Each system owns its own processes. Stop the consumer in Task Monki before stopping its backend in Previewhost.

Task Monki revision `aded142d47e1453d88fc028d9b060d5dd43babe0` passed attachment, approval, readiness, replacement, and independent stop checks.
Embedded runtime integration and the Task Monki browser UI remain unverified.

## Framework configuration

Install the application's dependencies before startup.
Replace `/absolute/...` in an example with your existing project directory, then save the spec as `preview.json` there.
From that directory, run:

```sh
previewhost start --file preview.json --allow-exec
```

Open the returned URL and check the application. After use, run `previewhost stop PREVIEW_NAME`, with the spec's `name`.
For YAML and service bindings, see [Write preview.yaml](recipes.md).

Recorded checks used Vite 8.2.2, Next.js 16.3.4, Python 3.14.6, and Node.js 22.23.1 on macOS.
Vite and Next.js served interactive pages and source updates through numeric URLs and environment aliases, including WebSocket connections.
Python passed HTTP and process cleanup checks. Other versions can require different framework flags.

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
and its file-access rules. Use a `static` spec for previewhost's own file restrictions.

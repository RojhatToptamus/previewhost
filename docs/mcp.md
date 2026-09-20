# MCP setup

Register Previewhost with your coding client so an agent can start, inspect, replace, and stop local previews across projects.

## Register a client

[Install the global CLI](installation.md#install-the-cli) first. No repository list is required for global registration.
The `--allow-exec` flag permits trusted application commands, managed databases, and private secret setup with your user permissions.

### Codex

Run in your terminal:

```sh
codex mcp add previewhost -- previewhost mcp --allow-exec
```

### Cursor

Add this server to `~/.cursor/mcp.json`. Preserve any other servers in the file:

```json
{
  "mcpServers": {
    "previewhost": {
      "command": "previewhost",
      "args": ["mcp", "--allow-exec"]
    }
  }
}
```

Enable Previewhost in Cursor's MCP settings.

### Claude Code

Run in your terminal:

```sh
claude mcp add --scope user previewhost -- previewhost mcp --allow-exec
```

Client approval behavior varies. The [integration record](integrations.md) lists tested versions, configurations, and known limitations.

## Preview an application

In your project chat, ask:

```text
Preview this application with Previewhost. Read its instructions and start commands,
reuse preview.yml if present, and verify the returned URL in a browser.
```

The agent supplies the actual project path on each call.
`preview_access` asks you to approve that project and any additional source directories.
Your client can also require approval for individual tools.

The agent can reuse root `preview.yml` or supply a spec directly.
An invalid existing recipe is an error. Previewhost does not silently replace it or save a new recipe without a save request.

If credentials are missing, approve their names and enter values in the private browser form.
After saving, tell the agent to continue if its turn already ended. See [Secrets](secrets.md).

## Understand what stays running

The MCP adapter connects to a persistent owner for each project.
An agent pause or MCP disconnection does not stop the previews.
Reconnection needs project approval again. An existing owner's secret approvals last until that owner shuts down.

Run `previewhost dashboard` to inspect the live automatic owners.
Use stop for one preview. Owner shutdown stops every preview in that project.

## Add databases or an agent skill

Managed PostgreSQL and Redis need a local Docker Engine and downloaded images.
Follow [Databases](databases.md#prepare-docker), including the socket override for other local Engines.

The optional [Previewhost agent skill](https://github.com/RojhatToptamus/previewhost/blob/main/skills/previewhost/SKILL.md) provides recipe and recovery guidance.
It ships under `dist/skills/previewhost` in the npm package.
Install it through your client's skill mechanism. MCP registration does not install the skill, and the tools work without it.

For manual daemons, restricted roots, and tool parameters, use the [MCP reference](api.md#http-and-mcp).

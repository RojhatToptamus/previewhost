# MCP setup

Register Previewhost with your coding client so an agent can start, inspect, replace, and stop local previews across projects.

## Register a client

Use macOS with Node.js 22.23 or later. Install the global executable:

```sh
npm install -g previewhost
```

Choose your client below. These registrations work across projects without a repository list.
`--allow-exec` permits trusted commands, managed databases, and private secret setup with your user permissions. It provides no sandbox.

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

Client approval behavior varies. [Integrations](integrations.md#tested-clients) lists tested versions and limits.
If the client cannot find the executable, check its [PATH](troubleshooting.md#the-client-cannot-find-previewhost).

## Preview an application

In your project chat, ask:

```text
Preview this application with Previewhost. Read its instructions and start commands,
reuse preview.yml if present, and verify the returned URL in a browser.
```

The agent supplies the actual project path on each call.
`preview_access` asks you to approve that project and any additional source directories.
Your client can also require approval for individual tools.

The agent can reuse root `preview.yml` or supply a spec directly. You do not need to write a file first.
An invalid existing file is an error. To keep a working spec for later use, ask the agent to save it as `preview.yml`.

If credentials are missing, approve the intended references in the private browser form.
Enter the missing values there.
If the agent turn ended before you saved, tell it to continue after the save. See [Secrets](secrets.md).

## Understand what stays running

The MCP adapter connects to a persistent owner for each project.
An agent pause or MCP disconnection does not stop the previews.
Reconnection needs project approval again. An existing owner's secret approvals last until that owner shuts down.

After startup, check the application at the returned URL. If a request fails, ask the agent to read logs.
Run `previewhost dashboard` in another terminal to inspect previews across projects.
To finish, ask the agent to stop the preview. Owner shutdown stops every preview in that project.

## Add databases

Managed PostgreSQL and Redis need a local Docker Engine and downloaded images.
Follow [Databases](databases.md#prepare-docker), including the socket override for other local Engines.

## Optional agent skill

The optional [Previewhost agent skill](https://github.com/RojhatToptamus/previewhost/blob/main/skills/previewhost/SKILL.md) provides recipe and recovery guidance.
It ships under `dist/skills/previewhost` in the npm package.
Install it through your client's skill mechanism. MCP registration does not install the skill, and the tools work without it.

For tool parameters and restricted roots, use the [MCP reference](api.md#http-and-mcp).

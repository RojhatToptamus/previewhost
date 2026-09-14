<p align="center">
  <img src="./assets/previewhost.svg" width="144" height="144" alt="previewhost app icon">
</p>

<h1 align="center">previewhost</h1>
  <p align="center">
    <a href="https://www.npmjs.com/package/previewhost">
      <img src="https://img.shields.io/npm/v/previewhost.svg?style=flat-square" alt="NPM version" />
    </a>
  </p>
previewhost runs local preview environments for applications with multiple services.
An environment can connect frontends, backends, and PostgreSQL or Redis databases across repositories and Git worktrees.

Use previewhost when several coding agents or worktrees need separate running copies of the same application.
Each task gets its own service ports and connections, without manual port assignments or changes to service URLs.

Define services, commands, and connections in optional root `preview.yml`, or supply a spec directly through MCP or JSON stdin.
previewhost starts services in dependency order and waits for them to become ready.

When you replace a preview, its local URL stays the same.
New requests switch to the replacement services only after they pass readiness checks.

Control environments through the CLI, MCP tools, or an embedded Node.js library:

- [CLI](#use-the-cli): control previews from a terminal or script.
- [MCP](#use-mcp): give an agent tools to control previews.
- [Library](#embed-the-library): manage previews inside your Node.js application.
- [Optional agent skill](#use-the-agent-skill): give an agent instructions and recipe references for the CLI or MCP.

## Install

This alpha supports macOS and requires Node.js 22.23 or later.
Development servers require the macOS `ps` and `lsof` tools.
Stored secrets and managed databases require macOS 13 or later.
Linux and Windows remain unverified.

For CLI and MCP use, install the package globally:

```sh
npm install -g previewhost@alpha
```

The npm package requires no native build tools.

The npm package includes the maintained agent skill and its referenced guides under `dist/skills/previewhost`.
The public npm package does not require GitHub access.

## Create a frontend and backend

Create a directory for the two Node.js servers:

```sh
mkdir previewhost-demo
cd previewhost-demo
```

<details>
<summary>Create the two server files</summary>

Save this code as `backend.mjs`:

```js
import { createServer } from 'node:http';

createServer((request, response) => {
  if (request.url !== '/message') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ message: 'Hello from the backend.' }));
}).listen(Number(process.env.PORT), process.env.HOST);
```

Save this code as `frontend.mjs`:

```js
import { createServer } from 'node:http';

const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>previewhost demo</title>
<h1>Frontend + backend</h1>
<p id="message" role="status">Connecting…</p>
<script type="module">
  const message = document.querySelector('#message');
  try {
    const response = await fetch('/message');
    if (!response.ok) throw new Error('Backend unavailable');
    message.textContent = (await response.json()).message;
  } catch {
    message.textContent = 'Backend request failed.';
  }
</script>`;

createServer(async (request, response) => {
  if (request.url === '/message') {
    try {
      const reply = await fetch(new URL('/message', process.env.BACKEND_URL), {
        signal: AbortSignal.timeout(2000),
      });
      response.writeHead(reply.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(await reply.text());
    } catch {
      response.writeHead(503).end('Backend unavailable');
    }
  } else if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page);
  } else response.writeHead(404).end();
}).listen(Number(process.env.PORT), process.env.HOST);
```

</details>

Save this recipe as `preview.yml` beside those files:

```yaml
name: hello
type: environment
primary: frontend
services:
  backend:
    type: command
    cwd: .
    command: [node, backend.mjs]
    readyPath: /message
  frontend:
    type: command
    cwd: .
    command: [node, frontend.mjs]
    readyPath: /message
    env:
      BACKEND_URL: {service: backend}
```

`primary` selects the service at the environment URL.
`BACKEND_URL` receives the backend URL through the `service` binding.
previewhost starts the frontend after the backend is ready.
Both servers use the `PORT` and `HOST` values from previewhost.
Paths resolve relative to the recipe file.

### Install locally

For library imports or a project-specific CLI, install the package in `previewhost-demo`:

```sh
npm install previewhost@alpha
```

For a local CLI installation, use `./node_modules/.bin/previewhost` in place of `previewhost` in the commands below.

### Project owners

CLI automatically selects the current Git worktree root. MCP tools select the project supplied with each call.
Both interfaces find or start the same persistent project owner.
Outside Git, the current directory is the project. Use `--project /absolute/project` to choose it explicitly.
An owner survives client disconnection and ordinary inactivity. Explicit shutdown stops all its previews.

`--allow-exec` permits trusted commands, managed database operations, private secret setup, and explicit data deletion/recovery.
It runs code with your user permissions and provides no sandbox. It selects no secrets by itself.
Supply it in the current CLI invocation or MCP registration when cold startup needs that authority.
A living owner's permissions are reused; incompatible explicit launch options produce an error.

Manual `previewhost serve` remains available. To use it, pass `--endpoint` or `--token-file` explicitly to clients.
That mode connects only and never starts or reconfigures an owner.
See [connection configuration](docs/api.md#cli).

## Manage local previews

Run `previewhost dashboard` to open an optional local browser dashboard. Keep its
terminal running. Closing the dashboard leaves previews running.

Find previews by project/worktree path, open application links, inspect errors and
logs, cancel a startup or update, and stop a preview while keeping its database data.
**Start again** reruns a stopped preview's retained configuration against current
source. It does not reload `preview.yml`; its URL may change. Read-only configuration
shows variable names and secret references without their values.

Pending secret requests appear before application startup. **Open private form**
uses the existing private browser flow. Cancellation is terminal for that request;
if the agent ended its turn after saving, send it a short continuation message.

The dashboard discovers automatic project owners, not every project or saved database.
Cleanly shut-down owners, standalone `serve` instances, and embedded runtimes are not
listed. It never starts an owner, grants execution, or changes its permissions.
An older running owner may need an explicit upgrade before new controls are available.
Reloading the browser loses the private session; run `previewhost dashboard` again.

Create/edit/save configuration, delete retained data, and shut down owners through
the existing CLI/MCP or editor workflows. There is no dashboard configuration store.

## Use the CLI

From the demo directory, start the example:

```sh
previewhost start --allow-exec
```

The command loads root `preview.yml`, starts its owner, and waits for readiness. It returns `state: "ready"` and a `url`, or `starting` if the wait budget expires. Continue waiting for that attempt when needed.
Open that URL in a browser. The page shows **Frontend + backend**, then **Hello from the backend.**
The frontend forwards the browser's `/message` request to the backend.

Read the current status:

```sh
previewhost get hello
```

Stop the preview after use:

```sh
previewhost stop hello
```

When you finish, stop the daemon:

```sh
previewhost shutdown
```

## Use MCP

The MCP client starts the stdio adapter, which finds or starts the persistent project owner.
A connection can serve multiple chats. Each agent supplies its actual worktree as `project` on every tool call.

For Cursor, add one server to `~/.cursor/mcp.json`.
Replace `/absolute/repository` with an authorized repository root. Its registered Git worktrees need no additional registration:

```json
{
  "mcpServers": {
    "previewhost": {
      "command": "previewhost",
      "args": ["mcp", "--root", "/absolute/repository", "--allow-exec"]
    }
  }
}
```

Keep any existing server entries. Enable the server in your MCP client.
Repeat `--root` for other authorized repositories or source roots.
For managed databases, add `--docker-socket /absolute/docker.sock`. Each project gets separate private data storage.
Do not supply one shared `--data-dir` for independent project owners.
See [Cursor worktrees and global registration](docs/integrations.md#global-registration-and-cursor-worktrees) for host limits.
For other clients, see [client configurations](docs/integrations.md#codex).
If the client cannot find `previewhost`, use the [PATH troubleshooting steps](docs/troubleshooting.md#the-client-cannot-find-previewhost).

Ask the agent:

```text
Use previewhost to inspect and start this project. Prefer root preview.yml if it exists; otherwise construct a spec from the application.
Do not create configuration unless I ask you to save it.
Wait for the returned attempt to become ready, then give me its URL.
```

Open the URL in a browser. Verify that it shows **Hello from the backend.**
After use, ask the agent to stop the preview named `hello`.
A client disconnect leaves previews active.
For owner teardown, use `previewhost shutdown` or ask the agent to call `preview_shutdown`. This stops every preview on that owner.

## Embed the library

The library runs previews within your Node.js application and requires no separate daemon.
Use the [example files](#create-a-frontend-and-backend) and [local package installation](#install-locally).

Save this code as `preview.mjs` in `previewhost-demo`:

```js
import { createPreviewRuntime, loadPreviewSpec } from 'previewhost';

const spec = await loadPreviewSpec('preview.yml');
const runtime = await createPreviewRuntime({
  allowedRoots: [process.cwd()],
  authorize: ({ operation }) => operation === 'start',
});
try {
  const started = await runtime.start(spec);
  const result = await runtime.wait(spec.name, started.candidate.id);
  if (result.state !== 'ready') throw new Error(result.error?.message ?? result.state);
  console.log(result.url);
  console.log(await (await fetch(new URL('/message', result.url))).json());
} finally {
  await runtime.close();
}
```

Run the example:

```sh
node preview.mjs
```

The script prints the URL and backend response, then stops both servers and closes the runtime.
For a persistent preview, keep the runtime open until your application shuts down.
See the [library reference](docs/api.md#runtime-and-client) for configuration and lifecycle methods.

## Use the agent skill

The optional skill provides instructions and recipe references for agents that use the CLI or MCP.
The installed package contains `dist/skills/previewhost/SKILL.md` and its references. An agent can read them directly.
Skill discovery installation is optional; no install hook changes client configuration.
Use the skill with an installed [CLI](#install) or a configured [MCP client](#use-mcp).

With repository access, run this command from your application directory:

```sh
npx skills add RojhatToptamus/previewhost --skill previewhost --agent codex --yes
```

This command installs from the default branch, `main`, into `.agents/skills/previewhost` in the current project.
Repeat the command to update the skill and its references.

Start a Codex session in the intended project. The skill uses the installed CLI or configured MCP connection.
Ask:

```text
$previewhost Start the preview in preview.yml. Verify the backend message in the page, then stop the preview.
```

If the application has no recipe, the agent can supply a spec directly. Ask explicitly to save `preview.yml` when you want reusable configuration.
See [agent support](docs/integrations.md#agent-skill) for discovery and tested workflows.

## Preview an application

Install the application's dependencies before startup.
Use each application's existing start command in its recipe.
See [framework configuration](docs/integrations.md#framework-configuration) for Vite, Next.js, and Python examples.

For a frontend, two backends, PostgreSQL, and Redis, use the [full-stack walkthrough](examples/multi-repo/README.md).
It covers setup, service connections, browser verification, replacement, retained data, cleanup, and adaptation to multiple repositories.
For applications in Git worktrees, see the [worktree guide](docs/worktrees.md).
The [security guide](docs/security.md) covers execution, stored secrets, and data ownership.
The [troubleshooting guide](docs/troubleshooting.md) covers connection and cleanup errors.

## Handle secrets

Recipes can reference selected environment variables and secrets stored in macOS Keychain.
The private browser form first approves access to unselected names for this owner lifetime, then collects missing values.
The same exact name shares one Keychain value across worktrees that approve it; use a distinct name for a different value.
Keep their values out of recipes and agent chat.
previewhost does not automatically load `.env` files.
See the [secrets guide](docs/api.md#stored-secrets) for setup.

## Build from source

See [Build and install a tarball](CONTRIBUTING.md#build-and-install-a-tarball) for build requirements and source installation.

## License

previewhost uses the MIT license. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

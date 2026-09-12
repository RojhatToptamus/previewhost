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

Define the services, commands, and connections in `preview.yaml`.
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

The GitHub repository is private. Its linked guides and agent skill require repository access.
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

Save this recipe as `preview.yaml` beside those files:

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

### Start the daemon for CLI or MCP

From `previewhost-demo`, start the daemon in a terminal:

```sh
previewhost serve --root "$PWD" --allow-exec
```

`--allow-exec` permits these commands to run with your user permissions. It does not provide a sandbox.
Leave that terminal open. Use a second terminal in the same directory for client commands.
The daemon keeps previews active until you stop them or shut it down.

The examples use the default connection at `http://127.0.0.1:9400`.
The daemon prints its endpoint and token file path.
Clients need access to that token file and this Mac's loopback network.
For another port or token location, see [connection configuration](docs/api.md#cli).

## Use the CLI

With the [daemon active](#start-the-daemon-for-cli-or-mcp), start the example:

```sh
previewhost start --file preview.yaml
```

The command waits for readiness and returns JSON with `state: "ready"` and a `url`.
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

[Start the daemon](#start-the-daemon-for-cli-or-mcp) before you use preview tools.
The MCP client starts the stdio adapter. The adapter connects to the separate daemon.

For Cursor, add this server to the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "previewhost": {
      "command": "previewhost",
      "args": ["mcp"]
    }
  }
}
```

Keep any existing server entries. Enable the server in your MCP client.
For other clients, see [client configurations](docs/integrations.md#codex).
If the client cannot find `previewhost`, use the [PATH troubleshooting steps](docs/troubleshooting.md#the-client-cannot-find-previewhost).

Ask the agent:

```text
Call preview_list to check the connection.
Read preview.yaml in this project. Resolve each service cwd to an absolute path.
Use previewhost to inspect and start the preview.
Wait for the returned attempt to become ready, then give me its URL.
```

Open the URL in a browser. Verify that it shows **Hello from the backend.**
After use, ask the agent to stop the preview named `hello`.
A client disconnect leaves previews active.
To close the daemon, run `previewhost shutdown` in your terminal.

## Embed the library

The library runs previews within your Node.js application and requires no separate daemon.
Use the [example files](#create-a-frontend-and-backend) and [local package installation](#install-locally).

Save this code as `preview.mjs` in `previewhost-demo`:

```js
import { createPreviewRuntime, loadPreviewSpec } from 'previewhost';

const spec = await loadPreviewSpec('preview.yaml');
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
It does not install previewhost, start the daemon, or configure MCP.
Use the skill with an installed [CLI](#install) or a configured [MCP client](#use-mcp).

With repository access, run this command from your application directory:

```sh
npx skills add RojhatToptamus/previewhost --skill previewhost --agent codex --yes
```

This command installs from the default branch, `main`, into `.agents/skills/previewhost` in the current project.
Repeat the command to update the skill and its references.

With the [daemon active](#start-the-daemon-for-cli-or-mcp), start a new Codex session in that project.
Ask:

```text
$previewhost Start the preview in preview.yaml. Verify the backend message in the page, then stop the preview.
```

If the application has no recipe, ask the agent to create one from the project's commands.
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
Enter missing secrets through a private browser form.
Keep their values out of recipes and agent chat.
previewhost does not automatically load `.env` files.
See the [secrets guide](docs/api.md#stored-secrets) for setup.

## Build from source

See [Build and install a tarball](CONTRIBUTING.md#build-and-install-a-tarball) for build requirements and source installation.

## License

previewhost uses the MIT license. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

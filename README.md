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
previewhost runs setup jobs, then starts dependent services and waits for readiness.
Use explicit [migration and seed jobs](docs/jobs.md) instead of embedding setup in server commands.

When you replace a preview, its local URL stays the same.
New requests switch to the replacement services only after they pass readiness checks.

![Previewhost dashboard showing a frontend, API, PostgreSQL, Redis, and completed migration and seed jobs](./assets/dashboard.png)

Control environments through the CLI, MCP tools, or an embedded Node.js library:

- [CLI](docs/api.md#cli): control previews from a terminal or script.
- [MCP](docs/mcp.md): give an agent tools to control previews.
- [Library](docs/library.md): manage previews inside your Node.js application.
- [Dashboard](docs/dashboard.md): review worktrees, open apps, inspect failures, and stop or restart previews.
- [Optional agent skill](https://github.com/RojhatToptamus/previewhost/blob/main/skills/previewhost/SKILL.md): give an agent instructions and recipe references for the CLI or MCP.

## Get started

Previewhost supports macOS and requires Node.js 22.23 or later.
Stored secrets and managed databases require macOS 13 or later.
Linux and Windows remain unverified.

```sh
npm install -g previewhost
```

Follow [Your first preview](docs/first-preview.md) to run a frontend connected to a backend.
The example includes both server files and needs no Docker or application packages.
For a coding agent, follow [MCP setup](docs/mcp.md).

From a project with root `preview.yml`, the main commands are:

```sh
previewhost inspect
previewhost start --allow-exec
previewhost dashboard
```

`--allow-exec` permits trusted commands and managed database operations with your user permissions.
It provides no sandbox. The dashboard opens in your browser and needs its terminal to remain open.
Closing the dashboard does not stop previews.

## Documentation

Start with the [introduction](docs/introduction.md) for the workflow and product limits.

| Task | Guide |
| --- | --- |
| Install or update Previewhost | [Installation](docs/installation.md) |
| Run a complete example | [Your first preview](docs/first-preview.md) |
| Connect a coding agent | [MCP setup](docs/mcp.md) |
| Describe your application | [Configuration](docs/recipes.md) |
| Run services, migrations, and seeds | [Services and jobs](docs/jobs.md) |
| Connect or manage local data | [Databases](docs/databases.md) |
| Supply private credentials | [Secrets](docs/secrets.md) |
| Preview existing task checkouts | [Worktrees](docs/worktrees.md) |
| Inspect previews in the browser | [Dashboard](docs/dashboard.md) |
| Diagnose errors | [Troubleshooting](docs/troubleshooting.md) |
| Embed the runtime | [Node.js library](docs/library.md) |
| Look up fields and commands | [API and CLI reference](docs/api.md) |
| Check supported clients and frameworks | [Integrations](docs/integrations.md) |
| Understand permissions and recovery | [Security](docs/security.md) |

The [optional agent skill](https://github.com/RojhatToptamus/previewhost/blob/main/skills/previewhost/SKILL.md) ships in the npm package under
`dist/skills/previewhost`. Install it through your client's skill mechanism.
MCP registration and skill installation are separate operations.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for source builds and verification.
The [documentation website](https://github.com/RojhatToptamus/previewhost/blob/main/website/README.md) renders the same Markdown guides with
search, page outlines, and light and dark themes. Run `npm run dev:docs` after installing
repository dependencies. Its static build and screenshots are excluded from the npm package.

See [NOTICE](NOTICE) for attribution and [LICENSE](LICENSE) for the MIT license.

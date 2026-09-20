# Introduction

Previewhost runs local previews of your application and the services it needs. Control them from a terminal, a coding agent, or the browser dashboard.

## Why use Previewhost?

A frontend often needs an API, a database, and a few setup commands before you can try a change.
Running several copies means keeping their ports, service URLs, and data separate.
Previewhost manages those connections and starts each service after its dependencies are ready.

For example, you can preview a checkout change in one Git worktree while another worktree runs the current application.
Each worktree has its own preview owner, service ports, and managed database data.
You can also connect services from different repositories in one environment.

![Previewhost dashboard with three Storefront worktrees and their individual preview states](../assets/dashboard-worktrees.png)

The dashboard groups previews by their source directory. An update can need attention while the previous version still serves requests.

## What you can do

- Serve a directory of HTML and assets, start an HTTP application, or attach an existing local server.
- Connect frontends and APIs without assigning ports by hand.
- Run migrations and seed jobs before dependent services start.
- Give each environment managed PostgreSQL or Redis data, or connect an existing local database.
- Supply stored secrets through a private form instead of entering values in an agent chat.
- Inspect service status and logs, replace a running preview, or stop it while retaining its managed data.

![A running environment in the dashboard with frontend, API, databases, and completed setup jobs](../assets/dashboard.png)

An **environment** groups services under one preview name. Its **primary** service receives requests at the environment URL.
Each start or replacement creates an **attempt**, so you can distinguish a failed update from the version that still works.

## How the workflow fits together

1. Prepare your application dependencies in an existing checkout or worktree.
2. Describe its services in an optional root `preview.yml`, or let your agent supply a spec through MCP.
3. Start the preview. Previewhost runs setup jobs and waits for service readiness.
4. Open the returned URL and try the application.
5. Inspect logs or replace the preview after changes. Stop it when you finish.

Replacement keeps the local URL and switches new requests only after the new services are ready.
A failed replacement keeps the previous services available. It does not undo changes to source files or database writes.

Previewhost uses your existing source directories. It does not create Git worktrees, install project dependencies automatically, or provide an execution sandbox.
Application commands run with your user permissions. URLs stay local to your machine.

## Get started

[Install Previewhost](installation.md), then follow [Your first preview](first-preview.md) to run a frontend connected to an API.
The example needs Node.js and no application packages or databases.

If you work through a coding agent, use [MCP setup](mcp.md) to register Previewhost once across projects.
After a preview starts, [open the dashboard](dashboard.md) to inspect it.

Previewhost currently supports macOS and requires Node.js 22.23 or later. Linux and Windows remain unverified.
Managed databases and stored secrets require macOS 13 or later.

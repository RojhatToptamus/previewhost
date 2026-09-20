# Introduction

Previewhost runs local previews of your application and its services. Use a coding agent, the CLI, or the Node.js library to control them.

## Choose your starting point

- [MCP setup](mcp.md): register a coding client, approve project access, and ask your agent for a preview.
- [CLI quickstart](first-preview.md): run a frontend and API from your terminal, replace them, and stop them.
- [Node.js library](library.md): manage previews inside a program, from runtime creation through cleanup.

Previewhost supports macOS and requires Node.js 22.23 or later. Linux and Windows remain unverified.
Stored secrets and managed databases require macOS 13 or later.

## When to use Previewhost

A frontend often needs an API, a database, and setup commands before you can try a change.
Running several copies means keeping their ports, service URLs, and data separate.
Previewhost assigns ports, supplies connection URLs, and starts each service after its dependencies are ready.

For example, you can preview a checkout change in one Git worktree while another worktree runs the current application.
Each worktree has its own background process, called an **owner**, that manages its previews and managed database data.
You can also connect services from different repositories in one preview.

![Previewhost dashboard with three Storefront worktrees and their individual preview states](../assets/dashboard-worktrees.png)

A preview can serve static files, start an HTTP application, or connect to an existing local server.
An **environment** groups services and setup jobs under one preview name.
Its **primary** service receives requests at the environment URL.

## How a preview works

1. Prepare your application dependencies in an existing checkout or worktree.
2. Describe its services in [preview.yml](recipes.md), or supply a spec through MCP or the library.
3. Start the preview. Previewhost runs setup jobs and waits for service readiness.
4. Open the returned URL and try the application.
5. Read logs or replace the preview after changes. When you finish, stop the preview.

The configuration connects services through named bindings. For example, an API can receive a managed PostgreSQL URL without a fixed port or password in the file.
[Secrets](secrets.md) use stored references, with private browser entry for missing values.

![A running environment with frontend, API, databases, and completed setup jobs](../assets/dashboard.png)

The [dashboard](dashboard.md) shows service status and logs across projects that use CLI or MCP owners.
Each start or replacement creates an **attempt**, so a failed update has separate status from the version that still works.

Replacement keeps the local URL and switches new requests only after the new services are ready.
A failed replacement keeps the previous services available. It does not undo source changes or database writes.
Stop ends owned processes and retains managed data for the next start.

## What Previewhost leaves to you

Previewhost uses existing source directories. It does not create Git worktrees or install project dependencies automatically.
You choose the commands, readiness routes, and database setup that your application needs.
The [preview.yml guide](recipes.md) explains these choices.

Application commands run with your user permissions, without a sandbox. Preview URLs stay local to your machine.

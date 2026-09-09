# Create or update a preview recipe

A recipe is one JSON or YAML file in the existing `PreviewSpec` format.
Use the [API reference](api.md#specs) for fields and limits.
This guide covers the decisions needed to adapt that format to a project.

## Inspect the project

Read project instructions before choosing commands or changing files.
Search for existing recipes and previewhost calls in scripts and documentation.
Reuse a suitable recipe. Preserve its name when continuing a preview with retained data.

Inspect package scripts, lockfiles, framework configuration, server entrypoints, and source directories.
For each service, identify the working directory, start command, required dependencies, listener settings, and readiness route.
Read configuration variable names without displaying secret values.
Determine which commands load existing environment files and which values require explicit bindings.

Use current task directories and worktrees supplied by the coding host.
The coding host owns dependency installation, generation, builds, migrations, and source removal.
Do not clone or reset source merely to create a preview.
For shared output or overlapping processes, read the [worktree guide](worktrees.md#prepare-and-start).

## Choose the smallest spec

| Project requirement | Spec and maintained reference |
| --- | --- |
| Serve existing HTML/assets or prepared build output | `static`: [static quick start](#serve-a-static-page) and [static fields](api.md#specs). |
| Start one HTTP application | `command`: [command recipe](../examples/command.json) and [framework configuration](integrations.md#framework-configuration). |
| Expose an HTTP server already managed elsewhere | `attach`: [attachment fields and example](api.md#specs). Verify the existing listener first. |
| Start connected HTTP services or use databases | `environment`: [bindings and service fields](api.md#environment-specs) and [frontend, backends, PostgreSQL, and Redis walkthrough](../examples/multi-repo/README.md). |
| Preview existing task worktrees | Use the appropriate spec with the host's source paths. See the [worktree guide](worktrees.md) and [maintained recipe program](../examples/multi-repo/worktrees.mjs). |

Use `spa: true` only if the application needs an index fallback for client routes.
Use a command preview when the task needs a development server, SSR, HMR, or server behavior.
Keep an existing server attached when another owner manages its lifecycle.
An environment groups services that need one preview lifecycle. Its primary service must serve HTTP.

For databases, first determine whether the project expects existing data or a new isolated development database.
If that decision is unknown, ask before creating or selecting a database.
Owned PostgreSQL and Redis require the [database prerequisites](../examples/multi-repo/README.md#install-the-dependencies).
External database entries accept only the supported local connection forms described in the API reference.
Do not substitute production credentials or infer permission to migrate, reset, or delete data.

## Serve a static page

Use the [global CLI installation and runtime requirements](../README.md#install).
This example needs no command execution permission or Docker.
Create a sample page:

```sh
mkdir previewhost-static
cd previewhost-static
mkdir site
printf '<h1>Hello from previewhost.</h1>\n' > site/index.html
```

Save this recipe as `preview.json` in that directory:

```json
{
  "name": "site",
  "type": "static",
  "directory": "./site"
}
```

After any previous demo daemon stops, start this daemon in a terminal:

```sh
previewhost serve --root "$PWD"
```

In a second terminal in the same directory, start the preview:

```sh
previewhost start --file preview.json
```

Open the returned `url`. The page shows **Hello from previewhost.**
After use, stop the preview and daemon:

```sh
previewhost stop site
previewhost shutdown
```

## Verify commands and bindings

Use the project's verified start command and installed package manager.
Read the script or command help before adding framework flags.
Commands are argv arrays without shell expansion.
Put environment assignments in `env`. Use existing project scripts for required command composition.
Keep preparation outside the preview unless it is an intentional part of HTTP startup within the readiness deadline.

Make the server honor injected `PORT` and `HOST`, or verified loopback/port arguments with `{port}`.
Do not override `PORT`, `HOST`, or `PREVIEW_URL` in `env`.
Do not invent a fixed port for a managed command.
For attachment, verify the actual existing HTTP port instead.
For framework-specific host checks or browser origins, use the [framework guide](integrations.md#framework-configuration).

Choose a real readiness route that returns HTTP 200–399 when the service is usable.
Readiness checks headers once during startup. They do not follow redirects or inspect response bodies.
Verify the returned page separately after readiness.
Choose a supported timeout based on the application's startup behavior, not repeated blind increases.

Use literals only for non-secret configuration.
Use `{fromEnv: NAME}` for a value selected by the daemon owner.
Use `{secret: ID}` for a selected stored credential and the [private-entry workflow](api.md#stored-secrets) for missing values.
previewhost does not automatically load `.env` files or inherit arbitrary host values.

For inter-service connections, select bindings from the [environment reference](api.md#environment-specs).
`{service: NAME}` waits for the referenced service and supplies its candidate connection URL.
Browser/public URL bindings supply stable routes without readiness dependencies.
Avoid service-reference cycles. Verify which URLs the browser and native services actually need.

## Resolve unknowns and validate

Infer mechanical details from project evidence, then verify them.
Ask for missing product choices that affect the result: target application, database/data ownership, or intended public-facing service.
Ask the owner to resolve missing permissions, selected inputs, and secret IDs.
Do not ask for secret values in chat.

Save the recipe beside the project's relevant configuration.
File-based source paths resolve relative to that recipe, not the terminal directory.
For MCP or direct library calls, resolve source paths to absolute paths first.
Do not maintain a second schema or change working application configuration to fit an unverified recipe.

Inspect the recipe through the selected daemon before startup.
Then start it within the task's authorization and wait for the exact attempt.
Fetch the resulting URL and verify expected application content or behavior.
For connected services, verify a representative request across the required services.
Use logs to diagnose failure, then correct the underlying command, binding, or prerequisite.
After a timeout or disconnection, inspect current status before retrying a mutation.

Report the recipe path, URL check, and any missing prerequisites or unverified behavior.
When cleanup is requested, stop the preview and verify cleanup completes.
Preserve retained data and externally owned services.

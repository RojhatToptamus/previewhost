# Write preview.yaml

Describe your application's commands, readiness checks, and service connections in one file. The CLI and MCP can reuse it for each preview.

## Choose an input

Save `preview.yaml` at the project root for the default CLI and MCP workflow.
If it is absent, Previewhost reads `preview.yml`. If both exist, default lookup reports an error.
Select a file explicitly or keep one default configuration.
The file is optional: MCP and library calls also accept a spec object, and the CLI accepts JSON stdin.

An explicit `--file` selection, MCP `file`, or direct spec bypasses default lookup, including a conflict between the two filenames. Previewhost does not merge configurations or ignore an invalid root file.
Source paths in a file resolve relative to that file. Direct MCP and library specs require absolute paths.
JSON stdin paths resolve from the current directory.

Use one YAML 1.2 document. Duplicate keys, aliases, tags, merge keys, and unknown fields are errors.
For the complete schema and limits, see the [spec reference](api.md#specs).

## Choose a preview type

| What you need | Type | Required source |
| --- | --- | --- |
| Serve HTML, assets, or build output | `static` | A `directory` with prepared files |
| Start one HTTP application | `command` | A `cwd` and a `command` array |
| Use an HTTP server that already runs | `attach` | Its local HTTP `url` with an explicit port |
| Connect services, jobs, or databases | `environment` | A `services` map and a primary HTTP service |

Use `command` for a development server, server-side rendering, or hot reload.
An attached server stays under its original owner's control after preview stop.
Background workers without HTTP readiness are not a supported service type.
Use [setup jobs](jobs.md) for commands that finish, such as migrations.

## Serve a static page

For a project with prepared files in `site`, save this as root `preview.yaml`:

```yaml
name: site
type: static
directory: ./site
```

`directory` must already exist. Previewhost serves its `index.html` for directory requests.
If the application uses client-side routes, add `spa: true` to serve the root index for missing extensionless paths.
Missing assets still return 404.

Start this configuration with `previewhost start`. Static previews need no execution permission.
Open the returned `url` to check the page. When you finish, run `previewhost stop site`.

## Start an HTTP application

Read the project's start script before you choose commands or flags.
Install its dependencies before startup, or declare an intentional setup job.
For a Node.js server that reads `PORT` and `HOST`, the configuration can be:

```yaml
name: app
type: command
cwd: .
command: [node, server.mjs]
readyPath: /health
timeoutMs: 30000
```

This example assumes that `server.mjs` exists and serves `/health`.
Change the command and readiness path to match your application.

Commands use argument arrays without a shell. Put environment variables in `env`, not in shell assignments inside `command`.
If startup needs several shell commands, use a project script.

Previewhost supplies `PORT`, `HOST` (`127.0.0.1`), and `PREVIEW_URL`. These names are reserved and cannot appear in `env`.
If the server ignores `PORT`, pass its port flag with `"{port}"` as the value.
The server must use the assigned port and bind to loopback. Disable framework behavior that chooses another port automatically.
See [framework configuration](integrations.md#framework-configuration) for Vite, Next.js, and Python examples.

Readiness requires HTTP 200–399 headers from `readyPath`, which defaults to `/`.
The check runs once at startup. It does not follow redirects or read the body.
Choose a route that checks what the application needs, such as access to its database tables.

## Connect services

Use an environment when several services belong to one preview.
This example assumes prepared `api` and `web` directories with Node.js servers that read `PORT` and `HOST`:

```yaml
name: shop
type: environment
primary: web
services:
  api:
    type: command
    cwd: ./api
    command: [node, server.mjs]
    readyPath: /health
  web:
    type: command
    cwd: ./web
    command: [node, server.mjs]
    env:
      API_URL: {service: api}
```

The `primary` field selects the service at the environment URL.
The `service` binding supplies the API's connection URL and waits for API readiness before the web service starts.
The web server must read `API_URL` for its backend requests. Previewhost does not rewrite application code.
For a runnable example with both server files, use [First preview with the CLI](first-preview.md).

| Connection | Binding | Effect |
| --- | --- | --- |
| A server calls another service | `{service: api}` | Supplies a local connection URL and adds a readiness dependency. |
| Browser code calls an HTTP service | `{browserUrl: api}` | Supplies a stable `.localhost` alias without a readiness dependency. |
| A service needs the primary page's numeric origin | `{publicUrl: web}` | Supplies the environment URL without a readiness dependency. |

Public URLs can reach the previous application during replacement.
For browser requests across origins, configure the receiving application's CORS policy.
Native services must use `service` bindings: native DNS clients do not necessarily resolve browser aliases.

## Supply configuration and credentials

Use literal values for non-secret configuration:

```yaml
env:
  NODE_ENV: development
  API_TOKEN: {secret: "shop/dev/api-token"}
```

The `secret` binding names a stored Keychain value. Enter missing values through [private secret setup](secrets.md).
The same exact reference shares one value across projects that approve it.
Use a project-specific reference for credentials that must stay separate.

`{fromEnv: NAME}` reads a value selected when the owner starts, through `--env NAME` or the library's `inputs`.
Previewhost does not load `.env` files or pass arbitrary host values to commands. Your application can load its own environment files.

For a database, choose [managed or external data](databases.md) before you add the service.
If the application needs tables or initial records, add [migration and seed jobs](jobs.md).

## Check and apply the file

From the project directory, inspect the configuration:

```sh
previewhost inspect
```

Inspection checks the spec and source access. It does not run commands or prove that the application works.
For trusted application commands, start with execution permission:

```sh
previewhost start --allow-exec
```

Open the returned URL and check an application request across the connected services.
If startup fails, read the attempt's logs before changing the configuration.
See [startup troubleshooting](troubleshooting.md#startup-fails-or-times-out).

After editing the file, apply it to a running preview with:

```sh
previewhost replace
```

The file is not watched. Replacement reads it again and keeps the current URL after successful startup.
For a stopped preview, use `start`. Keep the same preview name to reuse its managed data.

## Save a configuration from MCP

Ask your agent to save the spec after it works. `preview_save_config` creates root `preview.yaml` from that spec.
The dashboard also offers **Save as preview.yaml** for a retained attempt.

Both operations preserve references without resolving secret values, ports, or service URLs.
Paths inside the project become relative. External source paths remain absolute and are not portable to another machine.
Saving does not change the running preview. It fails if either `preview.yaml` or `preview.yml` already exists, including a directory or symlink.
To change an existing file, edit it and inspect it again.

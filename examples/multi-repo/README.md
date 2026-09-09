# Preview a frontend, backends, PostgreSQL, and Redis

This example is a shared notes application.
The frontend sends notes to an API, which writes to PostgreSQL and Redis.
A separate reporting service reads the same data and verifies API readiness.
One preview environment starts these five services and gives the frontend a local URL.

## Files and services

```text
examples/multi-repo/
  environment.yaml       Preview recipe
  package.json           Backend dependencies and optional npm commands
  api/server.mjs         Note API and table creation
  reporting/server.mjs   Database count and cached note
  frontend/
    server.mjs           Page, configuration, and readiness route
    index.html
    app.js
    style.css
  worktrees.mjs          Recipe helper for existing task directories
```

The three application directories can also live in separate repositories or worktrees.
They communicate through HTTP and database connections, without imports between their source files.

## Install the dependencies

Use the [global CLI installation and runtime requirements](../../README.md#install).
Managed databases also require macOS 13 or later, local Docker Engine, and the images below.
The npm package includes the compiled Keychain helper. This walkthrough requires no source build.

The npm package does not include this example.
With access to the private GitHub repository, obtain its source:

```sh
git clone https://github.com/RojhatToptamus/previewhost.git
cd previewhost/examples/multi-repo
npm install
```

`npm install` installs `pg` and `redis` for the two backends.
The frontend uses only Node.js built-ins and browser files.
All remaining commands use this example directory unless stated otherwise.

Start your local Docker Engine. If the database images are absent, download them:

```sh
docker pull postgres:17-alpine
docker pull redis:7-alpine
```

previewhost does not install application packages or download Docker images.
Its default Engine socket is `~/.docker/run/docker.sock`.
For another local Engine socket, add `--docker-socket /absolute/local/docker.sock` to the daemon command below.
Replace that path with your local Unix socket. Docker CLI context selection does not configure previewhost.

## Read the recipe

The checkout contains [environment.yaml](environment.yaml) with this complete recipe:

```yaml
name: shared-notes
type: environment
primary: frontend
timeoutMs: 60000
services:
  database:
    type: postgres
  cache:
    type: redis
  api:
    type: command
    cwd: ./api
    command: [node, server.mjs]
    readyPath: /ready
    env:
      DATABASE_URL: { service: database }
      REDIS_URL: { service: cache }
      FRONTEND_ORIGIN: { browserUrl: frontend }
      FRONTEND_NUMERIC_ORIGIN: { publicUrl: frontend }
      REVISION: v1
  reporting:
    type: command
    cwd: ./reporting
    command: [node, server.mjs]
    readyPath: /ready
    env:
      DATABASE_URL: { service: database }
      REDIS_URL: { service: cache }
      API_URL: { service: api }
      FRONTEND_ORIGIN: { browserUrl: frontend }
      FRONTEND_NUMERIC_ORIGIN: { publicUrl: frontend }
      REVISION: v1
  frontend:
    type: command
    cwd: ./frontend
    command: [node, server.mjs]
    readyPath: /ready
    env:
      API_URL: { service: api }
      REPORTING_URL: { service: reporting }
      PUBLIC_API_URL: { browserUrl: api }
      PUBLIC_REPORTING_URL: { browserUrl: reporting }
      REVISION: v1
```

`type: environment` groups the services under `shared-notes`.
`primary: frontend` selects the service for the numeric preview URL.
Each `cwd` resolves relative to this recipe. Each `command` runs as an argument list without a shell.
previewhost supplies `PORT` and `HOST`, which these servers use for their listeners.

The environment has a 60-second startup deadline.
The CLI waits at most 30 seconds per request. A CLI timeout can leave startup active.

### How the services connect

| Binding | Connection and startup rule |
| --- | --- |
| `DATABASE_URL: {service: database}` | Gives each backend the PostgreSQL connection URL and waits for that database. |
| `REDIS_URL: {service: cache}` | Gives each backend the Redis connection URL and waits for that cache. |
| `API_URL: {service: api}` | Gives reporting and frontend the candidate API URL and waits for API readiness. |
| `REPORTING_URL: {service: reporting}` | Gives the frontend the candidate reporting URL and waits for reporting readiness. |
| `{browserUrl: api}` and `{browserUrl: reporting}` | Give browser JavaScript the public backend routes. They add no startup dependency. |
| `{browserUrl: frontend}` and `{publicUrl: frontend}` | Give the backends the allowed browser origins for CORS. They add no startup dependency. |

The database and cache become ready before the API starts.
Reporting waits for the API and both databases. The frontend waits for the API and reporting.
These dependencies come from `service` bindings, not the order of entries in YAML.

In the API, `/ready` verifies PostgreSQL and Redis connectivity.
Reporting also verifies API readiness. Frontend readiness requires successful responses from both backends.
Each route returns a successful HTTP response only while its dependencies respond.
previewhost verifies these routes during startup. They are not continuous database health checks.

The browser gets backend addresses from the frontend's `/config` response.
It sends note requests to `shared-notes--api.localhost` and report requests to `shared-notes--reporting.localhost`.
These aliases use the preview port and route to separate services.
The backends accept the frontend's numeric origin and browser alias through their explicit CORS checks.
Native requests use numeric loopback URLs from `service` bindings, because native DNS clients do not necessarily resolve browser aliases.

### Who prepares the application

You or the coding host installs dependencies before preview startup.
For this example, the API creates its table with `CREATE TABLE IF NOT EXISTS` before it starts its HTTP listener.
The API repeats that statement on replacement and restart. Existing rows remain.
There is no seed script. The browser action below creates the example data.

For another application, use its existing migration and seed commands.
Run them through your terminal or coding host with the intended development database credentials.
If they need previewhost-managed credentials, the application's startup command can run preparation before its HTTP server starts.
That preparation must finish within the startup deadline and safely handle replacement or retry.
previewhost has no separate job, migration, seed, or scenario system.
Replacement does not undo database changes made by application code.

## Start the environment

After the README demo daemon stops, start this daemon in a terminal:

```sh
previewhost serve --root "$PWD" --allow-exec \
  --data-dir .local/data --token-file .local/token
```

Leave this terminal open.
`--root` permits these application directories. `--allow-exec` permits application commands and managed database operations with your user permissions.
The commands do not run in an OS sandbox.
`--data-dir` retains this environment's database records. Generated database credentials stay in macOS Keychain.
`--token-file` selects this daemon's control token. Keep its value private.

In a second terminal in the same example directory, inspect the recipe:

```sh
previewhost inspect --file environment.yaml --token-file .local/token
```

Inspection verifies the recipe and source paths. It does not start services or prove that the databases are healthy.
Start the environment:

```sh
previewhost start --file environment.yaml --token-file .local/token
```

The result contains `state: "ready"`, a `url`, and the five service states.
Read current status:

```sh
previewhost get shared-notes --token-file .local/token
```

If another daemon occupies control port 9400, add `--port 9401` to this daemon's command.
Add `--endpoint http://127.0.0.1:9401` to every client command for that daemon.
previewhost allocates the application and database ports separately.

## Verify a browser request across the services

Open the returned numeric `url` in a browser.
The page shows **Shared notes** and the labels **Web: v1**, **API: v1**, and **Reporting: v1**.
A new environment has no notes.

1. Enter `My full-stack preview works` in **Note**.
2. Select **Save note**.
3. Verify that the text appears under **Recent notes**.
4. Verify that **Notes in PostgreSQL** increases by one.
5. Verify that **Latest note in Redis** shows the same text.

**Saved in PostgreSQL and shared through Redis.** shows that the API accepted the write and updated the cache.
The report shows that the separate reporting service can read both resources.
A cache failure can leave an accepted PostgreSQL write. The page reports that partial result.

Readiness alone does not prove that the browser's API calls work.
The browser action also exercises public URL bindings and CORS.

## Diagnose startup and request failures

Read the service states and current logs:

```sh
previewhost get shared-notes --token-file .local/token
previewhost logs shared-notes --token-file .local/token
```

Logs include service prefixes such as `[api]` and `[reporting]`.
For a failed retained attempt, pass its exact ID after `shared-notes` in the logs command.

| Symptom | What to verify |
| --- | --- |
| `EXECUTION_DENIED` | The daemon needs `--allow-exec`. |
| Docker connection or image error | Verify the local socket, running Engine, and both cached images. |
| A command exits before readiness | Verify its `cwd`, installed packages, and start command. |
| API or reporting returns 503 | Verify database service states and their logs, then select **Refresh**. |
| The page loads but backend requests fail | Verify the browser aliases, public URL bindings, and allowed frontend origins. |
| CLI startup times out | Read `get` before another mutation. Startup can still be active. |

To continue a timed-out wait, replace `ATTEMPT_ID` with the candidate ID from status:

```sh
previewhost wait shared-notes ATTEMPT_ID --token-file .local/token
```

A successful wait request can still report a failed attempt. Read its `state` and error.
For other failures, use [troubleshooting](../../docs/troubleshooting.md).

## Replace the application and retain data

Change the three `REVISION` values in `environment.yaml` from `v1` to `v2`.
Run:

```sh
previewhost replace --file environment.yaml --token-file .local/token
```

Reload the same browser URL after replacement completes.
All three service labels show `v2`. The existing note, PostgreSQL count, and Redis value remain.
New notes record `v2`. Existing notes keep the revision from their original write.

Replacement starts candidate applications against the retained databases.
Public routes switch together after all candidate services become ready.
If candidate startup fails, the old application remains available.
Replacement cannot undo source edits, database writes, or schema changes.

## Stop, restart, and remove data

Stop the environment:

```sh
previewhost stop shared-notes --token-file .local/token
```

This stops the application processes and owned database containers.
The preview URL closes. Database volumes and credentials remain for another start.
To verify retention, start again and open the new returned URL:

```sh
previewhost start --file environment.yaml --token-file .local/token
```

The saved note and report remain. Stop/start can change the preview URL.
A daemon restart also retains the databases when you use the same data directory and environment name.

When you no longer need this example's stored notes, stop it and explicitly remove its data:

```sh
previewhost stop shared-notes --token-file .local/token
previewhost delete-data shared-notes --token-file .local/token
previewhost shutdown --token-file .local/token
```

`delete-data` permanently removes this stopped environment's owned database data and credentials.
It leaves application source files intact. Shutdown closes the daemon.
If cleanup fails, resolve the reported error before you remove `.local/data` or the source directory.

The table name `previewd_demo_notes` and cache key `previewd:demo:latest-note` preserve earlier example data.
To continue an earlier example's environment, keep its data directory.
See [retained storage identifiers](../../docs/security.md#retained-storage-identifiers).

## Adapt the recipe to existing repositories

Set each service's `cwd` to its existing repository or worktree.
Use its actual start command, dependencies, environment variables, and readiness route.
Add each source root to the daemon with repeated `--root` arguments.
Keep `service` bindings for native connections and browser URL bindings for browser calls.

For this shared-notes layout, the [worktree guide](../../docs/worktrees.md#shared-notes-task-recipe) shows the existing recipe helper.
That helper requires a source build for its library import.
For a different application, adapt YAML directly through the [recipe guide](../../docs/recipes.md).
The [API reference](../../docs/api.md#environment-specs) lists all supported fields.

Keep the data directory outside task directories that the coding host can remove.
Use one environment name for continuing work. Use distinct names for separate managed databases.
Stop every preview that uses a source directory before the host removes that directory.

## Optional environment inputs and stored secrets

The base recipe needs no user-supplied credentials.
Its `REVISION` values are literals. Managed database bindings supply generated credentials to the backends.
previewhost does not automatically load `.env` files or pass arbitrary terminal variables to commands.
Application commands can load their own environment files.

For a non-secret owner input, use `{fromEnv: NAME}` in the service's `env`.
Export `NAME` in the daemon's terminal and select it with `serve --env NAME`.
The daemon reads that value at startup. A change requires a daemon restart to take effect.

For a stored credential, use `{secret: ID}` in the service's `env` or an external database's `url`.
Select that exact ID with `serve --secret ID`.
`--allow-exec` does not select stored secrets.
Use `previewhost secrets set ID` for hidden terminal entry, or the [private setup flow](../../docs/api.md#stored-secrets).
Do not place credential values in the recipe or agent messages.
Saving a missing secret starts no application. Retry startup after setup completes.

## Use existing local databases

An existing local stack, including a separately managed Compose stack, can own PostgreSQL and Redis.
previewhost connects to those databases but does not start or stop that stack.
This variant still runs the frontend and backends through previewhost.
Use development databases that permit the API to create its example table and write notes.

If the previous daemon is still active, stop its environment and shut down the daemon:

```sh
previewhost stop shared-notes --token-file .local/token
previewhost shutdown --token-file .local/token
```

Stop preserves managed data unless you explicitly removed it in the previous section.
Copy the recipe:

```sh
cp environment.yaml external.yaml
```

In `external.yaml`, change the name to `shared-notes-external`.
Replace only the `database` and `cache` entries under `services` with these definitions:

```yaml
database:
  type: external-postgres
  url: {fromEnv: DEMO_DATABASE_URL}
cache:
  type: external-redis
  url: {fromEnv: DEMO_REDIS_URL}
```

Keep the application services and their `service` bindings.
In the daemon's terminal, export `DEMO_DATABASE_URL` and `DEMO_REDIS_URL` with your local development connection URLs.
Use these formats with your own credentials, ports, and database names:

```text
postgresql://USER:PASSWORD@127.0.0.1:PORT/DATABASE
redis://default:PASSWORD@127.0.0.1:PORT/0
```

Replace every uppercase placeholder. Percent-encode special characters in credentials.
Remote hosts, TLS, and Unix database sockets are unsupported here.
For stored URLs, use `{secret: ID}` instead of `{fromEnv: NAME}` and select the ID with `--secret`.

Start the daemon with the two selected environment values:

```sh
previewhost serve --root "$PWD" --allow-exec --token-file .local/token \
  --env DEMO_DATABASE_URL --env DEMO_REDIS_URL
```

In the second terminal, inspect and start the edited recipe:

```sh
previewhost inspect --file external.yaml --token-file .local/token
previewhost start --file external.yaml --token-file .local/token
previewhost get shared-notes-external --token-file .local/token
```

Repeat the note entry and report checks at the returned URL.
The labels use the `REVISION` values from `external.yaml`.
The same application now writes to the externally owned local databases.
After use, stop the applications and daemon:

```sh
previewhost stop shared-notes-external --token-file .local/token
previewhost shutdown --token-file .local/token
```

The database owner remains responsible for those databases and the example's notes.
previewhost does not remove external tables, cache keys, containers, or volumes.

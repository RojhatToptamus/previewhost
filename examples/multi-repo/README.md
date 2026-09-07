# Shared notes: a multi-repository example

This example runs three Node HTTP services from separate working directories.
The API writes notes to PostgreSQL and updates Redis.
The reporting service reads the same database and cache.
The browser calls both backends through their readable URLs.

| Directory | HTTP routes | Dependencies |
| --- | --- | --- |
| `api` | `/notes`, `/ready` | PostgreSQL and Redis |
| `reporting` | `/summary`, `/ready` | API, PostgreSQL, and Redis |
| `frontend` | `/`, `/ready` | API and reporting |

Each `cwd` in [environment.yaml](environment.yaml) can point to a separate repository or worktree.
The paths resolve relative to that file.
The services do not import source files from each other.
This example installs their packages together in its parent directory.

## Install the dependencies

Requirements: macOS, Node.js 22.23 or later, the installed previewd tarball, and a local Docker Engine.

From the directory where you installed previewd, run:

```sh
cd node_modules/previewd/examples/multi-repo
npm install
```

If the database images are absent, install them explicitly:

```sh
docker pull postgres:17-alpine
docker pull redis:7-alpine
```

previewd does not install Node packages or pull images during startup.

## Run the example

In the first terminal, run:

```sh
npm run serve
```

The owner stays in the foreground.
It permits execution of the example code and stores private data records under `.local/data`.
Its token file is `.local/token`.

In a second terminal, open the same example directory and run:

```sh
npm start
npm run status
```

Open the returned numeric URL or the frontend `browserUrl` from the status.
Write a note and select **Save note**.
The note list shows the API response.
The report shows the PostgreSQL count and the Redis value from the separate reporting service.

Both backends permit requests from the frontend's numeric and readable origins.
Internal service references use numeric candidate addresses.
The public browser references do not add readiness dependencies.
Each `/ready` route checks its dependencies before it returns success.

If another owner uses port 9400, select a different control port:

```sh
npm run serve -- --port 9401
npm start -- --endpoint http://127.0.0.1:9401
```

Use that `--endpoint` argument with the other client scripts too.
The application URLs use automatically allocated ports.

## Replace the application

Change the three `REVISION` values in `environment.yaml` from `v1` to `v2`.
Then run:

```sh
npm run replace
```

Reload the browser after the replacement completes.
All three service labels show `v2`, and the existing notes remain.
The application URLs stay the same during replacement.
A failed candidate leaves the active application available.

The API creates `previewd_demo_notes` with `CREATE TABLE IF NOT EXISTS` during its own startup.
previewd does not run a migration engine.
Application writes and schema changes are not part of route rollback.
PostgreSQL owns the notes.
A cache error after a successful write returns the saved note with `cacheUpdated: false`.

## Stop and remove data

To stop the application and its database containers, run:

```sh
npm run stop
```

PostgreSQL and Redis data remain available for the next start.
An owner restart also preserves this data.

The next command permanently removes this environment's PostgreSQL and Redis data.
After the environment stops, run:

```sh
npm run delete-data
```

To close the owner, run:

```sh
npm run shutdown
```

## Use databases owned by another stack

An existing Compose stack can own the PostgreSQL and Redis services.
Its database ports must publish on numeric `127.0.0.1` endpoints.
If you ran the owned-database example, stop it and close its owner first:

```sh
npm run stop
npm run shutdown
```

Change the environment name in `environment.yaml` to `shared-notes-external`.
This keeps the original environment's retained data separate from the external bindings.
Replace the two resource definitions in `environment.yaml`:

```yaml
database:
  type: external-postgres
  url: { fromEnv: DEMO_DATABASE_URL }
cache:
  type: external-redis
  url: { fromEnv: DEMO_REDIS_URL }
```

Set both connection URLs in the owner terminal.
Use complete local URLs with explicit ports, credentials, and database paths.
Then start the owner with those selected inputs:

```sh
npm run serve -- --env DEMO_DATABASE_URL --env DEMO_REDIS_URL
```

Run `npm start` from a second terminal.
The status and stop scripts use the original environment name.
For this variant, select its name explicitly:

```sh
npm exec -- previewd get shared-notes-external --token-file .local/token
npm exec -- previewd stop shared-notes-external --token-file .local/token
```

The consumers keep their existing service bindings.
previewd checks the external connections but does not stop them or remove their data.
The API still creates its demo table in the selected PostgreSQL database.
Use a database intended for this example.

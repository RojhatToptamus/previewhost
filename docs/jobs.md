# Services and jobs

An environment starts related services and setup jobs in dependency order.

## Define services and jobs

Use `type: command` for an HTTP server that stays running. Use `static` for files or `attach` for a server managed elsewhere.
Managed and external databases can also be environment services. See [Databases](databases.md).
Each environment needs a primary HTTP service. Background workers without HTTP readiness are not a supported service type.

Use a finite `type: job` node for migrations, dependency installation, or seeding.
Keep the application start command focused on running its server.

This example assumes a Python API with Alembic migrations, a seed script, and a Next.js frontend.
Install their dependencies before startup. Managed PostgreSQL needs the [database prerequisites](databases.md#prepare-docker).

```yaml
name: shop
type: environment
primary: web
timeoutMs: 120000
services:
  db: {type: postgres}
  migrate:
    type: job
    cwd: ./api
    command: [python, -m, alembic, upgrade, head]
    env:
      DATABASE_URL: {service: db}
  seed:
    type: job
    run: once
    cwd: ./api
    command: [python, seed.py]
    dependsOn: [migrate]
    env:
      DATABASE_URL: {service: db}
  api:
    type: command
    cwd: ./api
    command: [python, -m, uvicorn, app:app, --host, 127.0.0.1, --port, "{port}"]
    dependsOn: [seed]
    readyPath: /health
    env:
      DATABASE_URL: {service: db}
      ALLOWED_ORIGIN: {browserUrl: web}
      ALLOWED_NUMERIC_ORIGIN: {publicUrl: web}
  web:
    type: command
    cwd: ./web
    command: [npm, run, dev, --, --hostname, 127.0.0.1, --port, "{port}"]
    env:
      API_URL: {service: api}
      NEXT_PUBLIC_API_URL: {browserUrl: api}
```

Adapt module names, commands, and environment keys to the application.
The API must explicitly accept the supplied CORS origins. Previewhost does not change its CORS policy.
To create tables without seed data, omit `seed` and set `api.dependsOn` to `[migrate]`.
YAML is optional. The same fields work in direct specs, with absolute source paths.

`dependsOn` waits for successful job completion or service readiness.
A `{service: db}` binding also adds a dependency and supplies its connection URL.
Jobs have no connection URL and receive no `PORT` or `HOST`.
Use `dependsOn`, not an environment binding, to wait for a job.
Public URL bindings add no dependency and can reach the old application during replacement.

## When jobs run

| Operation | `run: always` (default) | `run: once` |
| --- | --- | --- |
| First start | Runs | Runs |
| Start after Stop | Runs | Skips a retained success |
| Replacement | Runs | Skips a retained success |
| Start after owner restart | Runs | Skips a retained success |
| Start after explicit data deletion | Runs | Runs against new data |
| Explicit job rerun | Normal startup runs all always jobs | The named job runs again. Other successes stay skipped |

Once-only jobs require a managed database dependency. Their results belong to the retained environment, identified by environment and job name.
Changing a command does not erase its previous result. To repeat it, explicitly rerun that job.

Different worktree owners have separate records and databases, even with identical names.
There is no automatic job retry. Use repeatable migration commands for `always` jobs.

A failed, timed-out, canceled, or interrupted once-only job blocks subsequent startup until explicitly rerun or its data is deleted.
The record is written before execution. If the owner exits after a database write but before recording success, the result remains uncertain.
Always dependencies can run before startup reaches a blocked once-only job.
This can block a job that made no writes. It prevents an automatic retry from duplicating writes.

Stop ends owned processes and retains data. It does not roll back a job's writes.
Jobs must implement their own transactions or idempotency when needed.
A failed replacement preserves the serving processes and routes, but migrations can already have changed their shared database.
Use compatible migrations during replacement. Before a disruptive schema change, stop the preview.

## Progress and recovery

The dashboard shows **Setup jobs** for the latest attempt, including progress, failures, logs, and **Run again** when stopped.
CLI `get`, `wait`, and `logs`, and their MCP counterparts, report the same outcomes.
`skipped` means that the job already succeeded for the retained data. It did not execute in this attempt.

For migration logs, run `previewhost logs shop ATTEMPT_ID --source migrate`.
Replace `ATTEMPT_ID` with the failed attempt ID. MCP `preview_logs` accepts the same `source` and an optional `after` cursor.
See [log limits and incremental reads](api.md#methods).

**Reset data** in Activity stops the environment, deletes managed data, and starts the retained configuration again.
Once-only jobs run against the new data. External databases and saved user secrets remain.

If deletion fails, startup does not run. If startup fails after deletion, fix the cause before **Retry start**.
That retry retains data. It does not delete again. Reset does not reload YAML.
See [dashboard actions](dashboard.md#inspect-services-and-updates) for the configuration that restarts.

Check partial writes before a rerun. Once the command is safe to repeat, stop the environment:

```sh
previewhost stop shop
```

Read its latest attempt ID with `get`, then use that ID for the rerun:

```sh
previewhost get shop
previewhost rerun-job shop LATEST_ATTEMPT_ID seed
previewhost wait shop RETURNED_ATTEMPT_ID
```

Replace `LATEST_ATTEMPT_ID` with `latest.id` from `get`. Use the rerun result's candidate ID for `RETURNED_ATTEMPT_ID`.

`rerun-job` starts the environment from the latest retained configuration and current source.
It requires a stopped environment and the exact latest attempt ID. Startup authorization and secret checks apply again.
MCP exposes `preview_rerun_job`. An agent must obtain an explicit user request before using it.

After owner restart, submit the recipe again to restore the in-memory configuration before requesting a rerun.
To discard disposable data instead, Stop, explicitly call `delete-data`, then start again.

A job succeeds only on exit code zero, after its process group is cleaned up.
Its default deadline is 60 seconds. `timeoutMs` accepts 100–600000 milliseconds.
The overall environment deadline also applies and defaults to 60 seconds, with the same range.
No later dependent starts after failure. The runtime cleans up any independent nodes that already started.

Previewhost cannot detect an internal failure that a script catches and reports as success.
Scripts must return a nonzero exit code on failure.
For an API that needs a database, make `/health` query required tables and return 503 if they are unavailable.
`/openapi.json` and a successful `SELECT 1` do not prove that application tables exist.

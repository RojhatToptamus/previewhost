# Databases

Use managed PostgreSQL or Redis for separate preview data. Connect an existing local database when another tool owns its lifecycle.

## Choose who owns the data

| Type | Who starts it | What stop does |
| --- | --- | --- |
| `postgres` or `redis` | Previewhost creates a local Docker container and retains its data. | Removes the owned container and keeps its volume and credentials. |
| `external-postgres` or `external-redis` | You start and configure the existing database. | Leaves the database and its data alone. |

Managed data belongs to the preview name within its owner's data directory.
The same name reuses data after stop/start. Different automatic worktree owners use separate storage, even with identical preview names.
Two external entries with the same connection URL still share data.

## Prepare Docker

Managed databases require macOS, an unlocked keystore, and a running local Docker Engine.
Download the images for the database types you intend to use:

```sh
docker pull postgres:17-alpine
docker pull redis:7-alpine
```

Previewhost does not pull missing images automatically.
Docker Desktop uses `~/.docker/run/docker.sock` by default.
For another local Engine, supply its actual socket path:

```sh
previewhost start --allow-exec --docker-socket /absolute/path/to/docker.sock
```

Replace the path before use. A Docker CLI context does not configure Previewhost.
For MCP, append the socket flag to the registration arguments.
If an owner already uses different options, [shut it down before changing them](troubleshooting.md#the-client-cannot-find-the-daemon).

Automatic owners use private storage per project. A foreground `serve` or embedded runtime also needs an explicit private data directory.
Do not share one data directory between simultaneous owners.

## Unlock database credentials

After you save your configuration, run private setup before startup:

```sh
previewhost secrets setup --allow-exec
```

Create or unlock the keystore in the private form, then wait for setup to complete.
This step also applies when the configuration has managed databases but no user-secret references.
MCP uses `preview_secrets_setup` and `preview_secrets_status`. See [private setup](secrets.md#approve-and-enter-values).

Automatic unlock on macOS lets new owners open the keystore without another password prompt.
Unlocking only the dashboard does not unlock a project owner.

## Connect an application

In an environment, add a managed database and bind its URL to the application's expected variable.
This fragment assumes an API that reads `DATABASE_URL` and has a `/health` endpoint:

```yaml
name: shop
type: environment
primary: api
services:
  db: {type: postgres}
  api:
    type: command
    cwd: ./api
    command: [node, server.mjs]
    readyPath: /health
    env:
      DATABASE_URL: {service: db}
```

Adapt the command, directory, and variable to your application.
The binding waits for database readiness and supplies its connection URL.
Previewhost does not create your application tables. Add [migration and seed jobs](jobs.md) before the API starts.

For an existing database, replace the `db` entry with a stored connection reference:

```yaml
db:
  type: external-postgres
  url: {secret: "shop/dev/database-url"}
```

Enter the connection URL through [private secret setup](secrets.md#approve-and-enter-values).
Supported URLs use `127.0.0.1`, an explicit port, and a database path, without a query or fragment.
PostgreSQL requires a username. A Redis username requires a password.
Remote databases, TLS connection URLs, and Unix socket URLs are unsupported.

## Keep or remove managed data

Normal stop preserves managed data:

```sh
previewhost stop shop
```

To permanently remove the stopped environment's managed data:

```sh
previewhost delete-data shop
```

Deletion cannot be undone. It removes owned volumes and their credentials, but excludes source files, external databases, and saved user secrets.
The preview menu also offers **Delete data** without restarting, or **Reset data** to start the retained configuration after deletion.
Setup jobs can write new data after reset.

After owner shutdown, the dashboard still lists retained data. Unlock **Secret Manager** before deleting it there.
For CLI deletion while the owner is offline, add `--allow-exec`. macOS automatic unlock must be available.
After data deletion, **Remove entry** clears the empty dashboard entry. It leaves source files and saved user secrets intact.

If cleanup fails, follow [database recovery](troubleshooting.md#database-data-or-recovery-is-incomplete).
Back up the encrypted keystore, retained-data directories, and database contents separately. See [credential recovery](troubleshooting.md#database-data-or-recovery-is-incomplete).

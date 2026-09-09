# API and CLI reference

## Runtime and client

The ESM package exports `createPreviewRuntime`, `connectPreviewDaemon`,
`loadPreviewSpec`, `PreviewError`, and public TypeScript types. The runtime and
daemon client implement `PreviewApi`.

These configuration fragments assume imports from `previewd`.
Replace `/absolute/...` paths with your source and private storage directories.
For a complete program with cleanup, see [Embed the library](../README.md#embed-the-library).

```ts
const runtime = await createPreviewRuntime({
  allowedRoots: ['/absolute/frontend', '/absolute/backend'],
  inputs: { API_TOKEN: hostSelectedToken },
  secretIds: ['shop/dev/token'],
  dataDirectory: '/absolute/private-preview-data',
  authorize: async (request) => hostApproval(request),
});

const client = connectPreviewDaemon({
  endpoint: 'http://127.0.0.1:9400',
  tokenFile: '/absolute/private-directory/token',
});
```

`hostSelectedToken` and `hostApproval` represent values and approval behavior from
your application. Both must be supplied by that application.
No input map or data directory exists by default.
`dockerSocket` selects an explicit local Engine socket and requires `dataDirectory`.
Its default is the local Docker Desktop socket at `~/.docker/run/docker.sock`.

For `start` and `replace`, the callback receives `operation`, a separate validated
`spec`, and `signal`. It cannot change execution inputs. Environment bindings
remain symbolic in this request.

For `delete-data` and `recover-data`, the request contains `operation`, `name`,
`resources`, and `signal`. The resource summary contains service names and types,
without credentials. Callbacks must narrow `operation` before they access `spec`.

For `secrets-setup`, the request contains `mode` (`missing` or `edit`), exact `ids`,
and `signal`. Missing-value setup also supplies the symbolic `spec`.
Both modes require owner authorization. A form grant never authorizes execution.

Commands, managed databases, data deletion, and exceptional recovery require
authorization. An absent callback grants none of these operations. Static and
attached HTTP previews do not require this callback.

If `signal` aborts, the callback must release its resources. A late approval
cannot restart a canceled attempt. Approval does not reserve a filesystem snapshot.

`runtime.close()` stops all owned previews and prevents new work. `client.close()`
only closes client requests. `client.shutdown()` explicitly stops the daemon.
The MCP interface does not expose daemon shutdown.

## Specs

The fragments below describe each spec type.
For CLI use, save one complete spec in your application directory.
Start the daemon separately.
See [CLI commands](#cli) for startup, status, and cleanup.

Names match `[a-z][a-z0-9-]{0,47}`. Unknown fields are errors. Library and MCP source
paths must be absolute. File loaders resolve paths from the JSON/YAML file.
JSON stdin paths resolve from the current directory.

```ts
const spec = await loadPreviewSpec('/absolute/project/preview.yaml', { signal });
const description = await runtime.inspect(spec);
```

`loadPreviewSpec` accepts one UTF-8 file of at most 1 MiB. `.yaml` and `.yml`
files use YAML 1.2. Other file names use JSON. YAML aliases, tags, merge keys,
duplicate keys, and multiple documents are errors. The loader never runs code
or loads `.env` files. Source authorization still occurs in the runtime.

```json
{ "name": "site", "type": "static", "directory": "/absolute/site", "spa": false }
```

Static previews serve regular files and directory `index.html` files. `spa: true`
uses the root index for missing extensionless routes. Missing assets still return
404. Hidden files, unsafe symlinks, traversal, and directory listings are unavailable.

```json
{
  "name": "app",
  "type": "command",
  "cwd": "/absolute/app",
  "command": ["node", "server.mjs", "--port", "{port}"],
  "env": { "NODE_ENV": "development" },
  "readyPath": "/ready",
  "timeoutMs": 30000
}
```

Commands use argv directly, without a shell. Each literal `{port}` becomes the
allocated port. The command must listen on that port and bind to loopback.
previewd does not add arguments or retry a command after a port conflict.

The environment inherits only `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`,
`LC_ALL`, and `TERM`. Explicit `env` values override these values.
`PORT`, `HOST`, and `PREVIEW_URL` are reserved for previewd.
Other host environment values require selected `{fromEnv: NAME}` bindings or explicit literals.
Standalone command entries accept literals, `{fromEnv: NAME}`, and `{secret: ID}`.
Resolved `env` entries are limited to 64 KiB of UTF-8 JSON.

An attachment requires an HTTP server that already listens on the supplied port.
The server remains under its original owner after preview stop.

```json
{
  "name": "existing",
  "type": "attach",
  "url": "http://127.0.0.1:3000/",
  "readyPath": "/",
  "timeoutMs": 30000
}
```

Attachment accepts `127.0.0.1`, `localhost`, or one lowercase `.localhost` label,
with an explicit HTTP port. All connections use IPv4 loopback.
The supplied authority becomes the upstream Host header. HTTPS, IPv6, credentials,
paths, queries, and fragments are unsupported.

Command and attach readiness requires HTTP 200–399 response headers. It does not
follow redirects or read the body. `readyPath` defaults to `/`.
`timeoutMs` defaults to 30,000 and accepts 100–120,000. Readiness runs once during
startup. Attachment status is not a continuous health check.

## Environment specs

An environment uses the same preview methods and attempt IDs. Its `services`
map contains 1–16 services and at most four owned databases.
`primary` must name an HTTP service. Environment `timeoutMs` defaults to 60,000
and accepts 100–120,000. Each service deadline also remains in effect.

The example below assumes prepared `backend` and `frontend` directories beside
the spec directory. Each must contain an HTTP `server.mjs` with installed dependencies.
The API must accept the shown bindings and expose `/ready`.
Managed databases require the [database prerequisites](../examples/multi-repo/README.md#install-the-dependencies).
For a complete application, use the [shared-notes example](../examples/multi-repo/README.md).

Before daemon startup, export `API_TOKEN` in its terminal.
Select that value with `serve --env API_TOKEN`.

```yaml
name: shop
type: environment
primary: web
services:
  database: {type: postgres}
  cache: {type: redis}
  api:
    type: command
    cwd: ../backend
    command: [node, server.mjs]
    readyPath: /ready
    env:
      DATABASE_URL: {service: database}
      REDIS_URL: {service: cache}
      API_TOKEN: {fromEnv: API_TOKEN}
      ALLOWED_ORIGIN: {browserUrl: web}
  web:
    type: command
    cwd: ../frontend
    command: [node, server.mjs]
    env:
      API_URL: {service: api}
      PUBLIC_API_URL: {browserUrl: api}
```

HTTP service types are `static`, `command`, and `attach`, with the fields
listed above but no per-service `name`. Owned resource types are `postgres` and
`redis`. They accept no image, mount, port, or credential overrides.

| Command environment value | Meaning |
| --- | --- |
| `"literal"` | The supplied string. |
| `{fromEnv: "NAME"}` | An exact key from `RuntimeOptions.inputs`. |
| `{secret: "ID"}` | One selected user Keychain entry, read once for this attempt. |
| `{service: "api"}` | The candidate HTTP origin or database connection URL. This reference waits for that service. |
| `{publicUrl: "web"}` | The stable numeric URL. Only the primary service supports this reference. |
| `{browserUrl: "api"}` | The stable browser alias for an HTTP service. |

Missing inputs, invalid references, and service-reference cycles fail before
resource startup. Public URL references do not create readiness dependencies.
This permits ordinary frontend/API CORS references in both directions.
previewd does not search `.env` files or forward arbitrary host environment values.
Application commands can load their own files under ordinary user permissions.

The numeric URL reaches only `primary`. Each HTTP service also has
`<name>--<service>.localhost` on the same port. The combined DNS label must fit
within 63 characters and end with a letter or digit.
Native DNS clients do not necessarily resolve browser aliases.
Native service references use numeric loopback addresses.

External databases use `external-postgres` or `external-redis`:

```yaml
services:
  database:
    type: external-postgres
    url: {fromEnv: EXISTING_DATABASE_URL}
```

This fragment belongs inside an environment with a primary HTTP service.
The URL can also be a literal string or `{secret: ID}`. It requires exact `127.0.0.1`, an explicit
port, and a valid database path. PostgreSQL also requires an explicit username.

PostgreSQL uses `postgres:` or `postgresql:`.
Redis uses `redis:`. A supplied Redis username also requires a nonempty password.
Queries, fragments, TLS, sockets, multiple hosts, and remote
addresses are unsupported. Startup performs an authenticated `SELECT 1` or `PING`.
External services remain outside owned stop and deletion operations.

## Methods

| Method | Result and effect |
| --- | --- |
| `inspect(spec)` | Validated public description. No execution or permission grant. Environment key names appear without values. |
| `start(spec)` | Reserves a candidate and returns `PreviewStatus` before startup finishes. |
| `replace(name, spec)` | Starts one candidate while the active route remains available. Names must match. |
| `get(name)` | Current `PreviewStatus`. |
| `list()` | Current and retained terminal status records. |
| `wait(name, attemptId, { timeoutMs?, signal? })` | Exact `AttemptResult`. Default and maximum wait: 30 seconds. |
| `logs(name, attemptId?, maxBytes?)` | `{ name, attemptId, text, truncated }`. Default and maximum: 65,536 bytes. |
| `cancel(name, attemptId)` | Cancels that pending candidate and joins cleanup. A stale ID fails. |
| `stop(name, { afterEngineRestart? })` | Stops all applications and owned containers. Preserves data. Repeated stop retries incomplete cleanup. |
| `deleteData(name)` | Permanently removes a stopped environment's verified owned database data after host authorization. |

`PreviewStatus` contains `name`, `busy`, and optional `url`, `active`, `candidate`,
`latest`, `cleanup`, and `data`. `cleanup` lists attempt IDs and errors that require repair.
Attempt summaries contain `id`, `type`, `state`, `startedAt`, optional `readyAt`,
and optional `{ code, message }` error.

Environment attempts also contain a `services` map. Each entry reports `type`,
`state`, optional public `url`/`browserUrl`, and an optional error. Service states
are `waiting`, `starting`, `ready`, `failed`, and `stopped`.

`data` reports retained resource names/types, `running`, and an optional cleanup
error. It never contains passwords or database connection URLs.
Pending credential deletion adds `data.cleanup.operation: "remove-credential"`.
Stop can complete while that deletion remains pending. Explicit `deleteData` retries it.

Attempt states are `starting`, `ready`, `failed`, `canceled`, `stopped`, and
`cleanup-incomplete`. `AttemptResult` adds `name`.
If that attempt remains active, the result also includes its URL.
`wait` finishes after candidate work and old-target cleanup.
Its timeout or abort only removes that wait.

During replacement, new requests use the candidate after successful readiness.
Old requests receive up to one second to drain. The name stays busy through
retirement. If retirement fails, the new route remains active and status reports
`cleanup-incomplete`. Further replacement requires a successful stop.

An environment changes all application routes together. Database resources stay
shared across active and candidate applications. Candidate failure preserves
the active application and its databases. A ready owned service loss stops the
aggregate application. External probes run only at startup.

Replacement cannot undo source edits, database writes, or migrations performed
by application code. Changes between an environment and a single preview require
stop/start. Managed resource definitions must match retained data.

The runtime retains active attempts, candidates, cleanup handles, and the latest
outcome for each name. It does not retain every historical replacement.
At most 128 inactive names remain. Unknown or expired attempt IDs return
`ATTEMPT_EXPIRED`, never a different attempt result.
Up to 128 retained data records remain independently of that application history.
They appear in `get`/`list` after owner restart.

`deleteData` requires no active/candidate application or unresolved Docker cleanup.
It removes verified owned volumes, exact credentials, and their private records. It never
removes an attached database, source directory, image, or unrelated Docker object.

For an uncertain Docker creation, an absent object alone does not permit cleanup.
After the operator restarts the actual local Engine, explicit
`stop(name, {afterEngineRestart: true})` requests authorized recovery.
The flag asserts that the Engine restart occurred. previewd does not restart Docker or
infer completion from an absent object alone.

## CLI

Run `previewd --help` for the complete syntax. Results use JSON on stdout.
Errors use `{ "error": { "code": "...", "message": "..." } }` on stderr.
Successful commands exit 0. Errors exit nonzero. An interrupted client exits 130.

`start` and `replace` wait by default. `--no-wait` returns the starting status.
`--timeout-ms` controls this wait, separately from the spec readiness timeout.
An error after a successful start request includes the name and attempt ID.
`wait` returns a terminal outcome as JSON, including failed outcomes.

The command examples below assume a spec named `app` in `preview.json` and an active daemon.
They show separate operations. `ATTEMPT_ID` is the candidate ID from start or status.
Use `./node_modules/.bin/previewd` for a local installation without `previewd` on PATH.

```sh
previewd inspect --file preview.json
previewd start --file preview.json --no-wait
previewd wait app ATTEMPT_ID --timeout-ms 30000
previewd replace --file preview.json
previewd get app
previewd logs app ATTEMPT_ID --max-bytes 8192
previewd cancel app ATTEMPT_ID
previewd stop app
previewd delete-data shop
previewd shutdown
```

`shop` represents a stopped environment with managed data.
`delete-data` permanently removes that data. `shutdown` closes the daemon and its previews.

All client commands accept `--endpoint` and `--token-file`. Their defaults are
`http://127.0.0.1:9400` and `~/.local/share/previewd/token`.
`serve` accepts repeated `--root`, repeated `--env`, repeated `--secret`, `--data-dir`,
`--docker-socket`, `--allow-exec`, `--port`, and `--token-file`.
Its default root is the current directory. Port `0` selects an available control
port, which the startup JSON reports.

`--env NAME` selects the current value once at owner startup. Missing selected
keys are errors. Startup JSON reports selected key names without their values.
`--data-dir` enables owned database storage explicitly. `--docker-socket` requires
that directory. The runtime does not create data ownership by default.

`--allow-exec` grants native execution, managed database operations, and explicit
data deletion/recovery through the trusted daemon. `stop --after-engine-restart`
requests only the exceptional recovery described above. It never implies data deletion.

## Stored secrets

Stored secrets require macOS 13 or later and the packaged Keychain helper.
Commands below use `previewd` from PATH, or `./node_modules/.bin/previewd` from your application directory.
`shop/dev/token` is an example name. `preview.yaml` must bind that name with `{secret: shop/dev/token}`.
For setup or edit, start the daemon with `--allow-exec --secret shop/dev/token`.
Replace `REQUEST_ID` with the ID from setup or edit.

Select exact names through `RuntimeOptions.secretIds` or repeated `serve --secret ID`.
The selection is copied at owner creation and defaults to empty. Names match
`[A-Za-z0-9][A-Za-z0-9._/-]{0,127}`. Slashes have no inheritance or filesystem meaning.
Specs bind these names to standalone command fields, environment command fields,
or external database URLs. Unselected names fail before storage access.

Inspect returns `secrets: [{id, selected, bindings: [{service?, key}]}]` without
reading Keychain values. Start/replace resolves each required ID once, after
authorization and source checks, before candidate resources or databases start.
Only declared recipients receive each value. Failed replacement preserves active routes.

```sh
previewd secrets setup --file preview.yaml
previewd secrets setup --file preview.yaml --reopen
previewd secrets edit shop/dev/token
previewd secrets status REQUEST_ID
previewd secrets set shop/dev/token
previewd secrets set shop/dev/token --stdin
previewd secrets list
previewd secrets remove shop/dev/token
```

Setup/edit/status use the daemon and accept `--endpoint` and `--token-file`.
Set/list/remove operate directly on user entries without a daemon and never change
its selection. They cannot modify internal database credentials.

Set creates or replaces one item. Hidden terminal entry supports backspace, Ctrl-U,
Ctrl-C, and bracketed paste. Enter submits outside a paste. `--stdin` requires a
pipe and preserves all UTF-8 bytes, including whitespace, newlines, and a leading BOM.

Each value needs 1–4096 valid UTF-8 bytes without NUL. Values are never accepted in
arguments or normal output. There is no value-read/export command.

Missing-value setup adds only absent entries. Explicit edit requires an existing entry.
If the entry disappeared, edit fails. Every field is validated before saving begins.

Writes are atomic per item, with no cross-item transaction or ordering guarantee.
Partial results keep successful writes. A dispatched write without a confirmed
response reports `error.outcome: "unknown"`. An absent response does not imply rollback.

The client adds `secretsSetup(spec, {reopen?, signal?})`, `secretsStatus(id)`, and
`secretsEdit(id, {signal?})`. Results include public `id`, `mode`, optional `name`,
`sources`, `requirements`, `expiresAt`, `browser`, `state`, `saved`, `alreadyPresent`,
`remaining`, and optional `error`. No result contains a private URL or capability.

States are `pending`, `saving`, `complete`, `partial`, `canceled`, and `expired`.
Remaining names have unconfirmed writes. They are not necessarily absent.
`complete` reports observed presence or completed writes, not issuer validity or
future read permission. `browser: "failed"` means use hidden CLI input or `--reopen`.
A fresh setup rechecks availability after CLI entry and invalidates an obsolete form.

Save starts no application. Check status before another start/replace with the current spec.
Form close or expiry also starts no application.
Daemon restart loses grants and setup history. Cancellation stops setup preparation.
A client disconnect after grant creation does not revoke the form automatically.

Updates affect later resolutions. Running applications can retain old values.

For credentials that must change together, first cancel pending starts.
Stop all consuming daemons before you update the entries.
After the update, restart those daemons.
previewd has no cross-daemon consumer registry.
Local removal does not revoke a credential at its issuer.

After use, stop the preview.
Shut down its daemon.
To remove the example entry, run `previewd secrets remove shop/dev/token`.

User entries use macOS Keychain through a packaged native helper. Static/attach
and explicit-input library use do not load it. See [storage and recovery](security.md).

## HTTP and MCP

The daemon accepts authenticated JSON `POST /METHOD` requests.
The body contains the method arguments, such as `{ "spec": { ... } }` or
`{ "name": "app", "attemptId": "...", "timeoutMs": 30000 }`.
`list` and `shutdown` take `{}`. Successful responses contain `{ "result": ... }`.
Failures contain `{ "error": { "code": "...", "message": "..." } }`.

Control requests require `Authorization: Bearer TOKEN`, `Content-Type: application/json`,
the exact numeric Host header, and no Origin header. Use a trusted local HTTP
client, the library client, or the CLI. This is not a browser control API.

MCP tools use the names `preview_inspect`, `preview_start`, `preview_replace`,
`preview_list`, `preview_get`, `preview_wait`, `preview_logs`, `preview_cancel`,
`preview_stop`, `preview_delete_data`, `preview_secrets_setup`, and
`preview_secrets_status`. Arguments match the HTTP method arguments, except the
owner-only `reopen` option. There is no MCP edit, set, remove, read, or export tool.

Data deletion uses `POST /deleteData` with `{ "name": "shop" }`.
Stop accepts `{ "name": "shop", "afterEngineRestart": true }` for explicit recovery.
The deletion tool has a destructive annotation and requires owner authorization.
Both `structuredContent` and the text fallback contain the response envelope.
Tool failures also set `isError: true`.

`POST /secrets/setup` takes `{spec, reopen?}`, `/secrets/status` takes `{id}`,
and `/secrets/edit` takes an exact secret `{id}`. These use ordinary control authority.
The fixed `GET /secrets`, `/secrets.js`, and `/secrets.css` assets grant no permission.
Browser `POST /secrets/form`, `/secrets/save`, and `/secrets/cancel` require exact
Host/Origin and the private one-use grant, independently of the control bearer.
These private routes are used only by the owner page. They are never public preview routes.

## Errors and limits

Errors use stable `PreviewError.code` values. Do not parse error messages.

`INVALID_INPUT`, `SOURCE_DENIED`, `EXECUTION_DENIED`, `ALREADY_EXISTS`, `BUSY`,
`NOT_FOUND`, `STALE_ATTEMPT`, `ATTEMPT_EXPIRED`, `UNSUPPORTED_PLATFORM`,
`START_FAILED`, `TIMEOUT`, `CLEANUP_INCOMPLETE`, `UNAUTHORIZED`,
`DAEMON_UNAVAILABLE`, `CLOSED`, `SECRET_REQUIRED`, `SECRET_DENIED`, and
`SECRET_STORE_UNAVAILABLE` are the public error codes. Secret failures can include
the same redacted `requirements` metadata used by inspect.

There are at most 32 live names, 128 inactive names, and 64 KiB of logs per attempt.
The total live-node limit is 128, including candidates and retained cleanup.
At most four environment services start concurrently.

Each gateway permits 256 connections and in-flight requests. Upstream response
headers and WebSocket handshakes have a 10-second deadline. Active streams do not.
Control bodies and responses have a 1 MiB limit. The daemon permits 32 active
requests, including at most 16 waits, with two slots reserved for cleanup.

At most 128 IDs can be selected or required per attempt. Metadata listing returns
up to 128 names with `truncated`. Keychain work permits four helpers and 32 queued
operations. Reads have a 10-second deadline. Explicit interactive writes have 30 seconds.

Forms expire after five minutes, with eight pending/saving forms and 32 recent
results. Browser launches are limited to one per second. A save has a 30-second
deadline and retains partial or uncertain outcomes. Ordinary status and preview
traffic perform no Keychain reads.

After a lost mutation response, call `get` or `list` before another mutation.
A transport failure does not prove that the original operation failed.

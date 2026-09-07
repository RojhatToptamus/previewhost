# API and CLI reference

## Runtime and client

The ESM package exports `createPreviewRuntime`, `connectPreviewDaemon`,
`loadPreviewSpec`, `PreviewError`, and public TypeScript types. The runtime and
daemon client implement `PreviewApi`.

```ts
const runtime = await createPreviewRuntime({
  allowedRoots: ['/absolute/frontend', '/absolute/backend'],
  inputs: { API_TOKEN: hostSelectedToken },
  dataDirectory: '/absolute/private-preview-data',
  authorize: async (request) => hostApproval(request),
});

const client = connectPreviewDaemon({
  endpoint: 'http://127.0.0.1:9400',
  tokenFile: '/absolute/private-directory/token',
});
```

`hostSelectedToken` and `hostApproval` represent values and approval behavior from
your application. No input map or data directory exists by default.
`dockerSocket` selects an explicit local Engine socket and requires `dataDirectory`.
Its default is the local Docker Desktop socket at `~/.docker/run/docker.sock`.

For `start` and `replace`, the callback receives `operation`, a separate validated
`spec`, and `signal`. It cannot change execution inputs. Environment bindings
remain symbolic in this request.

For `delete-data` and `recover-data`, the request contains `operation`, `name`,
`resources`, and `signal`. The resource summary contains service names and types,
without credentials. Callbacks must narrow `operation` before they access `spec`.

Commands, managed databases, data deletion, and exceptional recovery require
authorization. An absent callback grants none of these operations. Static and
attached HTTP previews retain their existing default permission.

The callback must release its own resources when `signal` aborts. A late approval
cannot restart a canceled attempt. Approval does not reserve a filesystem snapshot.

`runtime.close()` stops all owned previews and prevents new work. `client.close()`
only closes client requests. `client.shutdown()` explicitly stops the daemon.
The MCP interface does not expose daemon shutdown.

## Specs

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
Other host environment values require explicit `env` entries.

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

HTTP service types are `static`, `command`, and `attach`, with their existing
fields but no per-service `name`. Owned resource types are `postgres` and
`redis`. They accept no image, mount, port, or credential overrides.

| Command environment value | Meaning |
| --- | --- |
| `"literal"` | The supplied string. |
| `{fromEnv: "NAME"}` | An exact key from `RuntimeOptions.inputs`. |
| `{service: "api"}` | The candidate HTTP origin or database connection URL. This reference waits for that service. |
| `{publicUrl: "web"}` | The stable numeric URL. Only the primary service supports this reference. |
| `{browserUrl: "api"}` | The stable browser alias for an HTTP service. |

Missing inputs, invalid references, and service-reference cycles fail before
resource startup. Public URL references do not create readiness dependencies.
This permits ordinary frontend/API CORS references in both directions.
There is no automatic `.env` search or arbitrary host environment access.

The numeric URL reaches only `primary`. Each HTTP service also has
`<name>--<service>.localhost` on the same port. The combined DNS label must fit
within 63 characters and end with a letter or digit. Browser aliases are not a general native DNS guarantee.
Native service references use numeric loopback addresses.

External databases use `external-postgres` or `external-redis`:

```yaml
services:
  database:
    type: external-postgres
    url: {fromEnv: EXISTING_DATABASE_URL}
```

This fragment belongs inside an environment with a primary HTTP service.
The URL can also be a literal string. It requires exact `127.0.0.1`, an explicit
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

Attempt states are `starting`, `ready`, `failed`, `canceled`, `stopped`, and
`cleanup-incomplete`. `AttemptResult` adds `name` and the URL when that attempt
is still active. `wait` finishes after candidate work and old-target cleanup.
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

`deleteData` requires no active/candidate application or unresolved cleanup.
It removes only verified owned volumes and their private records. It never
removes an attached database, source directory, image, or unrelated Docker object.

For an absent indeterminate Docker creation, normal stop retains the uncertainty.
After the operator restarts the actual local Engine, explicit
`stop(name, {afterEngineRestart: true})` requests authorized recovery.
The flag confirms that operator action. previewd does not restart Docker or
infer completion from an absent object alone.

## CLI

Run `previewd --help` for the complete syntax. Results use JSON on stdout.
Errors use `{ "error": { "code": "...", "message": "..." } }` on stderr.
Successful commands exit 0. Errors exit nonzero. An interrupted client exits 130.

`start` and `replace` wait by default. `--no-wait` returns the starting status.
`--timeout-ms` controls this wait, separately from the spec readiness timeout.
An error after a successful start request includes the name and attempt ID.
`wait` returns a terminal outcome as JSON, including failed outcomes.

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
```

All client commands accept `--endpoint` and `--token-file`. Their defaults are
`http://127.0.0.1:9400` and `~/.local/share/previewd/token`.
`serve` accepts repeated `--root`, repeated `--env`, `--data-dir`,
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
`preview_stop`, and `preview_delete_data`. Arguments match the HTTP method arguments.
Data deletion uses `POST /deleteData` with `{ "name": "shop" }`.
Stop accepts `{ "name": "shop", "afterEngineRestart": true }` for explicit recovery.
The deletion tool has a destructive annotation and requires owner authorization.
Both `structuredContent` and the text fallback contain the response envelope.
Tool failures also set `isError: true`.

## Errors and limits

Errors use stable `PreviewError.code` values. Do not parse error messages.

`INVALID_INPUT`, `SOURCE_DENIED`, `EXECUTION_DENIED`, `ALREADY_EXISTS`, `BUSY`,
`NOT_FOUND`, `STALE_ATTEMPT`, `ATTEMPT_EXPIRED`, `UNSUPPORTED_PLATFORM`,
`START_FAILED`, `TIMEOUT`, `CLEANUP_INCOMPLETE`, `UNAUTHORIZED`,
`DAEMON_UNAVAILABLE`, and `CLOSED` are the public error codes.

There are at most 32 live names, 128 inactive names, and 64 KiB of logs per attempt.
The total live-node limit is 128, including candidates and retained cleanup.
At most four environment services start concurrently.
Each gateway permits 256 connections and in-flight requests. Upstream response
headers and WebSocket handshakes have a 10-second deadline. Active streams do not.
Control bodies and responses have a 1 MiB limit. The daemon permits 32 active
requests, including at most 16 waits, with two slots reserved for cleanup.

After a lost mutation response, call `get` or `list` before another mutation.
A transport failure does not prove that the original operation failed.

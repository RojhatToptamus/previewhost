# API and CLI reference

Look up runtime methods, spec fields, CLI flags, and MCP tool arguments. For a complete workflow, start with [MCP](mcp.md), [CLI](first-preview.md), or the [library](library.md).

## Runtime and client

The ESM package exports `createPreviewRuntime`, `connectPreviewDaemon`,
`loadPreviewSpec`, `savePreviewSpec`, `PreviewError`, and public TypeScript types. The runtime and
daemon client implement `PreviewApi`.

These configuration fragments assume imports from `previewhost`.
Replace `/absolute/...` paths with your source and private storage directories.
For a complete program with cleanup, see [Node.js library](library.md).

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

For `start` and `replace`, the callback receives `operation`, a validated copy of
`spec`, and `signal`. Changes to this copy do not affect execution.
The callback receives unresolved service, input, and secret references.

For `delete-data` and `recover-data`, the request contains `operation`, `name`,
`resources`, and `signal`. The resource summary contains service names and types,
without credentials. These requests have no `spec`.
Check `operation` before you read `spec` in the callback.

For `secrets-setup`, the request contains `mode` (`missing` or `edit`), exact `ids`,
and `signal`. Missing-value setup also supplies `spec` with unresolved references.
Both modes require owner authorization. A form grant never authorizes execution.

Commands, managed databases, data deletion, and exceptional recovery require
authorization. An absent callback grants none of these operations. Static and
attached HTTP previews do not require this callback.

If `signal` aborts, the callback must release its resources. A late approval
cannot restart a canceled attempt. Source files can change while approval is pending.

`runtime.close()` stops all owned previews and prevents new work. `client.close()`
only closes client requests. `client.shutdown()` explicitly stops the daemon.
MCP exposes the same owner-wide operation as `preview_shutdown`.

## Specs

Each start or replacement creates an attempt with its own ID.
A pending start or replacement appears as `candidate`.
The `active` field identifies the attempt that serves requests.
During replacement, both can exist under the same preview name.

The fragments below describe each spec type.
CLI accepts JSON stdin or an explicit JSON/YAML file. Default lookup checks root `preview.yaml`, then `preview.yml`.
If both exist, it reports an error. Explicit files and direct specs bypass default lookup.
MCP accepts a direct spec or a file and starts a project owner when needed.
See [CLI commands](#cli) for startup, status, and cleanup.

Names match `[a-z][a-z0-9-]{0,47}`. Unknown fields are errors. Library and MCP source
paths must be absolute. File loaders resolve paths from the JSON/YAML file.
JSON stdin paths resolve from the current directory.

```ts
const spec = await loadPreviewSpec('/absolute/project/preview.yaml', { signal });
const description = await runtime.inspect(spec);
```

`loadPreviewSpec` accepts one regular UTF-8 file of at most 1 MiB. Pipes belong on JSON stdin.

Its optional `allowedRoots` constrains the resolved file target, including symlinks. `.yaml` and `.yml`
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
previewhost does not add arguments or retry a command after a port conflict.

The environment inherits only `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`,
`LC_ALL`, and `TERM`. Explicit `env` values override these values.
`PORT`, `HOST`, and `PREVIEW_URL` are reserved for previewhost.
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
The supplied hostname and port become the upstream Host header. HTTPS, IPv6, credentials,
paths, queries, and fragments are unsupported.

Command and attach readiness requires HTTP 200–399 response headers. It does not
follow redirects or read the body. `readyPath` defaults to `/`.
`timeoutMs` defaults to 30,000 and accepts 100–120,000. Readiness runs once during
startup. Attachment status is not a continuous health check.

## Environment specs

An environment uses the same preview methods and attempt IDs. Its `services`
map contains 1–16 nodes (services and finite jobs) and at most four owned databases.
`primary` must name an HTTP service. Environment `timeoutMs` defaults to 60,000
and accepts 100–600,000. Each node deadline also remains in effect.

Use `type: job` for finite commands and `dependsOn` to wait for successful jobs or ready services.
See [setup jobs](jobs.md) for fields, examples, retained seed results, and recovery.

The example below assumes prepared `backend` and `frontend` directories beside
the spec directory. Each must contain an HTTP `server.mjs` with installed dependencies.
The API must accept the shown bindings and expose `/ready`.
Managed databases require the [database prerequisites](databases.md#prepare-docker).
For a complete application, use the [shared-notes example](../examples/multi-repo/README.md).

Before daemon startup, export `API_TOKEN` in its terminal.
Select that value with `start --env API_TOKEN --allow-exec`, or `serve --env API_TOKEN` for a manual daemon.

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
| `{secret: "ID"}` | One selected user keystore entry, read once for this attempt. |
| `{service: "api"}` | The candidate HTTP origin or database connection URL. This reference waits for that service. |
| `{publicUrl: "web"}` | The stable numeric URL. Only the primary service supports this reference. |
| `{browserUrl: "api"}` | The stable browser alias for an HTTP service. |

Missing inputs, invalid references, and service-reference cycles fail before
resource startup. Public URL references do not create readiness dependencies.
The frontend can receive the API URL while the API receives the frontend origin for CORS.
previewhost does not search `.env` files or forward arbitrary host environment values.
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
| `logs(name, attemptId?, { source?, after?, maxBytes? })` | `{ name, attemptId, text, cursor, truncated }`. Select a service/job or omit `source` for all output. |
| `cancel(name, attemptId)` | Cancels the pending candidate and waits for cleanup. A stale ID fails. |
| `stop(name, { afterEngineRestart? })` | Stops all applications and owned containers. Preserves data. Repeated stop retries incomplete cleanup. |
| `rerunJob(name, attemptId, job)` | Reruns the named job and starts the stopped environment from its latest configuration. Normal authorization applies. Partial writes remain. |
| `deleteData(name, { expected? })` | Permanently removes a stopped environment's verified owned database data after host authorization. |

Logs use one bounded store per attempt: 65,536 captured UTF-8 bytes and at most 1,024
output chunks. Filtering does not create another buffer. Source labels in **All output**
are added when reading, not parsed from application text. Known supplied values are
redacted before storage. Applications must still avoid logging other sensitive data.

Without `after`, reads return a tail. For incremental reads, keep the same `attemptId`
and `source`, then pass the returned `cursor` as `after`. A cursor is a byte offset in
that attempt's captured output, before display labels. It advances past other sources
as well. `maxBytes` limits captured bytes per read (4–65,536). Display labels add bytes.

`truncated` means earlier output was omitted by retention or the initial tail limit.

Incremental pages do not skip output still retained. An expired attempt is an error. Logs are not persisted after owner shutdown. No streaming endpoint is provided.

Output comes from command services and jobs. Database container logs are not collected.

For a confirmed deletion, `expected` accepts `{ attemptId, resources: [{ name, type }] }`.
The latest attempt and exact managed resource list must still match before deletion.
Normal stopped-state, ownership and authorization checks still apply.

`PreviewStatus` contains `name`, `busy`, and optional `url`, `active`, `candidate`,
`latest`, `cleanup`, and `data`. `cleanup` lists attempt IDs and errors that require repair.
Attempt summaries contain `id`, `type`, `state`, `startedAt`, optional `readyAt`,
and optional `{ code, message }` error.

Environment attempts also contain a `services` map. Each entry reports `type`,
`state`, optional public `url`/`browserUrl`, and an optional error. Service states
are `waiting`, `starting`, `ready`, `failed`, and `stopped`. Jobs also report
`succeeded`, `skipped` (retained success), or `canceled`, and never have public URLs.

`data` reports retained resource names/types, `running`, and an optional cleanup
error. It never contains passwords or database connection URLs.
Pending credential deletion adds `data.cleanup.operation: "remove-credential"`.
Stop can complete while that deletion remains pending. Explicit `deleteData` retries it.

Attempt states are `starting`, `ready`, `failed`, `canceled`, `stopped`, and
`cleanup-incomplete`. `AttemptResult` adds `name`.
If that attempt remains active, the result also includes its URL.
`wait` finishes after startup and any cleanup of the replaced application.
A timeout or canceled wait leaves the preview running.

During replacement, new requests use the candidate after successful readiness.
Existing requests have up to one second to finish. The name stays busy until
cleanup of the old application finishes. If cleanup fails, the new route remains
active and status reports `cleanup-incomplete`. Another replacement requires a successful stop.

An environment changes all application routes together. Database resources stay
shared across active and candidate applications. Candidate failure preserves
the active application and its databases.
If an owned service fails after startup, previewhost stops the environment's owned services.
External connection checks run only at startup.

Replacement cannot undo source edits, database writes, or migrations performed
by application code. Changes between an environment and a single preview require
stop/start. Managed resource definitions must match retained data.

The runtime retains active attempts, candidates, cleanup handles, and the latest
outcome for each name. After Stop, `latest` retains the application actually stopped,
rather than a failed replacement of it. It does not retain every historical replacement.

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
The flag asserts that the Engine restart occurred. previewhost does not restart Docker or
infer completion from an absent object alone.

## CLI

Run `previewhost --help` for the complete syntax. Results use JSON on stdout.
Errors use `{ "error": { "code": "...", "message": "..." } }` on stderr.
Successful commands exit 0. Errors exit nonzero. An interrupted client exits 130.

`start` and `replace` wait by default. `--no-wait` returns the starting status.
`--timeout-ms` controls this wait, separately from the spec readiness timeout.
When this budget expires, start/replace reads the current attempt and returns its state, including `starting`, with exit 0.
Continue waiting for that ID. A real failed attempt remains an error.

An error after a successful start request includes the name and attempt ID.
`wait` returns a terminal outcome as JSON, including failed outcomes.

The command examples below assume a spec named `app` in `preview.json`.
Cold command startup requires `--allow-exec`. Static previews need no execution grant.
These are separate operations, not a sequence to run unchanged. `ATTEMPT_ID` is the candidate ID from start or status.
Use `./node_modules/.bin/previewhost` for a local installation without `previewhost` on PATH.

```sh
previewhost inspect --file preview.json
previewhost start --file preview.json --allow-exec --no-wait
previewhost wait app ATTEMPT_ID --timeout-ms 30000
previewhost replace --file preview.json
previewhost get app
previewhost logs app ATTEMPT_ID --source migrate --max-bytes 8192
previewhost logs app ATTEMPT_ID --source migrate --after RETURNED_CURSOR
previewhost cancel app ATTEMPT_ID
previewhost stop app
previewhost delete-data shop
previewhost shutdown
```

`shop` represents a stopped environment with managed data.
`delete-data` permanently removes that data. `shutdown` closes the daemon and its previews.

CLI commands default to the current canonical Git worktree root, or cwd outside Git.
Automatic MCP tools select the `project` supplied with each call.
`--project DIR` selects another project. Each project has one persistent owner with a dynamic loopback port.

Start, replace, and secret setup/edit can start it. Read/status/cleanup commands never create an owner.
Inspection validates offline before an owner exists. It does not open managed storage or resolve keystore values.
MCP discovery needs no owner or skill installation.

`mcp`, `inspect`, `start`, `replace`, and `secrets setup/edit` accept `--root`, `--allow-exec`, `--env`, `--secret`, `--data-dir`, and `--docker-socket`.
The default source root is the selected project. Existing owner settings are reused when flags are omitted.
Incompatible explicit settings report an error without reconfiguring or terminating the owner.
Selected input values are captured at startup. Restarting the owner is required to refresh them.

An explicit `--endpoint` or `--token-file` selects connection-only mode.
That mode uses `http://127.0.0.1:9400` and `~/.local/share/previewhost/token` for any omitted connection value.
It accepts no launch-permission flags and never starts an owner.
`--version` prints the installed package version.

`serve` accepts repeated `--root`, repeated `--env`, repeated `--secret`, `--data-dir`,
`--docker-socket`, `--allow-exec`, `--port`, and `--token-file`.
Its default root is the current directory. Port `0` selects an available control
port, which the startup JSON reports.

`--env NAME` selects the current value once at owner startup. Missing selected
keys are errors. Startup JSON reports selected key names without their values.

`--data-dir` selects an exact private directory for managed databases.
Automatic owners default to `data` inside their private project-owner directory, with or without `--docker-socket`.
A shared directory permits only one owner at a time.
Foreground `serve` requires `--data-dir` for managed databases.

`--allow-exec` grants native execution, managed database operations, and explicit
data deletion/recovery and private secret setup through the trusted daemon. `stop --after-engine-restart`
requests recovery after a Docker Engine restart, as described above. It never implies data deletion.

### Managed databases with MCP

Start your local Docker Engine and [download the required database images](databases.md#prepare-docker).
Docker Desktop on macOS uses `~/.docker/run/docker.sock` by default. No additional MCP flags are needed.
For another local Engine, append its socket path to the MCP registration command after `--allow-exec`:

```sh
--docker-socket /absolute/path/to/docker.sock
```

In Cursor, add `"--docker-socket"` and the expanded absolute socket path as two entries in `args`.
JSON does not expand `$HOME`. Docker CLI context selection does not configure Previewhost.
Each automatic project owner uses separate private data storage. Do not supply one shared `--data-dir` across projects.
If an owner already runs with different settings, follow the [owner restart instructions](troubleshooting.md#the-client-cannot-find-the-daemon).

## Stored secrets

Stored secrets use a password-backed encrypted keystore on macOS, Windows, and Linux.
Optional automatic unlock uses the existing macOS Keychain helper. Native commands, automatic owners, and managed databases still require macOS.
Commands below use `previewhost` from PATH, or `./node_modules/.bin/previewhost` from your application directory.
`shop/dev/token` is an example name, bound with `{secret: shop/dev/token}` in a direct spec or optional file.

For cold setup, use `--allow-exec`. The private form can approve unselected names. Explicit edit still requires an already selected name.
Replace `REQUEST_ID` with the ID from setup or edit.

Select exact names through `RuntimeOptions.secretIds` or repeated `serve --secret ID`.
The initial selection is copied at owner creation and defaults to empty.
Private setup can add exact names after browser approval. Grants last until owner shutdown.
The same exact name reuses one keystore value across worktrees and projects that approve it.
Use a distinct explicit reference for a different value. Missing-value setup never overwrites shared entries. Names match
`[A-Za-z0-9][A-Za-z0-9._/-]{0,127}`. Slashes have no inheritance or filesystem meaning.

Specs bind these names to standalone command fields, environment command fields,
or external database URLs. Start/replace rejects unselected names before storage access.

Setup checks neither presence nor values for an unselected name until private approval.
Approval checks source access again and adds selected names, up to 128 per owner.

Inspect returns `secrets: [{id, selected, bindings: [{service?, key}]}]` without
reading keystore values. Start/replace resolves each required ID once, after
authorization and source checks, before candidate resources or databases start.
Only declared recipients receive each value. Failed replacement preserves active routes.

```sh
previewhost secrets setup --file preview.yaml --allow-exec
previewhost secrets setup --file preview.yaml --allow-exec --reopen
previewhost secrets edit shop/dev/token
previewhost secrets status REQUEST_ID --timeout-ms 25000
previewhost secrets init
previewhost secrets remember
previewhost secrets forget
previewhost secrets set shop/dev/token
previewhost secrets set shop/dev/token --stdin
previewhost secrets list
previewhost secrets remove shop/dev/token
```

Setup/edit/status use the daemon and accept `--endpoint` and `--token-file`.
Init/remember/forget/set/list/remove operate directly on user entries without a daemon and never change
its selection. They cannot modify internal database credentials.

Commands unlock their own session through hidden password input when needed.
`init` requires a password of at least 12 characters and confirmation.
Add `--remember` to `init` to request automatic unlock on macOS.
`remember` enables automatic unlock on macOS. `forget` removes it without locking existing sessions.
Private setup unlocks its project owner. Dashboard unlock applies only to the dashboard.
For piped `set --stdin`, automatic unlock must already work. Otherwise, use hidden terminal entry or private setup.
Unattended previews can use explicitly selected environment inputs without opening the keystore.

Set creates or replaces one item. Hidden terminal entry supports backspace, Ctrl-U,
Ctrl-C, and bracketed paste. Enter submits outside a paste. `--stdin` requires a
pipe and preserves all UTF-8 bytes, including whitespace, newlines, and a leading BOM.

Each value needs 1–4096 valid UTF-8 bytes without NUL. Values are never accepted in
arguments or normal output. There is no value-read/export command.

Missing-value setup adds only absent entries. Explicit edit requires an existing entry.
If the entry disappeared, edit fails. Every field is validated before saving begins.

Writes are atomic per item, with no cross-item transaction or ordering guarantee.
Partial results keep successful writes. An absent response does not imply rollback.
Automatic-unlock helper writes can report `error.outcome: "unknown"`.

The client adds `secretsSetup(spec, {reopen?, signal?})`, `secretsStatus(id, {timeoutMs?, signal?})`, and
`secretsEdit(id, {signal?})`. Results include public `id`, `mode`, optional `name`,
`sources`, `requirements`, `expiresAt`, `browser`, `state`, `saved`, `alreadyPresent`,
`remaining`, optional `error`, and keystore availability (`new`, `locked`, or `unlocked`). No result contains a private URL or capability.

| Setup result | Meaning and next action |
| --- | --- |
| `pending` or `saving` | Setup is in progress. A status wait timeout does not cancel it. Keep the same request ID. |
| `canceled` | The request ended and its private form is invalid. Stop setup. Wait for an explicit user request before new setup or startup. |
| `expired` | The form reached its deadline. Ask before requesting a new form. |
| `complete` | Access is approved and all required entries were observed present or saved. Check preview state before startup. |
| `partial` | Setup ended with an error. The private form cannot be reused. Resolve the error before requesting fresh setup. |

Do not interpret `canceled` as accidental browser closure. A browser close alone does not change status to `canceled`.
The server invalidates canceled forms. The instruction to wait for explicit user intent is agent guidance, not a server-enforced restriction on new requests.

Remaining names have unconfirmed writes. They are not necessarily absent.

Status can wait up to 25,000 ms. Canceling that wait leaves the form open.
It does not check whether a credential works with its service or remains accessible later.

The `browser` field reports launch delivery separately from setup state.
For a pending request with `browser: "failed"`, retry with `--reopen`. Hidden CLI input can supply missing values for selected names.
CLI entry does not approve unselected names. Those still need private approval or explicit selection when the owner starts.
A fresh setup rechecks availability after CLI entry and invalidates an obsolete form.

Save starts no application. Check status and current preview state before another start/replace with the current spec.
Re-read file-based specs after private entry. Do not run an obsolete file or implicitly approve newly edited names.

If the agent turn ends, send “Secrets saved—continue”. Retain the original project path and request ID together.
Form close or expiry also starts no application.

Owner restart loses access approvals and setup history, but stored values remain.
Cancellation stops setup preparation. It does not undo earlier name approvals or saved values.

A client disconnect after grant creation does not revoke the form automatically.

Updates affect later resolutions. Running applications can retain old values.

For credentials that must change together, first cancel pending starts.
Stop all consuming daemons before you update the entries.
After the update, restart those daemons.
previewhost does not track secret use across daemons.
Local removal does not revoke a credential at its issuer.

After use, stop the preview.
Shut down its daemon.
To remove the example entry, run `previewhost secrets remove shop/dev/token`.

See [Keystore unlock and recovery](security.md#stored-secrets-and-private-entry).

## HTTP and MCP

The daemon accepts authenticated JSON `POST /METHOD` requests.
The body contains the method arguments, such as `{ "spec": { ... } }` or
`{ "name": "app", "attemptId": "...", "timeoutMs": 30000 }`.
`list`, `info`, and `shutdown` take `{}`. Successful responses contain `{ "result": ... }`.
Failures contain `{ "error": { "code": "...", "message": "..." } }`.

Control requests require `Authorization: Bearer TOKEN`, `Content-Type: application/json`,
the exact numeric Host header, and no Origin header. Use a trusted local HTTP
client, the library client, or the CLI. This is not a browser control API.

MCP tools use these names:

`preview_inspect`, `preview_start`, `preview_replace`,
`preview_list`, `preview_get`, `preview_wait`, `preview_logs`, `preview_cancel`,
`preview_stop`, `preview_delete_data`, `preview_secrets_setup`, `preview_secrets_status`,
`preview_save_config`, `preview_rerun_job`, and `preview_shutdown`.

Global registration without fixed project/root configuration adds `preview_access({project, sources?})` (16 tools total).
It requests native client confirmation of exact directories before connecting to that project.
Approval can start the owner but never an application. Denial/cancellation stops the flow. Reconnecting requires approval again.

Automatic MCP tools require an absolute `project` on every call unless the registration supplies `--project` as a default.
This includes reads, waits, secret status, stopping, and owner shutdown. The field selects the owner, file base, and default source root.

Global selection requires confirmed project access. Explicit root registrations permit configured roots and their registered Git worktrees. Neither grants execution or selects secret names.
A shared connection retains no current-chat or last-project state. Equal preview names in different projects remain independent.

Explicit endpoint/token mode keeps one fixed owner and rejects `project` tool arguments.

MCP inspect/start/replace/setup accepts either `spec` or `file`, never both.
If both are omitted, it reads project-root `preview.yaml`, or `preview.yml` if `preview.yaml` is absent.
If both files exist, default lookup reports an error. Invalid or unreadable files are errors.

Explicit file paths resolve from the MCP project. Source paths resolve relative to that file.

MCP files and sources must resolve within the connection’s approved roots or explicit configured roots. Symlink escapes are rejected.

The HTTP/runtime API continues to accept spec objects only. `reopen` remains owner-only.
There is no public name-approval, secret edit, set, remove, value-read, or export tool.

`preview_save_config({project, spec})` creates root `preview.yaml` only on an explicit user request.
It uses the original prepared spec, validates schema, dependencies, attachments and source scope, then round-trips through the strict YAML loader.

It preserves non-secret literals and references without resolving inputs, credentials, service URLs or ports.
Project-local source paths become relative. The result contains `file` and `externalSources` (nonportable paths).
It does not run code or establish application health. Save/load cannot certify arbitrary strings contain no secrets.

Either `preview.yaml` or `preview.yml` at the destination produces `ALREADY_EXISTS`, including directories and symlinks. Use a normal editor for requested updates and validate them.

Complete-file publication permits one concurrent creator and exposes no partial file.
The same operation is available as `savePreviewSpec(spec, {projectDirectory, allowedRoots?, signal?})` in the library.

`info` reports a project owner's project, PID, current source roots, execution mode, input keys, initial secret IDs and data/socket paths.
Manual owners return `null`. Values and dynamic browser grants are not copied into connection files.

Authenticated automatic-owner clients can call `allowSources(directories, signal?)` (`POST /sources/allow`).
The runtime requires `authorize` to accept `operation: "allow-sources"`, rechecks paths, and updates its existing root set.
This is an owner operation, not an agent-controlled approval argument. Fixed daemons reject it.

Attempt summaries and incomplete cleanup records include `sources` so callers can identify directories still in use.

Job rerun uses `POST /rerunJob` with `{ "name": "shop", "attemptId": "...", "job": "seed" }`.
Data deletion uses `POST /deleteData` with `{ "name": "shop" }`.
Stop accepts `{ "name": "shop", "afterEngineRestart": true }` for explicit recovery.
The deletion tool has a destructive annotation and requires owner authorization.
Both `structuredContent` and the text fallback contain the response envelope.
Tool failures also set `isError: true`.

`POST /secrets/setup` takes `{spec, reopen?}`, `/secrets/status` takes `{id, timeoutMs?}`,
and `/secrets/edit` takes an exact secret `{id}`. These require the daemon's control token.
The fixed `GET /secrets`, `/secrets.js`, and `/secrets.css` assets grant no permission.
Browser `POST /secrets/form`, `/secrets/approve`, `/secrets/save`, and `/secrets/cancel` require exact
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
At most four environment nodes start concurrently. Jobs count toward this limit.

Each gateway permits 256 connections and in-flight requests. Upstream response
headers and WebSocket handshakes have a 10-second deadline. Active streams do not.
Control bodies and responses have a 1 MiB limit. The daemon permits 32 active
requests, including at most 16 waits, with two slots reserved for cleanup.

At most 128 IDs can be selected or required per attempt. Metadata listing returns
up to 128 names with `truncated`. The encrypted payload has a 16 MiB limit.
SQLite write contention waits at most three seconds before returning `BUSY`.
Optional Keychain access permits four helpers and 32 queued operations. Reads have a 10-second deadline. Interactive writes have 30 seconds.

Forms expire after five minutes, with eight pending/saving forms and 32 recent
results. Browser launches are limited to one per second. A save has a 30-second
deadline and retains partial or uncertain outcomes. Ordinary status and preview
traffic never returns keystore values.

After a lost response to start, replace, cancel, stop, or delete-data, read `get` or `list` before another attempt.
A transport failure does not prove that the original operation failed.

## Local dashboard operations

`previewhost dashboard` opens a local management page for automatic project owners.
See [Dashboard](dashboard.md) for its controls and [dashboard security](security.md#local-dashboard) for browser authorization and storage.

The authenticated owner client also supports:

- `remove(name, attemptId)`: remove an inactive entry and its bounded history. Supply
  its latest attempt ID, or `null` for a private request without an attempt. Active
  work, pending secret forms, retained data, and incomplete cleanup block removal.
  Removing the last entry closes an automatic owner and ends dynamic approvals.
  Source files and saved secrets remain. `remove()` clears an empty project entry.
- `describe(name, attemptId)`: redacted requested configuration for a retained attempt,
  including secret reference metadata without checking keystore presence.
- `startAgain(name, attemptId)`: rerun the current stopped or failed attempt's declaration
  through ordinary startup, source validation, and authorization. Existing active,
  busy, and cleanup checks still apply. No YAML is reloaded. The dashboard labels a
  stopped attempt **Start preview** and a failed attempt **Retry start**.
  Canceled attempts cannot use this operation.
- `saveConfiguration(name, attemptId)`: create root `preview.yaml` from that exact
  retained attempt through the existing validated saver. The automatic owner's project
  fixes the destination. Callers cannot supply a path or a replacement spec. Returns
  `{ file, externalSources }` and does not start, stop, or replace an application.
- `secretsList()`: bounded request summaries, including requests made before preview startup.
- `secretsOpen(id)`: reopen only an idle pending private form through the native launcher.
  It does not approve access, check values, or revive canceled/expired requests.

`stop(name, { expected: { active, candidate, latest } })` optionally checks the exact
observed attempt IDs (or `null`) before changing state. A mismatch returns
`STALE_ATTEMPT`. The dashboard always supplies this guard. CLI and MCP calls can omit this guard. MCP forwards it when supplied.

The sidebar and overview share the preview action menu. Search remains set when
opening details. Status filters and active-first ordering keep running work easy to find.
Discovery reads owners in bounded pages; an unavailable owner does not hide others.

**Delete data** confirms the exact environment and managed databases without restarting.
It requires a stopped preview. Its optional `expected` guard contains the latest
`attemptId` and resource list; `attemptId: null` identifies retained data with no attempt.
The dashboard always supplies this guard. External databases and user secrets are untouched.

After clean owner shutdown, the existing private connection file keeps the project path,
data directory, and Docker socket only when managed data remains. Offline status comes
from the existing database ownership records. It does not restore configuration, logs,
execution permission, or private approvals. Start through the agent or CLI to run again.
Offline deletion and removal use the same project lock as owner startup. An unreachable
live connection never qualifies for offline data deletion.

Every dashboard entry offers **Recheck status** and **Remove entry**. For an unavailable
owner, removal requires the recorded process to be absent, unchanged connection metadata,
and no retained data or cleanup records. The project and data locks stay held through removal.
The user must also confirm that application processes have stopped; Previewhost cannot
verify orphaned native processes from the connection record alone. Missing or invalid
data-location metadata blocks removal. This operation only removes the connection file.

CLI management also works when the registered source directory no longer exists:

```sh
previewhost projects
previewhost list --project /absolute/worktree/path
previewhost stop app --project /absolute/worktree/path
previewhost delete-data app --project /absolute/worktree/path --allow-exec
previewhost remove app --project /absolute/worktree/path
```

`projects` lists recorded paths without contacting owners; `recorded` does not mean running.
Offline deletion requires `--allow-exec`. For a running owner, use its existing permission
settings; omit the flag if it already has execution permission.
Offline CLI deletion also needs macOS automatic unlock. Otherwise, unlock Secret Manager
in the dashboard and use **Delete data** there. A locked keystore blocks deletion before any data changes.
After offline data deletion,
use `previewhost remove --project /absolute/worktree/path` to clear the empty project entry.
No removal operation deletes source files, saved secrets, or the permanent project lock.

Dashboard **Reset data** confirms the managed resource list, then calls guarded Stop,
guarded `deleteData`, and `startAgain` in order. It restarts the serving configuration
when available. Otherwise it uses the latest stopped or failed attempt. It starts only
after deletion succeeds. A canceled attempt without a serving app is not resettable.

A startup failure uses ordinary error reporting and Retry start. It does not repeat
deletion. After a lost response, inspect the current state before resetting again.

Declarations and logs remain bounded owner memory. They are unavailable after owner
shutdown or history eviction. Start again can allocate a different URL and keeps
managed data. An authorized agent can start a preview again after you stop it.
In the dashboard, Retry start creates no private setup request. It does not bypass secret approval or keystore unlock.

Saving keeps secret/input references unexpanded. It never reads keystore values or
exports the raw declaration through the dashboard response. Sources inside the project
become relative paths. External sources keep absolute paths and appear in `externalSources`.
If either default filename exists, saving returns `ALREADY_EXISTS` without overwriting it. Directories and symlinks also block saving.

An expired attempt cannot be reconstructed from status. An owner without a project
directory cannot use this operation. Save the original spec through CLI/MCP or the library.

The file is future input, not a configuration change applied to the running preview.
Declared literal values remain part of the recipe. Saving does not certify that arbitrary
strings contain no secrets.

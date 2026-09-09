# Ownership, security, and recovery

## Ownership

The runtime owns its gateways, static file servers, native process groups,
supervisors, and configured database containers.
An embedded application owns the runtime lifetime.
The foreground daemon owns previews for its CLI and MCP clients.

A client disconnect leaves daemon previews active.
Stop and normal shutdown close owned applications and containers.
Database volumes and credentials remain until explicit data deletion.

Each environment owns its managed databases. Active and candidate applications
share those databases during replacement. Candidate failure preserves the active
application. A first-start failure stops containers and preserves data.
Application writes and migrations do not roll back with route replacement.

The caller owns source directories and dependencies. Sources remain live.
An edit can affect the active server before replacement.
Separate prepared directories are necessary for source isolation.

Attached HTTP servers, PostgreSQL, and Redis remain external resources.
previewd closes its connections but does not stop or delete an attached service.

## Authority

The daemon binds its control listener to `127.0.0.1`.
Control requests require a random bearer token, the exact Host header, and no
Origin header. Preview listeners contain no control routes.
Private secret forms use separate browser authorization, described below.

The token file uses mode 0600 in an owner-only directory.
previewd rejects unsafe permissions, wrong ownership, symlinks, and non-regular files.
Anyone who can read the token has full daemon authority.
The token remains after shutdown so configured clients can reconnect.

Before token access, the daemon excludes its canonical parent directory from
static previews in that runtime, including resolved aliases.
Embedded owners can register private directories with `runtime.protectDirectory(path)`.
Protection remains for the runtime lifetime and blocks access through existing
static previews. It does not protect hard links, undo earlier exposure, or
restrict files served by application code.

Public preview URLs have no bearer authentication.
Other local users and applications can request preview content.
On a shared machine, keep private production data out of previews.

Allowed roots constrain source selection and static file access.
They do not constrain native command behavior.
`--allow-exec` permits ordinary execution as your user, managed database operations,
and explicit data deletion/recovery. Commands can access your files, network
resources, and credentials. This permission does not provide a sandbox.

Without host authorization, the runtime denies commands, managed databases,
data deletion, and exceptional recovery. MCP arguments cannot grant this authority.
Embedded applications can use an approval UI through `authorize`.
MCP host approvals apply separately.

`RuntimeOptions.inputs` supplies the values available to `{fromEnv: NAME}`.
`serve --env NAME` selects them once at startup.
A spec cannot select arbitrary host environment values.
Only the service with the binding receives the selected value.
PostgreSQL probes ignore ambient PG credentials and `.pgpass`.

`RuntimeOptions.secretIds` and repeated `--secret ID` select exact user Keychain
entries. Any execution-authorized client can bind a selected ID to its supplied code.
These selections provide no isolation between clients.
The binding limits which service receives a value. It does not establish trust
in the receiving code.

Static previews reject traversal, hidden paths, escaping symlinks, special files,
and directory listings. They exclude the private data directory and its resolved aliases.
Attachments connect only to IPv4 loopback.
These checks do not isolate hostile filesystem changes by another same-user process.

## Native processes

macOS commands run in a separate process group with an IPC-connected supervisor.
Before execution, the runtime checks that group.
After HTTP readiness, it checks the selected port's group ownership and loopback binding.
A port number alone never authorizes process termination.

The supervisor starts cleanup after command exit or owner disconnect.
It sends SIGTERM, then SIGKILL after a short grace period.
The runtime checks group absence before it reports successful cleanup.

A command can escape its group through a new session.
The supervisor does not provide a security sandbox.
The listener check covers the selected preview port.
It does not check every additional listener that application code opens.

## Recovery

Application attempts and routes remain in memory.
Restart does not restore native previews or adopt old processes.

After unexpected owner exit, the supervisor detects IPC loss and stops its group.
If the supervisor fails first, the runtime checks recorded process identity before fallback signaling.
A changed process title can prevent that match.
Normal cleanup through a live supervisor still works.

If ownership cannot be established, previewd reports `CLEANUP_INCOMPLETE` and retains the cleanup handle.
The name remains unavailable for replacement until `stop` completes cleanup.
A fresh daemon cannot recover native handles from the previous runtime's memory.

If both owner and supervisor die before cleanup, remaining processes can require manual inspection.
previewd does not infer their ownership after restart.
See [cleanup recovery](troubleshooting.md#replacement-or-cleanup-is-incomplete).

## Database ownership and recovery

Managed PostgreSQL/Redis require macOS Keychain, local Docker Engine, cached
`postgres:17-alpine`/`redis:7-alpine` images, and an explicit private data directory.
previewd does not pull images, create networks, use remote Engines, or change Docker contexts.

The data directory uses mode 0700 and records use mode 0600.
Schema 2 records retain resource identities, credential references, and pending mutations.
Generated passwords use individual Keychain items in an internal namespace.
User-secret commands cannot read or edit those items.

A lifetime kernel lock permits one owner per data directory.
The lock uses a permanent inode. Deleting a stale PID file cannot transfer ownership.
Before mutation, previewd checks the Engine identity, exact objects, and reserved ownership labels.
Friendly names or prefixes alone never authorize deletion.

Credentials reach managed containers through stdin, without container environment
variables or command arguments. Applications receive selected connection URLs.
The local account and Docker administrator still control these resources.

### Credentials and backups

On authorized open, previewd migrates schema 1 records by copying and checking
each password before it atomically saves the reference-only record.
A conflict or failed copy preserves the original record.
Retry compares exact values and never rotates the database password.
Explicit schema 1 deletion also removes identifiable partial migration copies.

For a new database, previewd stores and checks its password before it saves the
owner record and requests Docker creation. A crash before record creation can
leave an unused Keychain item. No Docker data exists at that point.
Keychain and filesystem writes do not share a transaction.
Missing retained credentials block database open without password or volume regeneration.

A data-directory backup does not contain schema 2 passwords.
Back up or transfer the Keychain separately.
Old schema 1 backups can contain plaintext passwords.
previewd provides no credential export or automatic synchronization.

### Stop and data deletion

Normal stop removes owned containers and preserves volumes and credentials.
Authorized `deleteData` removes a stopped environment's owned data.
It excludes source directories, external databases, images, caches, and networks.

After Docker removal, previewd records the pending credential deletion before it
calls Keychain. An unknown result remains pending for an explicit retry.
Stop and daemon shutdown remain available. The next owner permits deletion retry
and blocks database reopen until it completes.
New databases use fresh credential references, so late deletion cannot target a
new database with the same name.

### Interrupted Docker operations

After abrupt owner death, Docker containers can remain active.
The next owner locks the directory and checks records and Engine identity.
It removes owned containers, preserves volumes, and waits for an explicit start.
Retained names and cleanup errors appear in `get` and `list`.

An Engine request can complete after its caller disconnects.
previewd records the intended mutation before dispatch and awaits its outcome
before ordinary cleanup. A missing object alone does not prove that an uncertain
creation failed.

Unresolved creation retains its record and reports `CLEANUP_INCOMPLETE`.
After an operator restarts the actual local Engine, `afterEngineRestart: true`
requests authorized recovery. The flag asserts that the Engine restart occurred. It does not restart Docker.
Normal stop, cancel, and shutdown do not set the flag automatically.

Unsafe records, conflicting ownership, or a changed Engine prevent cleanup.
Partial cleanup retains the remaining identities.
Corrupt or unsafe records prevent startup for that data directory and remain
intact for repair. A failed close retains ownership for cleanup retry.
A successful close releases the lock and is safe to repeat.
See [database recovery](troubleshooting.md#database-data-or-recovery-is-incomplete) for operator steps.

## Logs and secrets

Status and inspect omit explicit environment values.
Native logs redact nonempty supplied values and their URL-encoded forms across
output chunks. Short values can remove ordinary text.
A short log tail can remain buffered until another chunk or stream completion.

Environment inspection shows binding names without resolved values.
Redaction includes database connection URLs and credential components for each consumer.
Attempt logs include service prefixes and retain a bounded tail.

Redaction cannot detect every secret. Application files, transformed values,
arguments, third-party output, and HTTP responses can expose values.
Keep secrets out of command arguments. Read logs only in trusted local clients.

## Stored secrets and private entry

User entries use individual, nonsynchronizing items in the default user Keychain.
The packaged Security.framework helper addresses exact service/account pairs.
It supports metadata, read, atomic add-if-absent, update-in-place, and exact deletion.
It does not grant access to all applications.

Runtime and MCP reads cannot display an OS prompt.
Explicit owner writes can request an OS access decision.
There is no plaintext fallback or decrypted value cache.

The helper contains arm64 and x86_64 code for macOS 13 or later.
It has an ad hoc signature with identifier `dev.previewd.keychain`.
Package updates or architecture changes can require approval for that helper
again in Keychain Access. The signing identifier alone does not preserve access.
An identical binary can move without a code identity change.
The signature does not authenticate JavaScript callers or isolate same-user processes.

Values pass through pipes as base64. This encoding does not encrypt them.
Helper input, output, and execution time have limits.
Timeout or cancellation terminates the helper but cannot prove that a dispatched
Keychain mutation failed. Results retain that uncertainty.

Private setup uses a public request ID and a separate, unpredictable write grant
in daemon memory. Owner authorization fixes the mode, names, sources, and recipients.
Missing-value setup only adds absent entries. Edit updates one existing entry.
Neither operation authorizes execution or starts an application.

The daemon sends the private URL directly to the system browser launcher.
MCP, CLI output, status, and unauthenticated HTML do not receive it.
The page removes its fragment and holds the grant only in memory.
It sends the grant in a header to the exact origin.
Browser history and the OS launch briefly hold the private URL.
The launcher receives no ambient credential values.

The form uses no cookies, browser storage, external assets, or telemetry.
Host/Origin checks, JSON input, restrictive CSP, and scoped single-use grants
protect writes. Labels render as text.
Save validates all fields and consumes the grant before writes.
Partial results retain completed writes without rollback.
After save, the client must check status and retry startup.

The owner browser holds entered values and the private grant.
Agents that can inspect that browser, execute same-user code, or modify the
receiving application remain outside this privacy boundary.
Masked fields reduce incidental display. They do not isolate hostile agents.

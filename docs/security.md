# Ownership, security, and recovery

## Ownership

The runtime owns its gateways, static file servers, native supervisors, native
process groups, and explicitly configured database containers. An embedded
application owns the runtime lifetime. The foreground daemon owns previews for
all connected clients.

MCP and CLI clients own only their requests. Client disconnects do not stop
daemon previews. Explicit stop and normal shutdown close owned applications and
containers. Database volumes remain until explicit data deletion.

Each environment owns its databases once. Active and candidate application
attempts share those databases. Failed replacement stops only candidate
applications. A first-start failure stops its containers and preserves data.

The caller owns source directories and installed dependencies. Sources remain
live. An edit can affect the active server before replacement. Separate prepared
directories are necessary when source isolation matters.

Attached HTTP servers, PostgreSQL, and Redis remain external resources. previewd
closes its own connections but never stops or deletes an attached service.

## Authority

The daemon binds its control listener to `127.0.0.1`. Ordinary control operations
require a random bearer token, exact Host header, and no Origin header. Private
secret-form operations use the separate browser authority described below. No CORS is enabled.
Preview listeners contain no control routes.

The token file uses mode 0600 in an owner-only directory. previewd rejects unsafe
permissions, wrong ownership, symlinks, and non-regular token files.
Before creating or reading the token, the daemon excludes its canonical parent
directory from current and future static previews in that runtime, including aliases.
Embedded owners can add private directories with `runtime.protectDirectory(path)`.
Protection only grows for the runtime lifetime; an existing preview of that
directory returns forbidden content after registration. This is not a machine-wide
registry, a hard-link boundary, or protection for files served by application code.
It cannot undo exposure before the owner registered a private directory.
The token remains after shutdown so configured clients can reconnect.
Anyone who can read the token has the full daemon authority.

Public preview URLs have no bearer authentication. Other local users and local
applications can request preview content. Do not use this interface to serve
private production data on a shared machine.

Allowed roots constrain source selection and static file access. They do not
contain native command behavior. `--allow-exec` grants ordinary user-level code
execution within the selected working directory. It also grants managed database
operations and explicit data deletion/recovery. That code can access files,
network resources, and credentials available to the user.

The runtime denies commands, managed databases, data deletion, and exceptional
recovery without host authorization. An MCP argument cannot grant this authority.
An embedding application can use its existing approval UI through `authorize`.
MCP host tool approvals are an additional host policy.

`RuntimeOptions.inputs` contains the exact values available to `{fromEnv: NAME}`
bindings. `serve --env NAME` selects them once at startup. A spec cannot select
arbitrary host environment values. Only the consuming service receives a bound
value. PostgreSQL probes do not use ambient PG credentials or `.pgpass`.

`RuntimeOptions.secretIds` and repeated `--secret ID` select exact user Keychain
entries. Every execution-authorized client can bind any selected ID to code it
supplies. Selection is the daemon's boundary, with no per-client isolation.
Bindings prevent accidental overdelivery; they do not make receiving code trustworthy.

Static serving rejects traversal, hidden paths, escaping symlinks, special files,
and directory listings. It also excludes the owner's private data directory,
including resolved aliases beneath an allowed static source. Attachments connect
only to IPv4 loopback.
These checks do not provide isolation against hostile same-user filesystem races.

## Native processes

macOS commands run in a separate process group with an IPC-connected supervisor.
The runtime verifies that group before command execution. After HTTP readiness,
it verifies that the selected port belongs to the group and binds only to loopback.
It never kills a process because it occupies a port.

The supervisor starts cleanup when the command exits or its owner disconnects.
It sends SIGTERM, then SIGKILL after a short grace period. The runtime verifies
group absence before it reports successful cleanup.

A command that deliberately creates a new session can escape the process group.
The supervisor is not a security sandbox. The listener check covers the selected
preview port, not arbitrary additional listeners opened by application code.

## Recovery

Application attempts and routes stay in memory. There is no native process
adoption, automatic application restart, or persistent route file. The token
file contains control authentication data.

If the owner exits unexpectedly, the supervisor detects IPC loss and stops its
group. If the supervisor fails first, the runtime signals only a group whose
live member identity still matches its recorded identity.

A changed process title can prevent that identity match after supervisor loss.
Normal supervisor-owned shutdown still works. The runtime conservatively refuses
fallback signaling when it cannot establish the recorded identity.

If ownership cannot be verified, previewd reports `CLEANUP_INCOMPLETE` and retains
the cleanup handle. The name remains unavailable for replacement. A successful
`stop` retries cleanup. A fresh daemon cannot recover native handles from memory.

If both owner and supervisor die before cleanup, remaining processes can require
manual inspection. previewd does not guess process ownership after restart.
See [troubleshooting](troubleshooting.md) for the repair procedure.

## Database ownership and recovery

Managed PostgreSQL/Redis require macOS Keychain, local Docker Engine, cached
`postgres:17-alpine`/`redis:7-alpine` images, and an explicit private data directory.
previewd does not pull images,
create networks, use a remote Engine, or change Docker contexts.

The private data directory uses mode 0700 and records use mode 0600. Schema 2
records retain exact resource identities, credential references, and pending
mutations. Generated passwords live in individual Keychain items in an internal
namespace. User-secret commands cannot read or edit that namespace.

Schema 1 records remain supported. On an authorized open, migration copies and
verifies every existing password before atomically publishing the reference-only
record. A conflict or failed copy preserves the original record. Retry compares
exact values; it never rotates the database password. Explicit schema 1 deletion
also removes identifiable partial migration copies.

New databases get fresh random credential references. The password is stored and
verified, then its owner record is published before Docker creation. A crash before
publication can leave an unreferenced Keychain item; no Docker data exists yet.
There is no transaction across Keychain and the filesystem and no broad orphan sweep.
Missing retained credentials block open without regenerating a password or volume.

A data-directory backup alone no longer contains schema 2 passwords. Keychain
backup/transfer is separate. Old backups can still contain schema 1 plaintext.
previewd provides no recovery export or automatic credential synchronization.

A lifetime kernel lock permits one owner per data directory. previewd keeps the
lock on a permanent inode and never uses stale PID-file deletion for ownership.
It verifies the local Engine identity, exact objects, and reserved ownership labels
before mutation. It never deletes resources by a friendly name or broad prefix.

Credentials reach fixed containers through stdin rather than configured container
environment or command arguments. Applications receive selected connection URLs.
The local account and Docker administrator still control those resources.

Normal stop removes owned containers and preserves their volumes and credentials.
Explicit `deleteData` removes only stopped, verified owned data after authorization.
It excludes source directories, external databases, images, caches, and networks.
After Docker removal, deletion persists the exact credential-removal intent before
calling Keychain. An unknown result keeps that intent for a later explicit retry.
Stop/startup preserve credential-only debt without reading Keychain. Close joins
native work and can release the data lock with that durable debt. The next owner
permits explicit deletion retry and blocks database reopen. Fresh references keep
a late old removal from targeting a newly created database with the same name.

After abrupt owner death, Docker containers can remain alive until recovery.
The next owner locks the directory, checks records and Engine identity, removes
verified owned containers, and preserves volumes. It waits for an explicit start.
Retained names and cleanup errors appear in `get` and `list`.

An interrupted Engine request can complete after its caller disconnects. previewd
records the intended action before dispatch. It joins a dispatched mutation
before ordinary cleanup. A missing object alone does not prove that an uncertain
creation failed.

Unresolved creation retains the record and reports `CLEANUP_INCOMPLETE`. After
the operator restarts the actual local Engine, an explicit stop with
`afterEngineRestart: true` requests authorized recovery for the absent creation.
The flag confirms an external operator action. It never restarts Docker.
Normal stop, cancel, and shutdown never set it automatically.

Unsafe records, conflicting ownership, or a changed Engine fail closed. Partial
cleanup retains the remaining identities. There is no broad prune or automatic
record deletion to hide an unresolved error.

An unsafe or corrupt retained record prevents that data-directory owner from
starting. All records remain intact for repair. A failed close keeps ownership
available for normal stop or explicitly authorized recovery; successful close
releases the lock and remains safe to repeat.

## Logs and secrets

Status and inspect responses omit explicit environment values. Native logs redact
nonempty supplied values and their URL-encoded forms, including split chunks.
Short values can remove ordinary text. A short log tail can remain buffered until
another chunk or stream completion permits safe redaction.

Environment inspection shows binding names without resolved values. Database
connection URLs and credential components join the redactions for their consumers.
One bounded attempt log contains service prefixes. Schema 2 private data records
contain references to the credentials needed to reopen the same owned data.

Redaction is not a complete secret detector. Application files, transformed values,
arguments, third-party output, and HTTP responses can expose secrets.
Avoid secrets in command arguments. Read logs only in trusted local clients.

## Stored secrets and private entry

User entries are individual, nonsynchronizing items in the default user Keychain.
The packaged Security.framework helper uses exact service/account queries and
supports metadata, read, atomic add-if-absent, update-in-place, and exact deletion.
It does not broaden item access to all applications. Runtime/MCP reads cannot
display an OS prompt. Explicit owner writes can request an OS access decision.
There is no plaintext fallback, custom vault, master key, or decrypted value cache.

The helper is a universal arm64/x86_64 binary, built for macOS 13 or later and
ad hoc signed as `dev.previewd.keychain`. Package updates or a switch between
architecture slices can require the owner to approve that specific helper again
in Keychain Access. Keeping the signing identifier alone does not preserve access.
An identical binary can move without changing its code identity. A signed helper
does not authenticate its JavaScript caller or isolate another same-user process.
Values travel as byte-preserving base64 in pipes; this is encoding, not encryption.
Helpers receive only normal OS environment inputs and have bounded work and output.
Timeout/cancel kills and reaps the helper but cannot prove an already-dispatched
Keychain mutation failed. Results retain that uncertainty.

Private setup uses a public request ID plus an independent, unpredictable write
capability in bounded daemon memory. Owner authorization fixes its mode, names,
sources, and recipients. Missing setup only adds absent items; edit updates one
existing item. Neither operation grants execution or stores a captured execution job.

The daemon gives the private URL directly to the system browser launcher. MCP,
CLI output, status, and unauthenticated HTML never receive it. The page removes
its fragment immediately, keeps authority only in memory, and sends it in a header
to its exact origin. Browser history/UI and the OS launch briefly hold that URL.
The launcher receives no ambient credential environment values.

The form has no cookies, browser storage, external assets, or telemetry. Exact
Host/Origin checks, JSON content, a single authority header, restrictive CSP, and
one-use scoped grants protect mutation routes. Labels render as text. Save validates
all fields, consumes the grant before writes, and reports partial outcomes without
rollback. Successful save does not start an app; the client must retry normally.

The owner browser necessarily holds entered values and the private request.
An agent that can inspect that browser, execute same-user code, or modify the
receiving application remains outside this privacy boundary. Masked fields reduce
incidental display; they do not provide hostile-agent isolation.

## Deliberate scope

previewd provides HTTP/1.1 proxying, WebSockets, streaming, static files, native
commands, and fixed local PostgreSQL/Redis resources. It does not manage Git
worktrees, source snapshots, dependency setup, arbitrary application containers,
Compose files, TLS certificates, DNS infrastructure, tunnels, or cloud deployments.

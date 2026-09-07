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

The daemon binds its control listener to `127.0.0.1`. It requires a random bearer
token, exact Host header, and no Origin header. It does not enable CORS.
Preview listeners contain no control routes.

The token file uses mode 0600 in an owner-only directory. previewd rejects unsafe
permissions, wrong ownership, symlinks, and non-regular token files.
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

Managed PostgreSQL/Redis require macOS, local Docker Engine, cached
`postgres:17-alpine`/`redis:7-alpine` images, and an explicit private data directory.
previewd does not pull images,
create networks, use a remote Engine, or change Docker contexts.

The private data directory uses mode 0700 and records use mode 0600. Records
retain exact resource identities, generated credentials, and pending mutations.
Credentials are plaintext under those account permissions. There is no vault
or encryption guarantee.

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
One bounded attempt log contains service prefixes. Private data records retain
only credentials needed to reopen the same owned data.

Redaction is not a complete secret detector. Application files, transformed values,
arguments, third-party output, and HTTP responses can expose secrets.
Avoid secrets in command arguments. Read logs only in trusted local clients.

## Deliberate scope

previewd provides HTTP/1.1 proxying, WebSockets, streaming, static files, native
commands, and fixed local PostgreSQL/Redis resources. It does not manage Git
worktrees, source snapshots, dependency setup, arbitrary application containers,
Compose files, TLS certificates, DNS infrastructure, tunnels, or cloud deployments.

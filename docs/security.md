# Ownership, security, and recovery

## Ownership

The runtime owns its gateways, static file servers, native supervisors, and native
process groups. An embedded application owns the runtime lifetime. The foreground
daemon owns previews for all connected clients.

MCP and CLI clients own only their requests. Client disconnects do not stop
daemon previews. Explicit stop, daemon shutdown, and owner termination release
the resources that previewd owns.

The caller owns source directories and installed dependencies. Sources remain
live. An edit can affect the active server before replacement. Separate prepared
directories are necessary when source isolation matters.

Attached servers remain external resources. previewd closes its proxy connections
on stop but does not signal an attached server.

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
execution within the selected working directory. That code can access files,
network resources, and credentials available to the user.

The runtime denies native commands without host authorization. An MCP argument
cannot enable execution. An embedding application can use its existing approval
UI through `authorize`. MCP host tool approvals are an additional host policy.

Static serving rejects traversal, hidden paths, escaping symlinks, special files,
and directory listings. Attachments connect only to IPv4 loopback.
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

Runtime state stays in memory. There is no database, process adoption, automatic
restart, or persistent route file. The token file contains authentication data,
not runtime recovery data.

If the owner exits unexpectedly, the supervisor detects IPC loss and stops its
group. If the supervisor fails first, the runtime signals only a group whose
live member identity still matches its recorded identity.

A changed process title can prevent that identity match after supervisor loss.
Normal supervisor-owned shutdown still works. The runtime conservatively refuses
fallback signaling when it cannot establish the recorded identity.

If ownership cannot be verified, previewd reports `CLEANUP_INCOMPLETE` and retains
the cleanup handle. The name remains unavailable for replacement. A successful
`stop` retries cleanup. A fresh daemon cannot recover those in-memory handles.

If both owner and supervisor die before cleanup, remaining processes can require
manual inspection. previewd does not guess process ownership after restart.
See [troubleshooting](troubleshooting.md) for the repair procedure.

## Logs and secrets

Status and inspect responses omit explicit environment values. Native logs redact
nonempty supplied values and their URL-encoded forms, including split chunks.
Short values can remove ordinary text. A short log tail can remain buffered until
another chunk or stream completion permits safe redaction.

Redaction is not a complete secret detector. Application files, transformed values,
arguments, third-party output, and HTTP responses can expose secrets.
Avoid secrets in command arguments. Read logs only in trusted local clients.

## Deliberate scope

previewd provides HTTP/1.1 proxying, WebSockets, streaming, static files, and native
commands. It does not manage Git worktrees, source snapshots, dependency setup,
Docker, TLS certificates, DNS, tunnels, cloud deployments, or model credentials.

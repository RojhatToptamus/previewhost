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
previewhost closes its connections but does not stop or delete an attached service.

## Authority

The daemon binds its control listener to `127.0.0.1`.
Control requests require a random bearer token, the exact Host header, and no
Origin header. Preview listeners contain no control routes.
Private secret forms use separate browser authorization, described below.

The token file uses mode 0600 in an owner-only directory.
previewhost rejects unsafe permissions, wrong ownership, symlinks, and non-regular files.
Anyone who can read the token can call every daemon operation.
The token remains after shutdown so configured clients can reconnect.

Before token access, the daemon excludes the token directory from static previews.
This also blocks symlinks to that directory within the same runtime.
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
`serve --env NAME`, or the same project-owner launch flag, selects them once at startup.
A spec cannot select arbitrary host environment values.
Only the service with the binding receives the selected value.
PostgreSQL probes ignore ambient PG credentials and `.pgpass`.

`RuntimeOptions.secretIds` and repeated `--secret ID` select exact user keystore
entries. Any execution-authorized client can bind a selected ID to its supplied code.
Private setup can add names only after the owner approves them through its browser capability.
Approval revalidates source scope and preserves the 128-name bound. It lasts until owner shutdown.
The exact name identifies one shared keystore value across owners; no worktree prefix is added.
These selections provide no isolation between clients.
The binding limits which service receives a value. It does not establish trust
in the receiving code.

Static previews reject traversal, hidden paths, escaping symlinks, special files,
and directory listings. They exclude the private data directory and its resolved aliases.
Attachments connect only to IPv4 loopback.
These checks do not isolate hostile filesystem changes by another same-user process.

Global MCP registration requires client confirmation of each canonical project and its source directories through `preview_access`.
An agent-supplied path is a request, never authorization. Your home directory and its parents are rejected.
Confirmation is bound to the exact server-held request, expires after five minutes, and cannot be replayed after completion.
Denial, cancellation, malformed confirmation, or disconnect grants no connection access.
A new connection needs approval again; already running owners and their private-secret approvals remain active.

Approved source extensions use the authenticated owner control API and its existing authorization callback.
The runtime owns the current source-root set; extensions do not restart it or alter its secret grants.
Fixed daemons cannot extend their configured roots through this API.
Startup and private setup restore the approved connection’s source grants after a clean owner restart; secret access still needs reapproval.

Registrations with explicit `--root` or `--project` retain the existing root and registered-Git-worktree restrictions.
All automatic calls select a project independently; a shared connection has no trusted chat identity.
Approval allows that connection to manage the selected project's previews, not only one chat's calls.
Source checks do not sandbox authorized native commands or create new execution or secret authority.
MCP configuration files and submitted sources must resolve within approved roots; symlink escapes are rejected.
Direct CLI/library file input retains the caller's filesystem authority.

## Automatic project owners

Automatic owners use the existing runtime, bearer-token client and daemon.
The canonical Git worktree root (or explicit project directory) selects a private directory under `~/.local/share/previewd/projects`.
A SHA-256 digest of that path gives it a fixed-length filesystem address. It is not a configuration signature or permission grant.
A permanent Darwin kernel lock prevents concurrent owners for one project. It is held through runtime cleanup.
The private connection file contains endpoint, PID, project path, data directory, and any explicit Docker socket. It is published after listener readiness.
Clients authenticate with the existing private token, then verify the responding project and requested launch options.
The file cannot authorize a new owner or restore browser-added name grants.

Cold startup uses current CLI arguments or MCP registration options. `--allow-exec` retains its broad trusted-owner authority.
Omitted options can reuse a living owner; incompatible explicit options are rejected without changing it.
Explicit endpoint/token mode never automatically starts or adopts an owner.
An idle owner remains alive so approvals and applications survive agent pauses and adapter disconnection.

Clean shutdown removes the endpoint and PID after runtime cleanup. If managed data remains,
the same file retains its location and project path. Otherwise the file is removed.
Stored credentials and managed data remain. These paths restore no execution or secret grants.
Offline status reads validated ownership records without Docker recovery or keystore access.
Explicit offline deletion holds the project lock, checks the selected resources, then reuses
the existing data owner’s deletion checks. The dashboard requires its private session and
confirmation; CLI offline deletion requires `--allow-exec`.
Offline deletion requires an unlocked keystore before it changes Docker resources. The dashboard uses its Secret Manager session; offline CLI deletion needs macOS automatic unlock.
Removing an entry is blocked while work, private setup, data, or cleanup remains.
An empty automatic owner closes after its last entry is removed, ending dynamic approvals.
A crash or failed cleanup keeps the connection record. An unreachable listener does not prove application cleanup.
Dashboard removal checks that the recorded PID is absent, the connection record is unchanged,
and validated managed-data records are empty. It holds both existing locks through removal.
The user must separately confirm that application processes have stopped; these checks do
not prove orphaned native-process cleanup. Unknown data locations block removal.
No process is stopped, data deleted, secret accessed, or authorization restored by removal.
Never kill a process based only on the recorded PID; it can have been reused. See [recovery](troubleshooting.md#the-client-cannot-find-the-daemon).

## Retained storage identifiers

The following storage identifiers are unchanged:

- The default token remains at `~/.local/share/previewd/token`.
- `--data-dir` and `dataDirectory` still select the exact directory supplied by the owner.
- Docker names retain `previewd-`. Ownership labels retain `io.previewd.*`.
- Managed PostgreSQL retains its `previewd` user and database.

The [Keystore access rules](#stored-secrets-and-private-entry) still apply to package updates.
The internal `x-previewd-hops` header also remains unchanged so old and new gateways detect loops together.

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
If the supervisor fails first, the runtime checks the recorded process identity before it stops the group itself.
A changed process title can prevent that match.
Normal cleanup through a live supervisor still works.

If ownership cannot be established, previewhost reports `CLEANUP_INCOMPLETE` and retains the cleanup handle.
The name remains unavailable for replacement until `stop` completes cleanup.
A new daemon lacks the records needed to retry cleanup of those processes.

If both owner and supervisor die before cleanup, remaining processes can require manual inspection.
previewhost does not infer their ownership after restart.
See [cleanup recovery](troubleshooting.md#replacement-or-cleanup-is-incomplete).

## Database ownership and recovery

Managed PostgreSQL/Redis require macOS, an unlocked keystore, local Docker Engine, cached
`postgres:17-alpine`/`redis:7-alpine` images, and an explicit private data directory.
previewhost does not pull images, create networks, use remote Engines, or change Docker contexts.

The data directory uses mode 0700 and records use mode 0600.
Schema 3 records retain resource identities, credential references, and pending mutations.
Generated passwords use the internal database namespace in the encrypted keystore.
User-secret commands cannot read or edit those items.

A lifetime kernel lock permits one owner per data directory.
The lock uses a permanent inode. Deleting a stale PID file cannot transfer ownership.
Before mutation, previewhost checks the Engine identity, exact objects, and reserved ownership labels.
Friendly names or prefixes alone never authorize deletion.

Credentials reach managed containers through stdin, without container environment
variables or command arguments. Applications receive selected connection URLs.
The local account and Docker administrator still control these resources.

### Credentials and backups

Earlier data record formats are unsupported. Loading them fails before Docker cleanup or credential changes.
There is no migration path. See the [reset instructions](../README.md#reset-required-for-earlier-installations).

For a new database, Previewhost stores its password before publishing the owner record or requesting Docker creation.
A crash before record creation can leave an unused encrypted credential. No Docker data exists at that point.
Keystore and data-record writes do not share a transaction.
Missing retained credentials block database open without password or volume regeneration.

A data-directory backup contains credential references, not passwords.
A credential backup needs both the keystore directory and retained-data directories, copied with all owners, dashboards, and secret commands stopped.
Back up database contents separately. These directories do not contain Docker volume data.
The password must remain available separately. Previewhost provides no plaintext export or automatic synchronization.

### Stop and data deletion

Normal stop removes owned containers and preserves volumes and credentials.
Authorized `deleteData` removes a stopped environment's owned data.
It excludes source directories, external databases, images, caches, and networks.

After Docker removal, previewhost records the pending credential deletion before it
updates the keystore. An unknown result remains pending for an explicit retry.
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
previewhost records the requested change before it sends the Engine request.
It waits for the result before normal cleanup. A missing object alone does not prove that an uncertain
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
Attempt logs capture source identity separately from output and retain one bounded tail.
Filtering cannot relabel output; application text that imitates a prefix stays with its actual source.

Redaction cannot detect every secret. Application files, transformed values,
arguments, third-party output, and HTTP responses can expose values.
Keep secrets out of command arguments. Read logs only in trusted local clients.

## Stored secrets and private entry

One encrypted payload contains user secrets and internal database credentials.
The file is `~/.local/share/previewhost/keystore/secrets.sqlite`.
AES-256-GCM authenticates the payload. Each write uses a fresh 12-byte nonce.
Scrypt derives a 32-byte key from the password and a random 16-byte salt (`N=32768`, `r=8`, `p=1`).
SQLite stores only the encrypted payload and its salt, nonce, and authentication tag.
Its transactions serialize writers and recover interrupted commits. POSIX directories use mode 0700 and files use mode 0600.
Windows uses the user's profile and its filesystem permissions.

Each owner and dashboard retains only its own unlock key. Each operation reads current stored values.
Closing the session clears its key buffer. JavaScript strings and application processes prevent a promise of complete memory erasure.
Unlocking does not grant reference access, source access, or execution authority.
Same-user native code is not isolated by this mechanism.

On macOS, “Remember unlock” stores one derived key in the default user Keychain under `dev.previewhost.unlock`.
The salt identifies that keystore's item. Earlier user/database Keychain namespaces are never read, modified, or deleted.
Automatic reads cannot display an OS prompt. Explicit remember/forget operations can request an OS access decision.
The existing helper uses bounded pipes, deadlines, and process cleanup. An interrupted OS write can have an unknown outcome.
The helper contains arm64 and x86_64 code and has an ad hoc signature. Updates can require renewed item access approval.
An unavailable helper or locked Keychain leaves password unlock available.
Windows and Linux use password unlock. No plaintext fallback or cross-platform credential dependency exists.

Forget removes automatic unlock for future sessions. Already unlocked sessions remain usable until shutdown.
Wrong passwords and damaged payloads never initialize a replacement store.
Creation requires an explicit request, password confirmation, and an empty store checked inside a transaction.

Private setup uses a public request ID and a separate, unpredictable write grant
in daemon memory. Owner authorization fixes the mode, requested names, sources, and declared recipients.
For unselected names, a private approval step adds access to the existing owner selection.
Unselected entries receive no keystore presence check before approval. Canceling later does not undo an earlier grant.
Missing-value setup only adds absent entries. Edit updates one existing entry.
Neither operation authorizes execution or starts an application.

The daemon sends the private URL directly to the system browser launcher.
MCP, CLI output, status, and unauthenticated HTML do not receive it.
The page removes its fragment and holds the grant only in memory.
It sends the grant in a header to the exact origin.
Browser history and the OS launch briefly hold the private URL.
The launcher receives no ambient credential values.

The form uses no cookies, external assets, or telemetry. It uses the dashboard’s shared
styles and bundled fonts. Only the theme preference uses `localStorage` (`previewhost.theme`),
separately for each local address. Secret values and private grants never enter browser storage.
Host/Origin checks, JSON input, restrictive CSP, and scoped single-use grants
protect writes. Labels render as text.
Save validates all fields and consumes the grant before writes.
Partial results retain completed writes without rollback.
After save, the client must check status and retry startup.

The owner browser holds entered values and the private grant.
Agents that can inspect that browser, execute same-user code, or modify the
receiving application remain outside this privacy boundary.
Masked fields reduce incidental display. They do not isolate hostile agents.


## Local dashboard

The optional dashboard serves fixed assets on numeric loopback. Geist fonts are bundled
locally and restricted by `font-src 'self'`; no font CDN is contacted.
Only the theme preference uses `localStorage` (`previewhost.theme`).
The browser receives a separate capability through the native launcher and removes it
from the URL immediately. The dashboard keeps it in per-tab `sessionStorage` to support reload.
Browser session restore may preserve this storage; tab closure is not a guaranteed
revocation boundary. Stopping the dashboard process ends the capability's authority.
If browser storage is unavailable, the fresh launch works only in page memory.
The React dashboard loads only bundled scripts and fonts. Its CSP permits the inline
presentation styles used by Radix and Sonner, but does not permit inline scripts,
external connections, framing, or form navigation.

Owner bearer tokens stay in the local dashboard process and never reach browser JavaScript.
The dashboard requires exact Host/Origin headers and authenticated JSON POST actions;
the existing owner control listener still rejects browser Origin headers.

Discovery validates private connection records and authenticates each owner identity.
It does not scan ports, launch owners, grant roots, or infer cleanup from an unreachable
endpoint. One unresponsive owner has a bounded read deadline and does not hide others.

Dashboard reset requires a confirmation of the environment and its managed databases.
It calls existing Stop, authorized data deletion, and Start again operations. Attempt IDs
and the managed resource list are checked for changes before deletion. Deletion must
succeed before startup is requested. Failed startup never retries deletion. These steps
are not a transaction: deleted data and job writes cannot be rolled back. External data
and user-secret entries are excluded from deletion; jobs retain their normal permissions.

The dashboard can reopen an owner’s pending private form. Secret Manager also lists
user-reference names and edits an existing entry in a dashboard dialog, without
requiring a running owner. Internal database entries are excluded.
The authenticated dashboard session may submit a replacement value to the keystore;
it cannot read stored values or grant runtime access. Values stay out of browser
storage, URLs, and responses. Cancel clears the field without a write. Saving uses
the existing update-only operation and never recreates a removed entry.
Editing changes future reads of the exact reference; it does not restart previews,
change bindings, or extend approvals. Agent setup still uses separate, expiring
private-form capabilities; no MCP or owner-control value-write operation is added.

Explicit configuration saving selects an exact retained attempt and writes only the
automatic owner's root `preview.yml`. It reuses source validation and exclusive file
creation; an existing file or symlink is never overwritten. Secret/input references
remain unexpanded. No resolved environment or raw declaration is returned to the browser,
and saving changes no running application. Literal strings originally supplied in a
spec remain literal strings; the saver is not a secret scanner.

Retry start reuses normal source, execution, and secret-access checks for the exact
current failed attempt. It neither retries canceled attempts nor opens private setup.

Logs retain existing best-effort redaction limits and are shown on request, never treated as HTML.

## Setup jobs

Jobs use the same source authorization, secret bindings, redacted logs, supervisor, and process-group cleanup as command services.
Once-only job intent and success are stored in the existing private owned-data record.
Failure or owner interruption cannot silently retry that job; an explicit rerun or data deletion is required.
Reruns require a stopped environment, its latest attempt ID, and normal start authorization.
The authorization callback receives `rerunJob` on that start request.
No process cleanup rolls back database writes. See [job lifecycle and recovery](jobs.md).

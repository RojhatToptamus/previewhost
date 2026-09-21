# Linux and Windows implementation decisions

Branch: `codex/cross-platform-support`. Original baseline: `4e46b46`.
Windows native, ownership, and private-storage tests have execution results on x64 and arm64. Full Windows workflow qualification remains incomplete.
This document distinguishes implementation decisions from verification results.

## Scope and shared behavior

The target is Node.js 22.23 or later on x64 and arm64.
CI targets macOS 15, Ubuntu 24.04, Windows Server 2025 x64, and Windows 11 arm64.
Windows 11 with Docker Desktop is the target for full Windows database verification.
Only local private storage is in scope. Network filesystems and synchronized storage need separate qualification.
Linux needs procps `ps` at `/bin/ps` and `lsof` at `/usr/bin/lsof`.
The existing macOS tool paths remain unchanged.

Project startup, offline management, database records, Docker requests, secret encryption, and log redaction remain shared.
The existing project and data locks still have separate owners and lifetimes.
Failed database cleanup retains its lock and records for retry.
Stop removes owned containers. Explicit deletion removes volumes and credentials.
No ownership database, lease timeout, polling service, or new record schema is introduced.

## 1. Windows process ownership

The runtime creates one unnamed Job Object per native resource.
Only the runtime owns its non-inheritable handle.
The job uses `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, without either breakaway flag.
Owner termination therefore closes the handle and requests termination of the supervisor and its job members.
See [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

The existing supervisor waits for configure and commit messages before application execution.
Its online message includes its Windows creation time.
The runtime opens the supervisor process and compares that creation time before job assignment.
Assignment must succeed before configuration and commit. Failure closes the empty job and stops the uncommitted supervisor.
The runtime never uses a PID tree or `taskkill` as cleanup authority.
Existing-job restrictions produce a startup error instead of an unowned launch.

Normal stop sends the existing IPC stop message and permits bounded output draining.
Windows cannot provide the existing Unix TERM semantics. The supervisor terminates its direct child, then exits.
The runtime terminates the entire job and polls its active-process count before closing the handle.
A deadline or observation failure retains the job handle and returns `CLEANUP_INCOMPLETE` for retry.
POSIX retains the existing TERM/KILL supervisor flow and identity-verified fallback.

Listener validation reads both Windows TCP owner tables and requires loopback binding and membership in the resource's exact job.
The selected listener never grants termination authority.
Job assignment, owner death, supervisor death, cancellation, descendants, and unrelated listeners require real Windows tests.
Job Objects remain process management, not a sandbox for hostile same-user code.

## 2. Private Windows storage

New private directories receive an explicit protected ACL during `CreateDirectoryW`, before any private contents exist.
The current user owns newly created private directories. The user, SYSTEM, and Administrators receive inherited full-access entries.
New files can use the process token's default owner. Elevated Windows execution produced administrator-owned files in hosted testing.
Validation accepts that owner only when it equals the current token owner and is the Administrators group. Other account owners remain rejected.
Existing ACLs are validated without repair. Unknown ACE forms and other principals fail closed.
Inspected files and directories must not be reparse points.
Inheritable entries are also checked, because later token and temporary-file creation depends on them.
Directories must propagate restricted entries to both files and subdirectories, without `NO_PROPAGATE`.
Separate inheritance entries and `INHERIT_ONLY` are permitted. Full-control rights are not required.
Without inherited entries, Windows can use the creator token's default DACL; see [new-object DACL rules](https://learn.microsoft.com/en-us/windows/win32/secauthz/dacl-for-a-new-object).
Existing token files, ownership records, locks, and the encrypted keystore receive their own checks.

The parent ACL alone does not prove that an existing child is private.
See [Windows file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).
The threat boundary remains other ordinary accounts. Administrators and same-user application code retain their existing authority.
POSIX retains UID, mode, file-type, link-count, and no-follow checks.
The Windows tests exercise new-directory inheritance, a publicly readable token, and a junction.
The x64 tests verify inherited ACLs, rejected broad access, rejected junctions, and rejection before token creation in non-inheritable directories.

## 3. Literal commands and environment names

Commands remain executable-plus-arguments arrays. Previewhost does not automatically enable a shell.
On Windows, direct `.cmd` and `.bat` commands receive an actionable error.
Callers can explicitly select `cmd.exe`, or run a JavaScript CLI through `node.exe` and its script path.
This preserves literal arguments without introducing a command-line escaping framework.
See [Node command execution](https://nodejs.org/api/child_process.html).

Windows environment keys are normalized to uppercase before merge.
Case-colliding explicit keys are rejected. An explicit `Path` correctly replaces inherited `PATH`.
The Windows ambient allowlist adds only `SYSTEMROOT`, `WINDIR`, `USERPROFILE`, `COMSPEC`, and `PATHEXT`.
Selected service values and generated `PORT`, `HOST`, and `PREVIEW_URL` retain their existing precedence.
The installed-package checker uses Node directly on Windows instead of assuming an executable Unix npm shim.

## 4. Kernel file locks and binding choice

macOS retains `O_EXLOCK` on the permanent `.lock` inode.
Linux uses nonblocking `flock(LOCK_EX | LOCK_NB)` on the same Node file descriptor.
Node's close-on-exec descriptor behavior prevents unrelated executable children from extending ownership.
See [Linux flock](https://www.man7.org/linux/man-pages/man2/flock.2.html).

Windows opens a separate, non-inheritable handle to that same file, with read/write sharing and no delete sharing.
`LockFileEx` exclusively locks one byte at offset `0xffffffff`, with `LOCKFILE_FAIL_IMMEDIATELY`.
This byte is outside the bounded owner identifier. Node can still read and write the identifier through its existing handle.
Competing Previewhost owners lock the same sentinel byte. Normal close and process termination release the kernel lock.
The lock file is never removed or replaced.
See [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex).

Koffi supplies direct calls to these OS APIs and the Windows job, listener, and ACL APIs.
This avoids a separate compiler, helper protocol, and per-platform helper release pipeline.
It is a production dependency because Node's public APIs do not expose these required operations.
Its native packages must work with `npm install --ignore-scripts` on each qualified OS and architecture.
The installed-package check is required evidence, not merely the availability of a published binary.

## 5. Publication, fault model, and verification

POSIX record publication still flushes the temporary file, renames it, and flushes the directory.
Windows flushes the temporary file and uses same-directory `MoveFileExW` with `REPLACE_EXISTING | WRITE_THROUGH`.
Cross-volume copy fallback is not permitted. Database intent still precedes every Docker mutation.
Record deletion follows successful removal of the recorded external resources and credentials.
See [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

The process-crash requirement is an old or new complete record, with uncertain external operations retained for recovery.
A file flush or successful rename alone does not establish equivalent power-loss behavior across filesystems.
Windows x64 process-crash publication passed. Host/power-loss durability remains unverified.
This implementation makes no stronger durability claim than the evidence supports.
No second database or journal is added to conceal that qualification gap.

Linux retains Unix process groups. Group observations exclude zombies, which cannot run or retain listeners.
This permits cleanup in containers whose init process delays orphan reaping.
Only a verified live identity authorizes signals. A process-table failure still blocks successful cleanup.

Docker endpoint selection is explicit `dockerSocket` / `--docker-socket`, then a fixed platform default:

| Platform | Default |
| --- | --- |
| macOS | `~/.docker/run/docker.sock` |
| Linux | `/var/run/docker.sock` |
| Windows | `\\.\pipe\docker_engine` |

Local `unix://` and `npipe:////./pipe/` forms normalize to those transports.
Remote pipes, TCP, and SSH are rejected. Rootless Docker and alternate contexts require an explicit local endpoint.
Previewhost does not read `DOCKER_HOST` or change behavior with the active Docker CLI context.
This preserves explicit ownership and avoids silent endpoint changes during retained-data recovery.
Engine IDs, endpoint comparisons, resource labels, and exact container identities remain mandatory before cleanup.
HTTP requests and upgraded initialization streams share the existing transport implementation.
Windows Docker-backed database startup and access remain blocked before connecting or creating credentials.
Local record reads and credential-only deletion recovery remain available.
A pipe name does not authenticate its server. The first engine ID is supplied by that server, so it cannot establish initial trust.
[Microsoft pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) protects an existing pipe; it does not reserve an absent name.
The two-account experiment creates counterfeit endpoints under an ordinary foreign account, using unused pipe names and dummy input.
Each Windows HTTP and attach connection now opens its own non-inheritable pipe handle with anonymous security quality of service.
Before sending bytes, it reads that handle's owner and ACL through `GetSecurityInfo` with `SE_KERNEL_OBJECT`.
Only the current user, SYSTEM, and Administrators are accepted. Unknown ACE forms, foreign principals, and null ACLs fail closed.
The ACL parser is shared with private-file validation; pipe checks do not require directory inheritance flags.
[.NET uses the same connected-handle owner check](https://github.com/dotnet/runtime/blob/v9.0.0/src/libraries/System.IO.Pipes/src/System/IO/Pipes/NamedPipeClientStream.Windows.cs#L202).
Restricted pipe permissions also exclude foreign accounts from creating additional server instances.
This verifies the existing account boundary, not a Docker executable signature. Same-user code and administrators remain trusted.
A separate pathname check would leave a replacement race; a PID alone would introduce process-reuse ambiguity.

The verified handle passes through Node's exported `uv_open_osfhandle` into the public `net.Socket({fd})` constructor.
The HTTP parser and initialization stream remain shared. No helper process, separate transport parser, or private Node fields are introduced.
[Libuv documents this ownership transfer](https://docs.libuv.org/en/v1.x/fs.html#c.uv_open_osfhandle).
Failure before adoption closes the original handle; successful socket adoption owns subsequent closure.
Descriptors 0–2 are rejected because libuv treats standard streams specially and retains the original descriptor.
Windows omits `agent:false`, which would bypass the custom connection function in Node's HTTP client.
Pipe authentication errors retain `UNAUTHORIZED` instead of becoming generic transport failures.
An actual rejected connection exposed a request-lifecycle defect: Node emitted `error` without assigning a socket or emitting `close`.
The client now settles that rejection directly. A cross-platform regression exercises the real HTTP connection-error path.

Two transport cases still need qualification before database enablement.
An occupied pipe currently fails immediately; stock Node waits asynchronously for a free server instance. No blocking wait or retry was added.
Docker's message-pipe end-of-input convention differs from the Node byte-pipe fixture.
[Go-winio sends a zero-length message for CloseWrite](https://github.com/microsoft/go-winio/blob/main/pipe.go#L136).
Real PostgreSQL and Redis initialization must establish whether the existing attach flow handles that backend correctly.
Real database verification also needs a Linux-container backend for PostgreSQL and Redis.

### Reproducible checks

The CI workflow defines OS-specific commands and separates Windows primitive tests from full database qualification.
The macOS release gate retains its zero-skip requirement.
Linux runs the existing regression suite with procps, lsof, and both database images.
Windows runs kernel-lock, native-process, ACL, named-pipe, and password-keystore tests.
All CI platforms build and verify an installed npm tarball.
macOS binary signature checks remain macOS-only. Shared package inventories normalize path separators.

Required Windows follow-up includes actual Docker database retention, ordinary-user native/keystore execution, handle-leak checks, and explicit nested-job compatibility.
Windows x64 and arm64 both require execution evidence before a general support claim.
Linux arm64 container results do not establish Linux x64 or Windows behavior.

### Results

Results apply to the stated commit and environment. Passing a selected group does not qualify the complete Windows workflow.

| Environment | Commit | Verified result |
| --- | --- | --- |
| macOS 26.6.2 arm64, Node 22.23.1 | `f07e375` | Release gate: 168 passed, zero skips or failures, including PostgreSQL and Redis. TAP duration 203.7 seconds. |
| Ubuntu 24.04 x64, Node 22.23.0 | `c30ea2d` | Source suite: 159 passed, four macOS-specific skips, zero failures. Installed ESM, CLI, MCP, cleanup, and strict TypeScript consumer passed with install scripts disabled. |
| Windows Server 2025 x64, Node 22.23.0 | `97c9ad3` | 40 passed, 13 explicit skips, zero failures. Installed ESM, CLI, MCP, cleanup, and strict TypeScript consumer passed with install scripts disabled. |
| Windows 11 arm64, Node 22.23.0 | `97c9ad3` | 40 passed, 13 explicit skips, zero failures. The same installed-package checks passed with install scripts disabled. |

The [Linux run](https://github.com/RojhatToptamus/previewhost/actions/runs/35656792666) took 4m56s elapsed and 4m53s runner time.
It exercised real PostgreSQL and Redis retention, recovery, jobs, CLI, MCP, and project ownership.
Earlier Debian 12 arm64 execution passed the source and installed-package checks against the pre-integration implementation.

The [Windows architecture run](https://github.com/RojhatToptamus/previewhost/actions/runs/35660749026) passed both jobs: 5m39s elapsed and 8m44s total runner time.
The x64 job took 3m08s; arm64 took 5m36s. Both verified native ownership, process cleanup, ACLs, publication interruption, named pipes, password storage, jobs, project owners, and MCP isolation.
Its 13 skips cover three POSIX signal cases, Keychain, seven database cases, and two missing-Docker project fixtures.
An earlier ARM64 run also passed this group and the installed package. These are selected-workflow results, not full Windows qualification.
The final macOS tarball at `97c9ad3` passed installed ESM, CLI, MCP, cleanup, and strict TypeScript checks.
The [database safety-guard follow-up](https://github.com/RojhatToptamus/previewhost/actions/runs/35661303170), at `db50ac8`, passed its focused regression and installed-package checks on both Windows architectures.
It took 3m35s elapsed and 5m28s total runner time. The regression verified zero pipe connections, credential writes, and retained database records.
Each platform installed a tarball built on that runner. A single release tarball still needs validation across all three operating systems before publishing support.

At `128b9d0`, the [Windows skip-review run](https://github.com/RojhatToptamus/previewhost/actions/runs/35662829128) passed 43 tests with 11 skips on each architecture.
This includes the two ported fallback fixtures. It took 4m32s elapsed and 8m11s total runner time, including backend inventory.
A separate dummy-pipe experiment in that run verified exact-handle adoption, echo, and closure on both architectures.
It did not test Docker Desktop or its message-pipe protocol.
After the shared transport change, macOS passed the three existing real PostgreSQL/Redis lifecycle tests in 10.5 seconds, with no skips.

At `c771183`, the [Windows authentication run](https://github.com/RojhatToptamus/previewhost/actions/runs/35664598645) passed 11 focused tests on each architecture, with zero skips.
Both also passed installed-package ESM, CLI, MCP, cleanup, and strict TypeScript checks with installation scripts disabled.
Two newly created ordinary accounts exercised successful same-account HTTP and attach connections on each architecture.
Foreign-owned pipes granted access only to the victim, SYSTEM, and Administrators; both HTTP and attach were rejected with zero bytes received.
This proves owner rejection separately from broad-ACL rejection. Each experiment confirmed removal of its own processes and accounts.
These are dummy-pipe results, not Docker Desktop database qualification.
The run took 4m17s elapsed and 6m57s total runner time: 2m42s on x64 and 4m15s on ARM64.
ARM64 also passed these checks in the preceding run; x64's earlier account fixture failed before loading its worker from the runner's private profile.
Moving only the disposable fixture directory fixed that setup failure. No existing profile permissions, product guards, retries, or deadlines were relaxed.

Targeted execution also identified and corrected token-default file ownership, premature SQLite fixture deletion, and a clean-shutdown record race.
The record fix maps only [Windows errors 2 and 3](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-) to `ENOENT`.
Permission errors remain failures. A deterministic test deletes a real record between its file-stat and permission checks.
Package checks now handle temporary directories on another drive and execute the installed Windows `.cmd` launcher instead of asserting Unix execute bits.
No retries or longer deadlines were added.

Windows managed databases remain disabled until connected-pipe authentication and database lifecycle checks pass on both architectures.
Full retention and recovery then need a Windows machine with Docker Desktop Linux containers.
The configured hosted Windows jobs do not supply that backend. Named-pipe transport tests do not qualify database behavior.
Ordinary-user native/keystore execution, explicit nested-job compatibility, and host/power-loss behavior remain unverified.
Windows-only tests register only on Windows, so they add no macOS release skips.

### Review of the 13 Windows skips

These counts describe the selected suite at `97c9ad3`, not every test in the repository.

| Test or case | Count | Classification and remaining work |
| --- | ---: | --- |
| Paused supervisor with backpressured configure IPC | 1 | POSIX fixture uses `SIGSTOP`. Windows cancellation is tested, but equivalent blocked-IPC coverage remains unfinished. |
| Supervisor loss with unavailable target identity | 1 | POSIX fallback deliberately fails `/bin/ps`. Windows uses retained Job Object authority; it needs its own observation-failure test. |
| Leaderless survivors after guardian loss | 1 | POSIX process-group identity rule. Windows job cleanup has different authority and existing descendant/guardian-loss tests. |
| macOS remembers and forgets the unlock key | 1 | Genuinely macOS-only Keychain behavior. Password unlock runs on Windows. |
| PostgreSQL startup, retained seeds, replacement, rerun, owner restart, reset | 1 | Unfinished real Windows database coverage. |
| Failed and canceled seeds retain partial writes | 1 | Unfinished real Windows database coverage. |
| Successful script cannot mask failed database readiness | 1 | Unfinished real Windows database coverage. |
| Owner crash leaves an in-flight seed blocked | 1 | Unfinished real Windows database coverage. |
| Dashboard reset authorization, stale/concurrent guards, environment isolation | 1 | Unfinished real Windows database coverage. |
| Dashboard reset recovery after deletion, startup, cancellation failures | 1 | Unfinished real Windows database coverage. |
| Shared MCP connection with separate worktree owners and managed data | 1 | Unfinished real Windows database coverage. |
| Static previews and explicit options without Docker, default/custom data directory | 2 | Ported at `128b9d0`: unique local pipe names and the existing Windows guard error. All original preservation assertions remain. |

The four OS-specific fixtures do not make every related Windows invariant complete.
The two ported cases test fallback while managed databases are blocked; they do not test enabled Windows database startup with Docker absent.
The selected workflow also omits `data.test.ts`, `data.integration.test.ts`, and `project-lifecycle.test.ts`.
Their retention, mutation-failure, offline deletion, and ownership cases must join Windows qualification after fixture portability is complete.

### Windows Docker qualification infrastructure

The repository runner API returned zero registered self-hosted runners on 2026-09-22.
The configured x64 runner uses Windows Server 2025. [Docker Desktop does not support Windows Server](https://docs.docker.com/desktop/setup/install/windows-install/).
The ARM64 runner uses Windows 11. Its availability alone does not establish a working Linux-container backend.
[GitHub does not officially support nested virtualization](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners).

The measured x64 image had Docker Engine 29.7.2 in Windows-container mode and no installed WSL distributions.
Its `docker info` inventory command exceeded the diagnostic's 10-second bound; this was not a database test.
The ARM64 image reported WSL not installed, no `docker.exe`, and `VirtualizationFirmwareEnabled: false`.
Neither configured image supplied a Linux-container backend. These observations do not prove that every custom Windows VM configuration is impossible.

Required access is a disposable Windows 11 machine for each architecture, with native Node.js and Docker Desktop Linux containers.
Each needs WSL 2, enabled hardware virtualization, local NTFS storage, and PostgreSQL 17 Alpine plus Redis 7 Alpine images.
Docker currently labels the ARM installer Early Access. Record the installed Windows, WSL, Docker, Node, and architecture versions with each result.
Use an ordinary account for Previewhost and Docker Desktop. Administrative setup must permit a second disposable account for counterfeit-pipe tests.
Tests must be able to terminate only their own owners and containers, preserve their volumes across restarts, and explicitly delete their own data.
Do not expose production data or reuse a development keystore. Restarting Docker requires a dedicated host without unrelated workloads.

Keep the product guard until both architectures pass connected-server rejection before writes, authenticated initialization, retention, owner-crash recovery, and explicit deletion.
Qualification must also prove that neighboring containers, volumes, and user-secret references survive those operations.
An isolated, unpublished candidate can exercise the guarded database path after authentication is implemented. Do not add a runtime bypass flag.
Keep the platform branch unmerged until these results exist.

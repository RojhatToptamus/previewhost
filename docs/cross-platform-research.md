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
Windows managed-database operations remain blocked before Docker access or credential creation.
A pipe name does not authenticate its server. The first engine ID is supplied by that server, so it cannot establish initial trust.
[Microsoft pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) protects an existing pipe; it does not reserve an absent name.
Another account impersonating a stopped endpoint is a source-supported risk, not a reproduced cross-account attack.
Qualification requires checking the actual connected pipe before sending credentials, including on each attach connection.
A separate pathname check would leave a replacement race.
The next experiment must use an unused pipe name, two disposable accounts, and dummy input.
Real database verification also needs a Linux-container backend for PostgreSQL and Redis.

### Reproducible checks

The CI workflow defines OS-specific commands and separates Windows primitive tests from full database qualification.
The macOS release gate retains its zero-skip requirement.
Linux runs the existing regression suite with procps, lsof, and both database images.
Windows runs kernel-lock, native-process, ACL, named-pipe, and password-keystore tests.
All CI platforms build and verify an installed npm tarball.
macOS binary signature checks remain macOS-only. Shared package inventories normalize path separators.

Required Windows follow-up includes actual Docker database retention, ordinary-user execution, handle-leak checks, and explicit nested-job compatibility.
Windows x64 and arm64 both require execution evidence before a general support claim.
Linux arm64 container results do not establish Linux x64 or Windows behavior.

### Results

Results apply to the stated commit and environment. Passing a selected group does not qualify the complete Windows workflow.

| Environment | Commit | Verified result |
| --- | --- | --- |
| macOS 26.6.2 arm64, Node 22.23.1 | `f07e375` | Release gate: 168 passed, zero skips or failures, including PostgreSQL and Redis. TAP duration 203.7 seconds. |
| Ubuntu 24.04 x64, Node 22.23.0 | `c30ea2d` | Source suite: 159 passed, four macOS-specific skips, zero failures. Installed ESM, CLI, MCP, cleanup, and strict TypeScript consumer passed with install scripts disabled. |
| Windows Server 2025 x64, Node 22.23.0 | `41e1934` | 39 passed, 13 explicit skips; one PowerShell ACL-fixture setup timeout. Shutdown race, jobs, CLI, and both MCP protocols passed. |
| Windows 11 arm64, Node 22.23.0 | `41e1934` | 40 passed, 13 explicit skips, zero failures. Installed ESM, CLI, MCP, cleanup, and strict TypeScript consumer passed with install scripts disabled. |

The [Linux run](https://github.com/RojhatToptamus/previewhost/actions/runs/35656792666) took 4m56s elapsed and 4m53s runner time.
It exercised real PostgreSQL and Redis retention, recovery, jobs, CLI, MCP, and project ownership.
Earlier Debian 12 arm64 execution passed the source and installed-package checks against the pre-integration implementation.

The [Windows architecture run](https://github.com/RojhatToptamus/previewhost/actions/runs/35659690054) verified native ownership, process cleanup, ACLs, publication interruption, named pipes, password storage, jobs, project owners, and MCP isolation.
Its 13 skips cover three POSIX signal cases, Keychain, seven database cases, and two missing-Docker project fixtures.
The x64 ACL fixture timeout occurred in PowerShell setup. The replacement uses native `icacls` and checks its inheritance entries before product assertions.
The [focused x64 follow-up](https://github.com/RojhatToptamus/previewhost/actions/runs/35660424325), at `5c57e57`, passed that fixture and every installed-package check in 1m35s elapsed, using 1m32s runner time.

Targeted execution also identified and corrected token-default file ownership, premature SQLite fixture deletion, and a clean-shutdown record race.
The record fix maps only [Windows errors 2 and 3](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-) to `ENOENT`.
Permission errors remain failures. A deterministic test deletes a real record between its file-stat and permission checks.
Package checks now handle temporary directories on another drive and execute the installed Windows `.cmd` launcher instead of asserting Unix execute bits.
No retries or longer deadlines were added.

Windows managed databases remain disabled until connected-pipe authentication is implemented and tested.
Full retention and recovery then need a Windows machine with Docker Desktop Linux containers.
The configured hosted Windows jobs do not supply that backend. Named-pipe transport tests do not qualify database behavior.
The two missing-Docker project fixtures also need a Windows named-pipe fixture and error-contract verification.
Ordinary-user execution, explicit nested-job compatibility, and host/power-loss behavior remain unverified.
Windows-only tests register only on Windows, so they add no macOS release skips.

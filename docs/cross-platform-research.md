# Linux and Windows implementation decisions

Branch: `codex/cross-platform-support`. Original baseline: `4e46b46`.
Windows implementation and tests are present, but Windows execution remains unverified.
This document distinguishes implementation decisions from verification results.

## Scope and shared behavior

The target is Node.js 22.23 or later on x64 and arm64.
CI targets macOS 15, Ubuntu 24.04, and Windows Server 2025.
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
The current user owns the directory. The user, SYSTEM, and Administrators receive inherited full-access entries.
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
No Windows ACL result is verified yet.

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
Windows process-crash publication and host/power-loss durability remain unverified.
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
Windows database verification needs a Linux-container backend for the existing PostgreSQL and Redis images.

### Reproducible checks

The CI workflow defines OS-specific commands and separates Windows primitive tests from full database qualification.
The macOS release gate retains its zero-skip requirement.
Linux runs the existing regression suite with procps, lsof, and both database images.
Windows runs kernel-lock, native-process, ACL, named-pipe, and password-keystore tests.
All CI platforms build and verify an installed npm tarball.
macOS binary signature checks remain macOS-only. Shared package inventories normalize path separators.

Required Windows follow-up includes full owner/CLI/MCP workflows, actual Docker database retention, publication interruption, handle leaks, and nested-job compatibility.
Windows x64 and arm64 both require execution evidence before a general support claim.
Linux arm64 container results do not establish Linux x64 or Windows behavior.

### Results

macOS 26.6.2 arm64, Node.js 22.23.1:

- The complete source suite passed 162 tests, with no failures or skips, including real PostgreSQL and Redis workflows.
- Final follow-up runs passed 33 ownership/integration tests, 15 native tests, eight keystore tests, and two Docker transport tests.
- The installed tarball passed ESM, CLI, MCP, automatic-owner cleanup, and strict TypeScript checks with install scripts disabled.
- TypeScript, the build, two release-checker tests, and documentation checks passed.

Linux validation used Debian 12 arm64, Node.js 22.23.0, and an isolated local Docker Engine.
The initial runs exposed macOS-specific fixture paths and delayed zombie reaping in cleanup assertions.
Those fixtures now use Linux tool paths and bounded kernel-absence checks.
The final source suite passed 158 tests, with no failures and four macOS-specific skips.
The skips cover two Keychain tests, remembered unlock, and a fixture that changes the macOS default Docker socket.
Real PostgreSQL and Redis retention, recovery, jobs, CLI, MCP, and project ownership ran in the Linux suite.
The installed Linux tarball also passed ESM, CLI, MCP, automatic-owner cleanup, and strict TypeScript checks with install scripts disabled.

Windows-only tests are registered only on Windows; they add no macOS release skips.
Windows code has passed TypeScript checks, but its OS API calls have not executed on Windows.
The branch includes the merged CI cancellation and release-artifact checks from `main`.
The new inheritance regression requires Windows execution before it counts as verified.
CI configuration is present but has not run from this branch.
Neither Windows nor Linux x64 has execution evidence from this task.

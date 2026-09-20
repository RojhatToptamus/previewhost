# Developer experience redesign

Storage descriptions and recorded checks in this historical report predate the encrypted keystore.
For current behavior, see [stored secrets](api.md#stored-secrets).

Implementation status: September 14, 2026. Branch: `codex/dx-workflow`, based on `origin/main` at `ec36175`.

This report now describes the implemented design and its verified limits. The September 12 proposal was treated as guidance. Existing runtime, configuration, authorization, Keychain and cleanup mechanisms remain the basis of the system.

## User workflow

1. Supply the current worktree as `project` on each MCP call. CLI defaults to its canonical Git root, or cwd outside Git.
2. Prefer root `preview.yml` when it exists. Invalid or unreadable content is an error. An explicit file or direct spec overrides this default.
3. Inspect the spec and prepare the application through its existing project commands. Inspection works without starting an owner.
4. Start with authority from the current CLI invocation or MCP registration. The adapter finds or starts one persistent project owner.
5. For credential bindings, request exact `{secret: ID}` references. The user approves unselected names in the private browser form, then enters only missing values there.
6. Wait on public secret status. On completion, re-read file-based input, check current preview state, and use ordinary start/replace and wait operations.
7. Save root `preview.yml` only when the user asks. Saving validates declarative input but does not start code or certify application health.
8. Stop individual previews when needed. Explicit owner shutdown stops every preview on that owner and ends its access approvals.

A paused agent does not need an idle-shutdown exception or a new background job. The owner remains alive across ordinary inactivity and MCP disconnection. If the agent turn ends during private entry, the page tells the user to send “Secrets saved—continue”. Saving cannot independently create a new agent turn.

Global MCP registration now uses client-native project approval (see [current setup](../README.md#use-mcp)):

```sh
codex mcp add previewhost -- previewhost mcp --allow-exec
```

Example CLI startup with optional root configuration:

```sh
previewhost start --allow-exec
```

Without YAML, JSON stdin remains supported:

```sh
previewhost start --allow-exec <<'JSON'
{"name":"shop","type":"command","cwd":".","command":["node","server.mjs"],"env":{"API_TOKEN":{"secret":"shop/dev/api-token"}}}
JSON
```

`--allow-exec` retains the existing broad trusted-owner mode: native commands, managed operations, explicit data deletion/recovery and private secret setup. It grants no secret selection by itself. It is not a sandbox, and host tool approval remains separate.

## Implemented behavior

| Area | Behavior |
| --- | --- |
| Private secret workflow | One existing private channel handles name approval and missing-value entry. No public approval tool or `approved: true` field exists. |
| Shared values | An exact ID uses the existing `dev.previewhost.user` Keychain entry across projects/worktrees that approve it. A distinct ID expresses a different value. |
| Status continuation | Immediate reads or waits up to 25,000 ms use the existing bounded request map. Canceling a wait leaves setup open. |
| Automatic owners | CLI and MCP share a persistent owner per canonical project. MCP routes each call independently, even over a shared connection. A lifetime kernel lock serializes startup. Explicit connection mode remains supported. |
| Configuration input | CLI supports file or JSON stdin. MCP inspect/start/replace/setup supports exclusive `file` or `spec`, with root `preview.yml` as the default. |
| Configuration saving | `preview_save_config({project, spec})` and the library helper create root YAML from validated declarative input, without overwriting existing content. |
| Discoverability | The first 512 MCP instruction characters cover the normal workflow. The catalog has 14 operational tools plus `preview_access` in global mode. |
| CLI guidance | The package includes the maintained skill and materialized references. `--help` describes project mode; `--version` reports the installed version. |
| Continuing startup | CLI start/replace reads current state after a wait timeout and can return `starting`. It does not misreport a continuing attempt as a failed start. |
| Source ownership | Attempt summaries and incomplete cleanup records expose source directories, including older attempts still retaining resources. |

The dashboard shipped after this original research. It reuses runtime operations and retained attempt configuration; current root-YAML validation is derived from the file. No configuration database or separate configuration lifecycle was added.

## Secret access and privacy

The runtime's existing selected-ID set remains the access boundary. Launch-time selections are copied once. Private approval adds exact names to that same set after source revalidation. Concurrent additions form one bounded union of at most 128 IDs.

A pending setup retains its prepared spec through an owner-private callback. The callback is never serialized onto MCP or the public control transport. Presence checks for unselected names occur only after private approval. No unrelated Keychain names are enumerated by setup.

Any execution-authorized preview on an owner can bind a selected ID. Grants do not isolate clients or previews from each other. The private form states this scope. Cancellation after approval does not undo that approval, and partial saves retain completed writes. Owner shutdown ends dynamic grants; stored values remain available for later reapproval.

Missing-value setup uses the existing atomic Keychain add behavior. An entry created concurrently keeps its value. Explicit edit retains its existing update-only semantics. A locked store requires owner unlock or item-access repair, not another name-selection mechanism.

The existing private capability, numeric Host/Origin validation, bounded JSON input, fixed assets, CSP and safe text rendering remain. Control bearers and public request IDs cannot approve or save private entries. The page clears entered values and consumes its capability on completion.

The credential workflow keeps values out of YAML, MCP arguments/results and agent messages. This does not certify arbitrary literal strings or application output as secret-free. The schema still permits useful non-secret literals and argv; application logs or HTTP responses can disclose unexpected values. Known-value log redaction remains. No heuristic secret scanner or export of resolved environments was added.

## Project owner and recovery

The automatic owner is the existing runtime and daemon in a detached process. Its lifetime is independent of stdio. CLI and MCP use the existing authenticated HTTP client.

A private directory under `~/.local/share/previewd/projects` contains a token, permanent lock and connection record. A SHA-256 digest of the canonical project path supplies a fixed-length filesystem address for arbitrary path lengths. This digest is neither a configuration signature nor an authority check.

The lifetime lock uses Darwin `O_EXLOCK`, the same mechanism already used by the data owner. It prevents competing first callers from owning the project. The connection record is published after listener readiness and contains endpoint, PID, project path, data directory, and any explicit Docker socket. Clients authenticate, then compare the responding project and explicitly requested launch settings. They never reconstruct authority from the record.

Omitted launch flags can reuse an existing owner. Incompatible explicit options report an error without terminating or reconfiguring it. Initial secret selections are compared as launch settings; browser additions are not copied back into those settings. Selected input values remain the values captured at owner startup.

Read/status/cleanup operations never start an owner. A secret UUID lookup therefore cannot create a replacement owner to search for old history. Inspection uses the existing runtime validator offline when needed and does not open managed storage.

Explicit `--endpoint` or `--token-file` selects connection-only mode and rejects launch-permission flags. A bare client does not silently adopt the legacy default daemon. Manual `serve`, explicit shared owners and embedded runtimes remain supported.

Clean shutdown completes runtime cleanup and removes the endpoint and PID. It retains the data location in the same record while managed data remains; otherwise it removes the record. Project clients wait for this change so immediate restart works. Concurrent readers handle an opened record being unlinked. Startup contenders retry the existing lock when an older owner is releasing it.

A crash or uncertain cleanup retains the record. A dead endpoint proves neither process cleanup nor rollback of an external operation. Automatic startup stops with an actionable recovery error. Verify the old owner's application resources and external preparation before removing that project's connection record. Keep the permanent lock inode. Never signal a process based only on the recorded PID.

The existing data-directory lock, record migrations, Docker identity/ownership checks and native process-group supervision are unchanged. No background OS service, idle timer, process adoption, configuration permission store or mutation replay was added.

## Configuration loading and saving

The runtime and HTTP API remain object-only. File loading belongs to CLI/MCP adapters and reuses the existing bounded strict JSON/YAML loader. File-relative source resolution occurs once. CLI stdin resolves relative paths from cwd. There is no automatic filename search, merging or mandatory initializer.

File input requires a regular file; pipes remain supported through JSON stdin. MCP reads stay inside the selected project or explicitly configured roots, including resolved symlink targets. CLI/library callers retain their existing filesystem authority unless they supply the loader's optional root constraint.

Saving uses the original prepared spec, not inspection output. Inspection deliberately omits literal environment bindings and literal external database URLs.

The save helper:

- Uses the current schema, dependency/attachment checks and shared source-scope validation.
- Validates source paths without resolving `{fromEnv}`, `{secret}`, service URLs or generated ports.
- Preserves commands, readiness settings, non-secret literals and symbolic references.
- Makes project-local source paths relative and reports explicitly allowed external sources as nonportable.
- Serializes with the existing YAML dependency, disables aliases and verifies a strict-loader round-trip.
- Writes a complete temporary file and publishes through an exclusive hard link.
- Returns `ALREADY_EXISTS` for an existing file, directory or symlink, leaving it unchanged.

Source checks were separated from input resolution so configuration validation does not depend on available owner values. Existing runtime validation still resolves inputs during normal startup.

The initial save operation is deliberately create-only. Requested updates use the host's ordinary editor, followed by validation. It neither deletes a file to retry nor adds revision numbers, hashes, persistent locks, approved booleans, stored preview IDs or execution-proof artifacts. After a lost save response, inspect the destination before retrying.

## Departures from the proposal

- Inspection is explicitly offline before first startup. Starting a permissionless owner during inspection created an avoidable later execution-permission conflict.
- Startup and shutdown handle the observed lock-release and connection-unlink races directly. No new lifecycle state machine was needed.
- The filesystem address uses a project-path digest only to bound directory names. Configuration hashes, permission manifests and version routing remain excluded.
- The ordinary runtime wait API keeps its existing timeout error contract. CLI start/replace translates that into a fresh observation of the exact attempt when possible.
- Source associations are exposed on attempts and retained cleanup records. Agents no longer need to rely solely on remembering submitted source paths.
- The npm build materializes the existing skill references because npm omits repository symlinks. Generated copies live in `dist`; maintained documents still have one source.
- A live Claude check misread a terminal partial secret result as a reusable form. MCP guidance now explicitly requires fresh setup after repair.

The September 14 Cursor investigation found shared MCP connections with a launch directory unrelated to the active worktree.
MCP selects the project on each call. The subsequent global-onboarding change added native approval for each project and dependency directory, while preserving explicit-root restrictions.
Automatic owners with an explicit Docker socket use separate private data directories by default.
The change reuses project owners, source validation, data locks, and private secret approval. It adds no chat registry or second lifecycle.

## Verification and limits

All credentials used for this work were fake values in disposable Keychains. Test projects, Git repositories, worktrees, connection directories and application processes were disposable. No production systems or personal secret entries were used.

| Check actually performed | Result |
| --- | --- |
| First complete secret workflow | Passed over real stdio MCP, the authenticated daemon, native Keychain helper and a native HTTP application. Private approval reused an existing item, collected a missing item, completed public status and resumed ordinary startup. |
| Secret failures and concurrency | Passed unselected-name denial before metadata access, source revalidation, bounded concurrent approvals, locked/partial/unknown writes, invalid capabilities, cancellation, expiry and shutdown checks. |
| Configuration | Passed all spec-kind round-trips, reference/literal preservation, source and MCP file escapes, nonblocking special-file rejection, cancellation, failed publication, competing creators and preservation of existing files/directories/symlinks. |
| Project owners | Passed simultaneous first callers, CLI/MCP sharing, disconnection, immediate clean restart, changed launch settings, cold read/status behavior, actual Git worktree root detection and retained-record crash recovery. |
| Worktree/project secrets | Passed shared names across two actual Git worktrees and an unrelated project, distinct values, fresh approvals after restart, resumed status after adapter disconnect and rejection of an edited unapproved binding while preserving the active preview. |
| Browser UI | Chrome desktop/mobile checks passed approval, private entry, completion, cancellation and unavailable-link states. No page errors or mobile horizontal overflow were observed. Screenshots stayed outside the repository. |
| Live agent | Codex CLI 0.146.0 passed without YAML or an installed Previewhost skill. It prepared a spec, requested setup, observed completion, started the application and checked `/health`. No file was saved and no credential value/private capability appeared in its transcript. The harness performed the private owner actions. |
| Actual Claude terminal client | Claude Code 2.1.270 passed MCP discovery, automatic startup, private approval/entry, public completion, continuation, explicit YAML save and file-based restart. Browser checks wrote and retained PostgreSQL data through the backend and authenticated local fake API. Locked test storage required unlock and retry. |
| Actual Cursor IDE agent | Cursor 3.20.7 passed the same full-stack workflow, plus owner shutdown/restart, fresh name approval, existing-value reuse without entry, and root YAML defaults. Browser checks retained both database records after owner restart. |
| Full regression suite | Docker-enabled `npm run verify:release`: 111 passed, 0 failed, 0 skipped. This includes TypeScript checks, native processes, disposable Keychains, real PostgreSQL/Redis and ownership/recovery scenarios. Four focused real-data tests also passed before the client checks. |
| Type checks | TypeScript checks and skill validation passed. |
| Fresh package consumer | Passed against the final local tarball in a clean external directory: public ESM imports, strict TypeScript declarations, CLI/native startup, 14-tool MCP discovery with absolute Node/minimal PATH, disconnect survival, automatic owner shutdown, validated save/load, packaged skill references and universal helper signature. No publication occurred. |

The live agent first supplied a preview name containing uppercase characters. The existing validation rejected it, and the agent corrected it. A pre-start `get` returned `NOT_FOUND`, which it handled normally. The result is a working recovery-capable flow, not a claim of zero tool errors.

The Codex live test used temporary invocation configuration and preapproved only its disposable MCP server's tools. It did not establish every host approval policy or test a manual human's approval decisions.

The later Claude/Cursor tests used actual client UIs and project-local MCP registration, with Computer operating the private form.
Only the Keychain binding was redirected to a disposable native store; MCP and browser actions were not intercepted.
Claude used manual per-call approval. Cursor's project server was enabled through its UI with the existing read/write allowance.
Screenshots contain no values or private capabilities. See the exact versions, outcomes and restrictions in [integrations](integrations.md).

A fresh September 13 repeat used new local tarball installations and MCP registrations in Claude Code 2.1.270 and Cursor 3.20.7.
Both actual clients ran the `previewhost-test-frontend`/backend/PostgreSQL lab through MCP, with private fake-secret setup and Brave verification.
Both passed direct input, explicit YAML saving/reuse, malformed YAML rejection, owner reapproval, data retention and client reconnection.
Cursor additionally ran two real worktrees with shared/distinct references, canceled entry recovery and a failed replacement followed by recovery.
The final hostname and numeric URLs for all four environments were opened in Brave. The fresh automated run passed 111 tests, plus four real frontend HTTP contract checks.
The test fixture also selected Brave in the native opener; it did not change MCP or application handlers.
An initial Cursor registration became stale after edits; a fresh server name restored tool calls.
The [integration record](integrations.md#cursor-ide) separates these actual-client results from automated checks and explains the fixture limits.

The September 14 [global Cursor worktree check](integrations.md#global-registration-and-cursor-worktrees) used two actual chats in one Agents window.
Both full stacks passed source, update, database, shared-secret, stop/restart, and MCP process-reconnection checks.
Reconnection required Cursor's offered authentication click. The broad suite passed 112 tests; the final focused run passed nine.
The resumed check verified the committed build in two fresh Cursor-managed worktrees after a host restart left the temporary fixture unavailable.
Both full stacks passed again, including shared-process reconnection. No additional implementation changes were needed.

Still deferred or unverified:

- The future dashboard and an MCP overwrite/editor operation.
- Guaranteed automatic agent wakeup after a completed turn; the continuation message remains necessary for that case.
- Universal active-worktree discovery in every GUI host. MCP requires the agent to supply its actual worktree; it does not infer chat identity.
- Codex Desktop, VS Code, Intel execution and non-macOS automatic owners.
- A fresh Claude partial-write recovery scenario. The new build loaded the revised wording, but the fresh client run did not reproduce a partial write.
- A universal guarantee against credentials embedded in arbitrary argv, literals or application output.

No push, merge, deployment or publication is part of this work.

## Maintained references

- [API and CLI contracts](api.md), [security and recovery](security.md), [worktree operations](worktrees.md), [recipe guidance](recipes.md), and [tested client integrations](integrations.md).
- [Configuration loader and saver](../src/config.ts), [project adapter](../src/project.ts), [owner entry point](../src/owner-process.ts), [private setup](../src/secrets-setup.ts), and [runtime](../src/runtime.ts).
- [OpenAI MCP documentation](https://developers.openai.com/codex/mcp), fetched September 13: stdio arguments/cwd, tool approval settings and self-contained first-512-character instructions.
- [YAML serialization options](https://eemeli.org/yaml/#createnode-options) and [Node filesystem link semantics](https://nodejs.org/api/fs.html#fspromiseslinkexistingpath-newpath), reviewed for the original September 12 design and exercised locally here.

# Previewhost local dashboard: research and proposal

This document records earlier design decisions and verification. For current behavior,
including startup, configuration editing, Secret Manager, and retained data after shutdown, see
the [dashboard guide](dashboard.md), [dashboard operations](api.md#local-dashboard-operations), and [design system](../dashboard/DESIGN.md).

Storage descriptions also predate the encrypted keystore. See [stored secrets](api.md#stored-secrets).

Research date: 14 September 2026. Baseline: `main` at `cf5326a`, after PR #7.
Status at the research date: dashboard and explicit recipe saving implemented; configuration editing remained deferred.
Branch: `codex/dashboard-research`.

## Implementation outcome

The first implementation uses fixed HTML/CSS and a small TypeScript browser script,
with no new dependencies. `previewhost dashboard` launches a foreground local bridge
that discovers existing automatic owners. It preserves their lifecycle and authority.

Implemented: project/worktree identity, application/service links, active versus update
status, bounded logs, guarded Stop, exact cancellation, ordinary cleanup retry,
Start preview (the Start again operation), explicit failed-start retry, redacted requested configuration, exact-attempt recipe saving, and pending private-form
handoff. Full specs remain unexpanded in bounded owner memory, never exported to the
browser. Stop retains the application actually stopped when an update had failed.

Material changes from the proposal:

- Data deletion stays in the CLI. Existing public names/types cannot guard a stale
  delete-and-recreate confirmation. No speculative resource identity API was added.
- **Save as preview.yaml** creates a file from the exact selected attempt in its owner's
  project root. It reuses the existing saver without overwriting files or changing the
  running application. Live Restart and configuration editing remain deferred.
- **Retry start** reuses the normal startup path after a failure is repaired. It targets
  the current failed attempt only when no application, startup, or cleanup remains.
  It does not retry canceled attempts or open private secret setup.
- Dashboard tab storage retains its separate capability across reload. Browser restore
  may preserve it; stopping the dashboard process ends its authority. Secret forms
  remain memory-only. No persistent project or configuration store was added.
- Older owners retain read/Open/log access, but guarded Stop falls back to an exact CLI
  command when the owner cannot enforce the new guard. No unguarded browser fallback.
- One hung owner has a three-second read budget. Its unavailable row does not block others.
- Completed/canceled private setup appears under Activity so it does not displace the
  application controls. Pending requests remain visible before startup.

Independent architecture and usability reviews found and corrected MCP guard forwarding,
a navigation link that would lose the private session, hung-owner handling, ambiguous
busy status, configuration metadata, and mobile focus/connection recovery behavior.
A final review found a stale cleanup error after successful retry. An existing fault
test reproduced it; Stop now clears that error only after all cleanup succeeds.

The sections below retain the research rationale; unimplemented future features are
explicitly identified. Verification results are summarized at the end.


## Recommendation

Build an optional local **preview finder and troubleshooting interface**. It should answer four questions quickly:

1. Which application and worktree am I looking at?
2. Can I open it, and what is still starting or needs attention?
3. Why did startup or an update fail?
4. Can I stop this copy without losing its data or affecting another copy?

The application is what people want to review. Management should help them reach it and intervene when necessary. Start with a cross-project list and a detail panel, backed by existing project owners. Keep normal agent setup in MCP and private entry in the existing secret form.

A configuration IDE, telemetry platform, and permanent project catalog would each introduce requirements that this first interface does not need. A dashboard is justified over a CLI table primarily by multiple-worktree comparison and discoverable recovery controls. For someone running one healthy preview, their application URL may remain sufficient.

## Evidence and its limits

**Verified during research:** repository instructions, the attached brief, README, DX research, API/security/worktree documentation, integration reports, implementation, callers, schemas, relevant tests, and Git history were reviewed. The worktree was clean. A separate worktree and branch were created from fetched `origin/main`; other worktrees were preserved. No services, client registrations, credentials, or source code were changed during that research phase. Implementation and new verification are recorded separately below.

The previous integration reports provide workflow observations, not new test results. They include complete environments, private setup, retained data, shared MCP connections, and distinct worktrees. This research did not rerun those experiments. No customer interviews or usability sessions have been conducted. Frequency and demand estimates below are hypotheses to validate, not measured facts. See [integration observations](../docs/integrations.md) and [DX findings](../docs/dx-redesign-research.md).

Two independent agents reviewed the proposal: one traced product journeys and external tools; the other traced runtime contracts and authority. Their findings changed the scope and architecture, as recorded below.

### People and moments of use

| Person or moment | What they need | Design consequence |
|---|---|---|
| Developer reviewing an agent's work | Open the correct application and try the change | Open is the primary action; worktree path stays visible |
| Developer comparing parallel chats | Distinguish copies of the same repository | Group by canonical project/worktree, then preview name; never infer chat identity |
| Developer waiting on startup | Know whether to wait, enter a secret, or fix something | Separate startup, private action, failure, and cleanup states |
| Developer seeing an old result | Understand whether an update failed while the old app survived | Show the serving attempt and update outcome together |
| Developer returning after an editor closes | Find processes that are still running | Discover existing owners without depending on client connections |
| Developer finishing a review | Release processes while keeping useful test data | Stop preserves data; deletion is a separate explicit action |
| Coding agent | Observe the same state and recover predictably | Reuse owner operations and structured errors; no dashboard-owned workflow |

These moments follow from Previewhost's documented parallel-worktree model and observed integration failures. They do not establish that users need a visual configuration editor. [README](../README.md), [worktree behavior](../docs/worktrees.md)

### What other tools teach us

| Official source | Useful pattern | Boundary for Previewhost |
|---|---|---|
| [Tilt UI](https://docs.tilt.dev/tutorial/3-tilt-ui.html) | Distinguish update outcome from runtime state; put endpoints and logs near the affected resource | Do not copy Kubernetes concepts, automatic rebuild controls, or arbitrary task buttons |
| [Docker Containers](https://docs.docker.com/desktop/use-desktop/container/) and [Volumes](https://docs.docker.com/desktop/use-desktop/volumes/) | Inventory, lifecycle controls, exposed-port links, and separate persistent-data management | Show Previewhost ownership, not every Docker resource on the machine |
| [Aspire dashboard](https://aspire.dev/dashboard/) and [security guidance](https://aspire.dev/dashboard/security-considerations/) | Resource status and diagnosis are useful; local configuration and logs still require authenticated access | No OTLP, traces, metrics pipeline, or anonymous management endpoint |
| [Cursor worktrees](https://prod.cursor.com/docs/configuration/worktrees) and [multi-agent review](https://prod.cursor.com/help/ai-features/multi-agent) | Parallel tasks use different checkouts; people review application results | A chat is not a reliable MCP connection or owner identity |
| [Claude MCP setup](https://code.claude.com/docs/en/mcp) and [permissions](https://code.claude.com/docs/en/permissions) | Registration scope and client tool permissions affect the journey | The dashboard cannot remove client permission prompts or silently grant Previewhost authority |

These are design comparisons, not evidence that their full feature sets belong here. The Task Monki screenshots suggest useful service grouping and secondary technical details. Do not copy their execution-plan approval, jobs/workers, generation language, or combined “Stop Preview & Delete Data.” Previewhost has different contracts.

## Initial scope and layout

The first usable release should include:

- Known project owners, worktree paths, previews, returned application URLs, and owner connection status.
- Active application, startup/update outcome, service readiness, cleanup problems, and retained-data summary.
- A detail panel with source paths, a bounded log tail, and errors with the supported next action.
- Open/copy URL, Stop, exact startup/update cancellation, normal cleanup retry, **Start again** for a stopped preview, and explicit **Retry start** after repairing a startup failure.
- Explicit **Save as preview.yaml** from an exact attempt's configuration, without overwrite or changes to the running application.
- Retained-data visibility and a clear explanation that explicit deletion remains in the CLI.
- Pending private setup, including requests that exist before any preview starts, and an explicit handoff to the existing private form.

Start again, read-only configuration details, and explicit saving use the retained declaration described below. Start again reruns it against current source; it does not reload YAML. Save creates root `preview.yaml` without applying changes to the running preview. New-environment creation, live restart, and configuration editing remain subsequent work. If the declaration is unavailable, show an explicit agent/CLI handoff with the exact project and preview name. Never reconstruct input from status.

Prefer a compact list with an expandable detail panel. A full-width detail view serves small screens without becoming a separate application section. Deep links are deferred.

```text
Previews                              Search project, path or name

Needs attention
notes / worktrees/search      app   Available · update failed [Open]
notes / worktrees/sharing           Private setup required    [Review]

Running
notes / worktrees/main        app   Ready · 3 services         [Open] [⋯]

Stopped · data retained
shop / experiments/checkout   app   PostgreSQL data kept             [⋯]
```

```text
notes / worktrees/search / app                         [Open] [⋯]
/Users/example/worktrees/search
Preview available. The latest update failed; the previous app serves.

Application     web ready · api ready · PostgreSQL running
Update          api failed: readiness deadline exceeded
                [Show update logs] [Show serving application details]

Source paths    …/frontend, …/backend
Managed data    PostgreSQL · retained when stopped
Configuration  [Details, when available]
Technical details ▸
```

The examples contain labels, not real applications or verified URLs. Rows must use owner-returned URLs, including numeric alternatives only where provided. Full paths remain accessible and copyable when shortened visually. Status uses text and icons as well as color. Keyboard navigation, visible focus, selectable diagnostics, and readable narrow layouts are acceptance requirements.

Alternatives considered:

- **CLI table only:** cheaper, useful as a fallback, but weak for comparing applications and discovering recovery actions.
- **One page per owner:** simpler transport, but forces people to locate several management pages for the central multi-worktree use case.
- **Native app or menu-bar service:** convenient persistent access, but adds packaging and lifecycle work before demand is established.
- **Service graph/configuration studio:** appropriate only if users repeatedly need to author environments here. Existing agents and editors already do that work.

Do not add automatic inactivity shutdown. A disconnected client, closed browser, or old preview can still be useful. Age is not evidence that data or processes may be discarded.

## Status and control semantics

Derive presentation from existing status fields; do not persist another status machine.

| Observed owner state | User-facing meaning and action |
|---|---|
| Starting, no active application | Starting; show service progress and cancel this exact attempt |
| Active ready | Ready; startup readiness passed, Open available |
| Active plus candidate | Preview available; update in progress; cancel update leaves the active application |
| Active plus failed latest attempt | Preview available; update failed; show failed-attempt logs without removing Open |
| Cleanup incomplete | Explain which cleanup failed; keep affected source directories until cleanup succeeds |
| Stopped with retained data | Processes stopped, saved database data remains |
| Owner unreachable | Status unknown; do not infer stopped or automatically remove its connection record |
| No connection record after clean shutdown | Not discoverable as a live owner; do not promise permanent history |

“Ready” is an initial readiness result, not continuous health or proof of the latest source change. Source directories are live, not captured snapshots. Replacement keeps the old route until the candidate is ready, but cannot roll back source edits or database migrations. [Contracts:30–35,139–170](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/contracts.ts#L30-L35), [worktree semantics](../docs/worktrees.md)

**Start again** is available only for a stopped preview whose selected declaration is still retained by the same owner. It revalidates source and authority, uses the existing start path, and refreshes returned URLs. It does not launch a missing owner.

**Retry start** uses the same operation for the current failed attempt after the user repairs its cause. It is unavailable while an active application, candidate, busy operation, or cleanup remains. A failed update with a serving application is not a failed startup. Canceled attempts remain excluded. Retrying does not open private setup or bypass secret approval.

**Stop** stops the selected environment's owned processes and managed containers while retaining managed data. It does not own an attached external service. **Cancel update** targets the exact candidate. **Retry cleanup** invokes the existing supported stop path. An engine-restart recovery assertion stays explicit; the interface must not guess it or restart Docker. **Delete retained data** remains an explicit CLI operation. No dashboard deletion control is implemented. Owner shutdown is broader than Stop and ends dynamic secret grants; keep it in CLI initially. [Runtime:204–265](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/runtime.ts#L204-L265), [security and recovery](../docs/security.md)

## Configuration and secrets

### Configuration authority

The research baseline kept attempt summaries, not the complete declaration. Inspection also removes literal environment values and external database URLs. It cannot recreate a spec faithfully. [Baseline runtime:17–39](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/runtime.ts#L17-L39), [description contract:172–186](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/contracts.ts#L172-L186)

The implementation retains **one normalized, unexpanded declaration with each relevant bounded runtime attempt**. It describes what that attempt was asked to run, not a second mutable project configuration. Symbolic secret/input bindings stay unexpanded; resolved environments are not retained for this purpose. General management responses expose only a redacted description. Owner operations reuse the declaration for Start again and explicit saving. [Normalization:43–74](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/spec.ts#L43-L74)

| Input condition | Current behavior and limits |
|---|---|
| No YAML; preview started with a direct spec | Show a redacted description of its retained declaration when supported. Do not create a file automatically |
| Valid root YAML | CLI/MCP load through the existing loader and preserve relative paths. Dashboard Start again does not reload it |
| Broken root YAML | File-based CLI/MCP input reports an error. The dashboard neither loads the file nor claims it is valid |
| YAML exists beside an active direct spec | Show the attempt's “Requested configuration.” Do not claim it matches the file or infer its origin; there is no project-file viewer |
| User explicitly saves a declaration | Save the exact selected attempt through the validated, create-only saver. An existing file produces an error, never an overwrite |
| User edits an existing YAML file | Initially use their editor or agent. Save changes future input; it does not silently apply to a running application |
| Owner exited and only database data remains | Configuration may be unavailable. A directory or database name cannot recover a lost direct spec |

The retained declaration also enables a later restart, but its target must be explicit: the serving attempt or a selected stopped attempt, **not the latest attempt**, which may be a failed update. For the first release, Stop followed by Start again is sufficient. A later one-click Restart stops then starts and may change the public listener URL; refresh displayed URLs and explain downtime. Applying via replacement preserves routes but overlaps processes. Do not substitute one for the other silently. Missing secret approval returns to the existing private flow. File-based startup must validate the file before stopping a working application.

**Save as preview.yaml** calls `saveConfiguration(name, attemptId)`. The automatic owner fixes the project destination; the browser supplies neither a filesystem path nor a spec. Saving validates source scope, makes local sources relative, and reports external absolute paths. It reads no Keychain values, changes no application state, and never overwrites an existing file or symlink. The saved file lets CLI/MCP recover the recipe after owner exit. Literal values supplied in the original declaration remain; the saver cannot certify arbitrary strings are secret-free.

This small addition closes the gap between a successful in-memory preview and a reusable recipe. Full editing still needs overwrite/conflict handling that create-only saving does not provide. A general editor and file/runtime transactions remain deferred. No hashes, revisions, or configuration database are needed. [Config loader/saver:11–119](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/config.ts#L11-L119)

### Private setup

Show the distinction explicitly: `API_SECRET` is an application environment variable; `notes-search-api` is a stored reference. New bindings normally use project-specific references. Intentional sharing selects the exact reference; worktrees are not automatically given a new namespace.

The management page may show declared recipients, reference names, and public setup state. It must not enumerate the user's Keychain, reveal values, or check unapproved references for presence. Access grants belong to the owner and survive cancellation after approval; stored values survive owner shutdown, but dynamic grants do not. Removing a binding neither deletes its stored value nor revokes an existing owner grant. [Private setup boundary](../docs/security.md#stored-secrets-and-private-entry)

Approval, missing-value entry, and cancellation remain in the existing private form. A dashboard button may ask the owner to reopen an existing pending form through its native browser launcher. This requires a narrow new operation, with existing launch limits; it must never return the private capability. A canceled request is terminal. Only explicit user intent can begin a new request. Neither approval nor value saving starts an application.

Do not add a general secret manager or rotation screen initially. Updating a shared value affects later consumers across owners, and restarting one application does not update every running consumer. Existing explicit private edit operations remain usable outside the dashboard.

## Concrete journeys and coordination

1. **First use.** Install Previewhost and configure the chosen client's MCP using current documentation. The agent prepares dependencies and submits a valid full-stack spec. The user optionally runs the proposed `previewhost dashboard` command. An empty page explains that no owners/previews are known and points to the ordinary MCP/CLI setup. Selecting a folder is neither a recipe nor execution authorization.
2. **Compare two chats.** Each agent starts its own registered worktree through the shared MCP registration. The dashboard shows two canonical paths, even if both previews are named `app`. The user opens both, tests different changes, and stops one. The other environment and database remain available. Start again restores the stopped copy using its retained declaration and data, with current source.
3. **Private entry after an agent turn.** A request appears under its project before the preview exists. The user opens the private form, approves its exact recipients, and enters a fake value. Public status becomes complete. If the agent ended its turn, the UI says to send a short continuation in that chat. It cannot reliably identify or wake that chat itself.
4. **Canceled or delayed entry.** Pending, expired, browser-launch failure, and canceled remain distinct. Delayed entry keeps the request pending until its existing expiry. Cancel invalidates the request capability; no polling loop reopens it. The agent should stop the flow and await explicit user intent. This last behavior is model guidance, not an indefinite server prohibition on new requests.
5. **Failed update.** A backend candidate fails readiness while the old application serves. The user keeps Open, examines that candidate's logs, and asks the agent to fix the problem. Retry is not offered without identified valid input. Incomplete cleanup shows the existing recovery action rather than a generic “try again.”
6. **Human and agent act together.** A user looking at attempt A presses Stop after an agent has replaced it with B. The owner rejects the stale action; the page refreshes and explains that the preview changed. It does not automatically repeat the action against B. After a successful Stop, a later authorized Start is still possible: Stop means stop now, not permanently pause all agents.
7. **Keep a working recipe.** The agent starts a direct spec without YAML. The user opens that attempt's Configuration and selects **Save as preview.yaml**. Saving preserves symbolic bindings and reports any external source paths. The running preview stays unchanged. After owner exit, the agent or CLI loads the saved file and requests any required access again. Saving does not make the dashboard an owner launcher.

Exact candidate cancellation already has an attempt-ID guard. At the research baseline, Stop and replacement targeted the current preview by name. Dashboard Stop now uses a small owner-side expected-target check using existing attempt identities, checked before mutation. A browser refresh alone cannot close the race. Data deletion remains in the CLI because public status only contains resource names/types, which cannot distinguish delete-and-recreate. No additional resource identity contract was added for a deferred feature. [Runtime:204–255](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/runtime.ts#L204-L255)

Agents should recheck state after an interrupted operation, observe structured cancellation/conflict results, and avoid blindly retrying mutations. A client disconnect does not end owner activity. Client manual-permission modes may still require individual approvals. No new chat router, agent scheduler, or permanent human-intent lock is proposed. Service relationship details can later derive from retained declarative bindings; current status alone supports service rows, not a dependency graph.

## Smallest plausible architecture

```text
Browser management UI
  │ authenticated, narrow same-origin requests
Explicit foreground dashboard process
  │ validates existing connection records; owner credentials stay here
  ├─ project owner A → existing runtime, routes, managed data
  └─ project owner B → existing runtime, routes, managed data

Owner private form ← native browser launch; separate private capability
```

The package serves fixed local assets and a narrow browser API from an explicitly launched foreground process. No OS service, global runtime, automatic startup dependency, or permanent project registry. Closing the page or stopping the dashboard process leaves owners and previews running. Use bounded status polling while visible and fetch logs on demand; no event bus or durable log service.

Discovery enumerates the existing private automatic-owner directory, validates records with the current permission/ownership checks, and authenticates each owner identity through the current client. Do not port-scan, trust a PID, or treat a connection record as execution authority. Reads never start owners. Explicit standalone endpoints and embedded library runtimes are outside automatic discovery initially; existing CLI/MCP use remains unchanged. Clean shutdown removes an automatic owner's record, so this is a view of known owners, not a permanent list of all projects or all retained data. [Project:73–94,175–198](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/project.ts#L73-L94), [owner cleanup:49–65](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/owner-process.ts#L49-L65)

Detached owners can still run older code after a package upgrade. Preserve status/Open/log access when a new operation is unsupported. Give the existing CLI Stop command when the owner cannot enforce guarded browser Stop; explain which action requires an owner upgrade. Never automatically shut down that owner or migrate its grants. Handle unsupported operations directly rather than introduce a version-negotiation framework.

The existing control listener deliberately rejects browser Origin headers. The browser bridge preserves that boundary and keeps owner tokens server-side. It uses native-launch bootstrap, a separate browser capability, immediate fragment removal, exact numeric Host/Origin checks, restrictive CSP, no CORS, fixed local assets, and bounded requests. Only validated owner identities and fixed management operations are accepted. [Daemon boundary:181–203](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/daemon.ts#L181-L203)

The dashboard stores its capability in per-tab `sessionStorage` so ordinary reload works. Browser session restore may retain that storage; closing a tab is not a guaranteed revocation boundary. Stopping the dashboard process ends its authority. If storage is unavailable, the fresh launch still works in page memory and reload needs a new launch. Private secret forms remain memory-only; their capabilities never enter dashboard storage. The dashboard capability is not a secret-write grant. Neither capability belongs in MCP output, logs, screenshots, or copied URLs.

Logs are trusted-local diagnostics with existing best-effort redaction, not guaranteed secret-free content. Fetch them on demand, render plain text, and do not automatically attach them to copied reports or screenshots. An authenticated local dashboard still cannot isolate a hostile same-user process or an agent controlling the browser. [Log/privacy limits](../docs/security.md#logs-and-secrets)

### Existing operations and actual additions

| Capability | Reuse | Necessary addition or limit |
|---|---|---|
| Find owners | Private records, token checks, owner info, cold project connection | Bounded enumeration helper; no permanent catalog |
| Overview and diagnostics | `list`, `get`, `logs`; active/candidate/latest/service/data summaries | Derived presentation only; no new lifecycle |
| Browser control | Current authenticated owner client | Narrow authenticated local bridge; no browser access to owner tokens |
| Stop/cancel/cleanup | Runtime operations and existing authorization | Expected-target guard for Stop; data deletion remains CLI-only |
| Private setup attention | Existing request entries/status and native opener | Bounded public request listing with project/recipient context, including pre-preview requests; explicit pending-form reopen |
| Read-only requested configuration | Existing normalization and redacted description | Retain unexpanded declaration per relevant attempt; bounded description operation |
| Start again / Retry start | Existing start, source validation, authorization | Exact current stopped/failed declaration; no active/candidate/busy/cleanup; canceled attempts excluded |
| Save as preview.yaml | Existing validated create-only saver | Exact retained attempt; fixed automatic-owner project root; no runtime mutation |
| Later live restart | Existing start/stop/replace and authorization | Targeted operation and explicit input semantics remain deferred |
| Edit existing YAML | Current loader and user's editor | Dashboard overwrite/editor deferred; create-only save is not edit support |

Public request listing exposes metadata only; it does not become another request store. Requests may precede slots, which is why adding an attention badge to preview status alone is insufficient. [Secret requests:19–103](https://github.com/RojhatToptamus/previewhost/blob/cf5326a/src/secrets-setup.ts#L19-L103)

## Implementation and verification plan

### 1. Prove useful navigation and authority

Implement discovery, the authenticated browser bridge, and a read-only list/detail with Open and bounded diagnostics. Validate empty, starting, ready, failed-update-with-live-app, unreachable-owner, and partial-cleanup states. Use two disposable worktrees and existing runtime operations. Gate: users can identify the correct copy and explain whether the displayed application or only its update failed.

### 2. Complete the first management release

Add guarded Stop, exact cancellation, supported cleanup retry, retained-data visibility, and private-request attention/handoff. Retain bounded unexpanded declarations for Start again and redacted configuration. Reuse normal startup for exact stopped attempts and explicit retries after failed startup. Test owner enforcement before relying on UI behavior. Gate: a person can complete private setup, stop and start one full stack again, and recover from a repaired startup failure while another stays usable.

### 3. Add explicit saving where it earns its cost

This slice now uses the retained declaration for explicit create-only YAML saving. It keeps raw input owner-side and treats the saved file as future input. Verify existing-file conflicts, relative paths, external sources, concurrent saves, and reuse after owner exit. A one-click live restart can follow if Stop and Start again prove cumbersome; validate before disrupting the application. Defer a full editor until observed tasks identify specific fields people need to change themselves.

### 4. Validate the complete experience in real clients

Use fresh disposable frontend/backend/PostgreSQL projects, fake credentials, actual Cursor chats and Claude Code, and Brave. Verify the local build loaded by each client. Use ordinary prompts without supplying corrected tool arguments. Distinguish automation from client observations in the report.

| Test group | Required proof |
|---|---|
| Identity | Same preview name in two worktrees; distinct visible changes and database writes; only intended copy stops or changes |
| Private flow | Missing/existing values; project-specific and explicitly shared refs; approval, delay, cancellation repeated across fresh chats, ended-turn continuation |
| Configuration slice | Direct spec without file creation; valid relative-path YAML; broken YAML reported; explicit save/reuse; existing-file conflict; unavailable declaration after owner exit |
| Lifecycle | Start/failure, failed replacement with old app live, exact cancellation, cleanup retry, stop/restart with data retained, owner shutdown/reapproval, disconnect/reconnect |
| Races | Agent replaces while user stops; candidate changes before cancel; CLI data operations retain their existing live/cleanup guards; stale action rejected without automatic retry |
| Package upgrade | Fresh dashboard with an older surviving owner: baseline controls work, unsupported additions are explained, no automatic shutdown |
| Browser security | Unauthenticated and wrong-Origin/Host requests denied; no token leakage; malicious labels/log HTML rendered inert; malformed/untrusted discovery records rejected |
| Application | Brave performs real frontend → backend → database writes and reads; open each returned hostname and numeric URL where supported |
| UI | Keyboard/narrow layouts, empty/loading/error states, long paths, log truncation, unavailable owners; screenshots omit private forms/capabilities/values |

Run focused existing tests first, then add behavior tests for new discovery, transport, operations, and races. Run broader suites/builds proportionate to those changes. Test real native processes, Keychain with disposable names, and local Docker data; mocks alone do not prove these boundaries. Never delete personal credentials or use production data. Report blocked clients honestly.

Existing tests to extend include [project ownership/worktrees](../src/project.integration.test.ts), [strict transport](../src/daemon.integration.test.ts), [private setup](../src/secrets-setup.integration.test.ts), [configuration failures/concurrent saves](../src/config.test.ts), and [managed data](../src/data.integration.test.ts). The initial research did not run runtime or visual tests. Implementation verification is recorded below.

## Setup, tradeoffs, and review outcome

**Required setup:** existing supported Node/macOS installation, project source/dependencies, an actual recipe, MCP registration when using an agent, execution authority, and Docker configuration when using managed databases. Private approval/value entry is required when references need it. The dashboard does not replace these requirements.

**Required to use the optional dashboard:** launch the local management page and keep its foreground process running. CLI/MCP-only usage continues to work. A browser-launch failure should provide a safe relaunch instruction, not print a private bootstrap URL. Reopening after that process exits launches a new session.

**Client limitations:** a short continuation message may be necessary after an agent turn ends; client permission modes may require tool-by-tool approval. Neither is a dashboard workaround for an owner defect. Persistent editor integration or a tray launcher can be evaluated later, without making them first-install dependencies.

The architecture review identified three gaps that changed this proposal: pending setup is independent of preview slots; complete direct declarations are not retained; and name-only mutations can act on a newer attempt than the user saw. The product review emphasized worktree identity, active-versus-update status, and separate data deletion. Both rejected copying Task Monki's approval/job/generation model and treating screenshots as a specification. A second product critique rejected a one-way Stop-only public release. This plan therefore includes bounded same-owner Start again, while keeping cold-owner recovery and visual editing separate.

The deliberate tradeoff is a useful first release with same-owner reuse, but without visual environment authoring or recovery of lost direct specs after owner exit. Existing operations remain available in CLI/MCP. No new persistent configuration, registry, source snapshots, secret namespace, agent scheduler, or inactivity lifecycle is proposed. The browser bridge and small owner contract additions each serve a specific missing user flow.

Before broadening scope, run short usability sessions with developers reviewing two agent-built copies. Observe whether they can open the right copy, diagnose a failed update, complete private setup, and stop without expecting data loss. Ask when they would restart or edit configuration themselves instead of asking their agent. Agent reviews are technical critique, not a substitute for those users.

No product decision blocks this research plan. Two scope choices need confirmation only if the desired first release differs: a permanent all-project catalog after owner shutdown, or a full configuration editor. Both require more than the proposed known-owner management surface. Do not add either implicitly.


## Initial implementation verification — 14 September 2026

- Focused dashboard/runtime/private-setup tests passed first (23 tests). The final
  `PREVIEWHOST_TEST_DOCKER_SOCKET=/Users/rojhat/.docker/run/docker.sock npm run verify`
  passed **118 tests, zero failures and zero skips**, using Node 22.23.1 and local Docker.
  An earlier run failed one multi-repo test because this worktree lacked its own
  `node_modules`; installing the locked dependencies fixed it. The focused rerun passed.
- A final focused runtime/dashboard/data run passed 29 tests after the cleanup-retry
  correction. The added assertion failed before the fix and passed afterward.
- Final typecheck/build passed after the last presentation fixes. A freshly packed
  local `0.1.0-alpha.1` package passed the existing disposable-consumer check: ESM,
  CLI, MCP transport, automatic owners, cleanup, and strict TypeScript declarations.
- New tests exercise real owner listeners/previews, stale Stop, concurrent Start again,
  declaration mutation isolation, deleted-source rejection, pending-only private
  reopening, unsafe discovery, and a hung owner alongside a healthy owner.
- Brave exercised two disposable project directories with frontend, Node backend,
  and separate managed PostgreSQL databases. Both performed real writes/reads. Private
  approval, delayed fake-value entry, deliberate cancellation, explicit pending-form
  reopening, and shared-value reuse through independent owner approvals were checked.
  The test Keychain was isolated; no personal credentials were read.
- Startup used a real MCP SDK transport harness against the local build. A subsequent
  harness call after private entry demonstrated continuation without a live waiter.
  **This initial pass did not include fresh Cursor or Claude Code agent UI tests.**
  The follow-up below closes that gap.
  These results do not establish model compliance or replace ordinary-prompt client tests.
- In Brave, Stop and Start again retained Cedar's database row while Birch stayed live.
  A deliberately failed replacement exposed logs while preserving the serving app;
  canceling a pending replacement also preserved it. A disposable Keychain auto-lock
  caused one clear startup failure; unlocking only that test Keychain restored startup.
- Default discovery found a newly launched automatic owner, older live owners, and
  unavailable records. Unrelated owners were inspected read-only. Separate dashboard
  processes reconnected to the same QA owners without starting or stopping them.
  Shutting down the fresh automatic owner removed it from the list; closing a dashboard
  left its application reachable. These initial checks preceded the follow-up change
  that retains dashboard sessions across reload.
- Browser checks covered empty/request/canceled states, search with no matches,
  requested configuration, log display, desktop and 390-pixel navigation, keyboard
  focus into details and back to the selected row. The console showed installed-browser
  extension errors; no dashboard JavaScript error was observed during these checks.
- Both applications' returned numeric and service hostname URLs were opened in Brave.
  Screenshots capture management and application results, without private forms or values.

Cleanup failures and stale-action races have automated coverage; a real Docker cleanup
failure was not deliberately induced in the browser. No customer usability session was
conducted. The complete research test matrix above remains a broader release checklist,
not a claim that every scenario received a new manual client test.

The initial complexity review retained one bounded declaration per existing attempt
for description and Start again. Explicit saving now reuses that same declaration.
The follow-up adds per-tab dashboard session storage, not a project/configuration store.
It adds no new package dependency, chat routing, secret namespace, task scheduler, or second runtime lifecycle. Existing
owner authorization, source validation, Keychain handling, and cleanup remain authoritative.


## Follow-up verification — 14 September 2026

The initial implementation was committed as `1c4cac0` before this follow-up.
Independent product and architecture reviews supported explicit recipe saving: people
can keep an agent's working direct spec and reuse it after its owner exits. A real
locked-Keychain failure also justified explicit Retry start. Both reuse existing
operations and the retained declaration. Full editing, live Restart, data deletion,
and cold-owner launching remain outside the dashboard; no new configuration store,
package dependency, authorization grant, or lifecycle was added.

### Actual clients and Brave

Used Cursor **3.20.21** (Grok Bot, Low) and interactive Claude Code **2.1.270**
(Sonnet 5, Low). Claude ran in Cursor's integrated terminal because native Terminal
control was unavailable. These were actual client interactions, not SDK prompts.
Both clients launched the disposable installed `0.1.0-alpha.1` package from this local
build. All 31 installed JavaScript files matched the build. Process paths confirmed
both MCP clients and their automatic owners used that installation. The final retry
change was loaded by explicitly restarting Amber's owner before testing it.

Cursor used one global registration with its existing unrelated configuration preserved.
Two chats created Cursor-managed worktrees `23or` and `rtp3` of the same disposable
`fieldbook-cursor` repository. Both owners had the same MCP process parent; a new chat
was not assumed to mean a new connection. A test-only preload directed native secret
storage to a disposable Keychain and private launches to Brave. No personal secrets
or production systems were used. The temporary Cursor registration was restored after
testing; existing test owners and applications remain running. Ordinary prompts described desired behavior; no
corrected tool arguments or manual per-worktree registrations were supplied.

| Workflow | Actual-client / Brave result |
|---|---|
| Two full Cursor environments | Passed: distinct frontend themes, backends and managed PostgreSQL; both running together |
| Independent second changes | Passed: Amber/Violet subtitles appeared only in their own applications |
| Direct specs without YAML | Passed in both Cursor chats and Claude; no automatic file creation |
| Dashboard Save and reuse | Passed: Amber saved relative `frontend`/`backend` paths and a symbolic secret reference; a second Save refused overwrite; Cursor reused the file for an update and after owner shutdown |
| Missing private values and delayed continuation | Passed: fake values entered privately in Brave; Amber resumed after its turn ended with a short continuation |
| Cancellation | Passed: Violet and Claude each observed canceled private setup and waited for explicit intent; this is observed model compliance, not a server guarantee against future new requests |
| Existing values / intentional sharing | Passed: distinct Cursor references; Claude explicitly selected Amber's exact reference and reused it only after separate approval, with no value entry |
| Owner shutdown / reconnection | Passed: Amber restarted from saved YAML, required fresh approval, reused the stored value and retained notes; Violet stayed running |
| Dashboard update cancellation | Passed: canceled a deliberately delayed Violet replacement; its prior app and Amber stayed available; the agent removed the test delay and updated successfully |
| Stop / Start again | Passed for all three real-client-created environments; each retained its own database notes and refreshed its URL |
| Failed startup / Retry start | Passed: deliberately locked the disposable Keychain, saw Amber fail, unlocked it and explicitly retried in Brave; other environments remained ready |
| Browser session / bridge shutdown | Passed: same-tab reload retained access; an independently opened tab lacked authorization; closing the dashboard showed disconnected status while apps stayed available |
| Real application operations | Passed: Brave wrote and read distinct notes through each frontend/backend/PostgreSQL chain, including after restart |

Final verified numeric and hostname URLs (local test processes, not permanent links):

- Amber: `http://127.0.0.1:63645` and `http://amber-fieldbook--web.localhost:63645`.
- Violet: `http://127.0.0.1:64439` and `http://violet-fieldbook--web.localhost:64439`.
- Claude: `http://127.0.0.1:49581` and `http://fieldbook--frontend.localhost:49581`.

Each URL was opened in Brave. Screenshots cover both Cursor chats, Claude's terminal
result, cancellation/retry states, the dashboard and all three applications. No private
forms, secret values or bootstrap capabilities were captured.

### Automated checks and remaining limits

Focused Save/runtime/configuration/dashboard/daemon tests passed **32/32**. Focused
MCP/private setup passed **13/13**. The broader compiled suite passed **121/121**, no
skips, using real disposable Docker databases and Keychains. After the bounded failed
retry change, focused runtime/secrets/dashboard tests passed **21/21**, including real
lock/unlock recovery, concurrent admission, stale/active rejection and canceled-attempt
rejection. Typecheck/build passed. The packed consumer check passed ESM, CLI, MCP,
automatic owners, cleanup and strict TypeScript declarations. Earlier valid coverage
of malformed YAML, cleanup failures, stale races, narrow layouts and keyboard access
was retained; unchanged workflows were not all manually repeated.

First-install friction remains distinct from required setup:

- Claude initially proposed native PostgreSQL despite the complete Previewhost request.
  A short product clarification to have Previewhost manage PostgreSQL corrected this;
  no native database was created. This was not an immediate unassisted success.
- Reloading a private form still loses its memory-only capability. Claude claimed a
  repeated setup request reopened the same pending form; the actual recovery used
  the dashboard's Open private form action. Dashboard reload now works independently.
- An initial Keychain error came from an incorrectly created disposable fixture path,
  repaired with an absolute path. Later deliberate lock/unlock tests exercised the
  product error and recovery paths. Neither required touching the personal Keychain.
- Manual client permission prompts required individual approvals. During one terminal
  interaction auto mode was selected accidentally, then restored to manual before
  subsequent approvals; this run does not prove every call received a manual prompt.
- Browser storage-denial fallback, browser session restoration and a real browser-driven
  Docker cleanup failure were not exercised. Server cleanup/race cases have automated
  coverage. No customer usability sessions were conducted.

Configuration edits remain in the user's editor/agent. Save is create-only and does
not apply configuration. Retry never opens a private form or bypasses owner authority.
Unsaved declarations disappear with owner memory; the dashboard does not launch cold
owners. These are explicit product limits, not hidden secondary state to be recovered.


## Designer redesign: implemented adaptation

The supplied Design Language and Dashboard HTML prototypes guided the visual redesign.
Their runtime, fixture data and rejected earlier design were not ported. The dashboard
still uses the existing DOM renderer, owner discovery and narrow management API.

The page now has an overview, searchable worktree navigation, a fixed detail hierarchy,
plain status words, and Activity, Logs and Configuration tabs. Both token sets are CSS
custom properties. Geist and Geist Mono ship locally with their OFL license; no font
CDN or new JavaScript dependency is required. Theme choice uses `previewhost.theme`
in local storage. It stores no runtime state or authority there.

### Product choices where the prototype differs

- The normal states retain Ready, Starting, Update failed, Needs secrets and Stopped.
  Startup failed, Cleanup incomplete, Not started and Unavailable describe real cases
  that those five labels cannot represent accurately.
- Serving and latest are runtime attempts, not Git builds or source snapshots. The
  split uses actual attempt IDs. Open app targets the serving application; source
  files remain live. No branch, originating client, progress percentage or build
  metadata is invented.
- Save as preview.yaml already ships, so it remains a working secondary action without
  a Proposed label. It creates a file for the selected attempt and refuses overwrite.
- Start preview uses the existing Start again operation. Retry start, Cancel update,
  Cancel startup and Retry cleanup preserve their existing guards. No new restart,
  retry-update, secret approval or data-deletion operation was introduced.
- Pending setup remains independent of a preview. The dashboard opens the existing
  private form; it neither approves references nor receives private-form capabilities.
- Narrow screens use compact navigation instead of retaining a 236px sidebar. Paths
  preserve the final two segments; parent directories can truncate without RTL text.
- Configuration presents declared service connections and every secret binding,
  including external database URLs. Literal and stored credential values stay omitted
  by the existing description contract. Commands remain trusted-local diagnostics.

Independent architecture and usability reviews caught lost retained-data rows after
owner restart, omitted external-database secret metadata, misleading startup/setup
labels, and an error-log action that did not reveal its target. These were corrected
without changing runtime ownership or authorization. The final diff keeps one DOM
renderer and one transient tab selection; it adds no project store, lifecycle or API.

### Redesign verification

Brave was driven with Playwright against the compiled local package and real daemon
owners. These are browser/runtime tests, not new Cursor or Claude Code agent tests.
The earlier actual-client evidence above remains separate; the redesign changes no
MCP schemas, runtime lifecycle, owner registration or private approval protocol.

The browser run used two disposable frontend/backend/PostgreSQL environments and a
separate disposable macOS Keychain. It verified:

- All nine requested views in light and dark themes: overview, ready, starting, failed
  update with a serving attempt, needs secrets, stopped, logs, configuration and empty.
- Real browser writes through frontend and backend into isolated PostgreSQL databases.
  Both numeric and hostname URLs were opened. Data remained after dashboard Stop/Start.
- Deliberate private cancellation, terminal canceled-request UI, private approval/value
  entry, and second-owner approval reusing an explicitly shared fake reference.
- A failed replacement retained the serving URL. Logs selected the failed attempt.
  Cancel update and Stop affected only the selected environment.
- Explicit configuration saving used relative project paths and refused a second save.
- Theme persistence after reload, keyboard tab navigation, 390px layout without
  horizontal page overflow, and no dashboard JavaScript page errors.

The first automation run attempted a new private form inside the existing one-second
rate limit. The server correctly rejected it. The runner respected that limit on the
subsequent completed runs. Screenshots never include private forms, values or bootstrap
capabilities. Local test URLs are ephemeral and change after Stop/Start.

Additional browser checks reproduced an owner restart with retained PostgreSQL data,
external-database reference metadata, an initial startup failure, delayed diagnostics
followed by navigation, an unavailable owner, an unauthenticated tab, and dashboard
shutdown. Each passed. Browser checks reported no dashboard page errors.

Validation totals for this redesign: typecheck and build passed; focused dashboard,
runtime and private-setup tests passed 12/12; the broad suite passed 113 with 9 opt-in
integration cases skipped and no failures. The skipped cases were not claimed as
rerun; the separate browser test exercised real PostgreSQL. A freshly packed consumer
passed local font/license loading, configuration save/load, ESM, native CLI startup,
MCP discovery/start/stop, resource cleanup and strict TypeScript declarations.

No new actual-agent prompt testing was performed for this visual change. Existing
Cursor and Claude Code verification above does not prove how those models behave on
future prompts. The dashboard still cannot launch a cold owner, edit configuration,
delete data, or guarantee continuous application health. Those boundaries remain as
documented; no prototype-only controls were added to imply otherwise.

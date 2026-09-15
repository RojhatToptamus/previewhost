# Integrations and tested support

## Platforms and interfaces

Applications can call the ESM library, execute the CLI, send local HTTP requests,
or expose MCP tools to a model. previewhost does not select a model.
Remote hosts need access to this machine's files and loopback network.
previewhost does not provide remote access.

The initial release supports macOS. Checks used macOS 26.5.1 on arm64 with
Node.js 22.23.1 and 24.19.0. Native execution rejects other operating systems.
Linux and Windows remain unverified, including static and attached previews.

| Interface | Verified behavior | Requirement or limit |
| --- | --- | --- |
| ESM library | Static, command, attach, replacement, cancellation, and cleanup | The application owns the runtime lifetime |
| CLI and daemon | JSON/YAML environments, selected inputs, authentication, and shutdown | Automatic project owner, or explicit foreground connection |
| MCP SDK | Environment lifecycle, secret setup/status, discovery, and tool errors | Client approval behavior requires a separate host check |
| Coding-task worktrees | Live edits, replacement, data retention, and source preservation | The host prepares and removes source directories |
| Task Monki | HTTP attachment, approval, readiness, replacement, and independent stop | Embedded runtime and browser UI integration remain unverified |

The MCP client, framework, browser, and Task Monki sections below record checks under the former package name, `previewd`.
The September 15 check covers global project approval. The September 13 checks cover the renamed package's automatic-owner flow in Codex, Claude Code and Cursor.
Older host results do not establish that flow.
Agent skill checks identify their tested package separately.
The configuration examples use the public `previewhost` executable from PATH.
The earlier host checks used an absolute Node executable and installed CLI path.
The client results apply to the named versions and configurations.
A configuration example or successful discovery alone does not establish a working preview workflow.

The [full-stack walkthrough](../examples/multi-repo/README.md) passed with the globally installed previewhost 0.1.0-alpha.0 CLI and local Docker databases.
Browser checks covered note writes, public backend routes, PostgreSQL and Redis reads, and replacement at the same URL.
Stop and daemon restart retained the data. Explicit deletion removed the test's owned containers, volumes, and credentials.
The external-database variant also passed with separate local PostgreSQL and Redis containers.
Preview stop left those containers and their data under their original owner.

## September 15 global-onboarding check

The local `0.1.0` development build used one global registration per client, without repository lists.
Checks used disposable repositories, an isolated test Keychain, fake credentials, and local Docker PostgreSQL.
Executable paths and loaded JavaScript build fingerprints were recorded without tool arguments or secret values.
Test-only injection routed Keychain calls to the disposable store; it was removed from global registrations afterward.
This isolates credentials for verification and is not required user setup.

| Actual client | Result |
| --- | --- |
| Cursor 3.20.21 | Two chats in separate worktree windows used the same MCP process. Each ran frontend, separate backend, and PostgreSQL. Updates and dashboard Stop/Start remained independent. |
| Claude Code 2.1.271, interactive terminal | Full environment and private setup passed with individual tool approvals. Auto mode blocked project-access calls before they reached Previewhost. |
| Codex CLI 0.154.0, interactive terminal | Project approval and a full environment passed. An initial literal dummy credential led to stronger guidance. A fresh project then used private setup, stopped after cancellation, and resumed full startup after delayed entry and a completed turn. |
| Codex desktop | MCP initialization was observed, but native UI control was unavailable. No desktop workflow pass is claimed. |

Cursor reused and explicitly saved YAML, diagnosed broken YAML, and recovered a failed update while the previous app kept serving.
Private-form cancellation, delayed entry, existing-value reuse, and intentional sharing were exercised in Cursor/Claude workflows.
Claude continued after private entry completed outside its interrupted turn. A finished turn can still need a continuation message.
Brave verified real note writes through the frontend and backend, isolated database records, hostname/numeric URLs, and retained data after restart.
The dashboard displayed the serving configuration and diagnosed broken root YAML separately.
A controlled slow retry exposed a stale failure notice; the display condition was fixed and retested in Brave.
Dashboard Cancel preserved the serving attempt. Configuration errors were checked in light/dark themes and a narrow window.
Codex exposed lost backend-source access after owner shutdown. Startup and private setup now restore the connection's already approved roots.
The regression failed before the fix and passed afterward over real stdio. The final installed build also passed live Codex owner recovery,
including private reapproval, existing-value reuse, and an exact comparison of the retained database row.
In that live retry, the agent also called `preview_access` again; the no-repeat-access recovery path was verified by the automated test.
Claude and both Cursor chats reconnected, reapproved their projects, and found their existing environments unchanged.

These observations establish behavior for these trials, not guaranteed model compliance.
Current-build Cursor-managed worktrees in the same window were not exercised; the older check below is separate evidence.
Client-native keyboard/clipboard failures interrupted some follow-up trials. They are not Previewhost runtime failures.
The automated release suite passed 126 tests without skips; focused MCP and package-consumer checks also passed.
Automated tests covered both negotiated MCP protocol paths, forged/replayed approval rejection, cancellation, symlink escape rejection,
reconnection, owner restart, fixed-daemon restrictions, and source approval without command-execution authority.

## September 14 agent-guidance check

Cursor 3.20.21 (Grok Bot Low) and Claude Code 2.1.270 (Sonnet 5 Low) used the local `0.1.0-alpha.1` build with updated MCP guidance.
Both clients used fresh MCP processes. Their executable paths and tool descriptions matched the installed local build.
Claude ran interactively inside Cursor's terminal with individual tool approvals.

Both agents prepared complete frontend/backend/PostgreSQL environments without YAML, absolute-path errors, or reserved environment bindings.
They chose project-specific secret references without corrected arguments in user prompts.
Each agent stopped after three deliberate cancellations across this check, including one with the final wording.
These observations establish model compliance in these trials, not a server guarantee against another setup request.

Brave handled private fake-value entry and application checks through the normal runtime and Keychain mechanisms.
Delayed entry passed. Claude resumed startup after private entry completed outside its interrupted turn.
Both clients explicitly saved YAML with relative source paths and restarted with retained database data.
Cursor also recovered after owner shutdown and diagnosed and repaired a deliberately truncated YAML file.
Claude reused an explicitly selected reference from the Cursor project after private approval. Their database records remained separate.
Brave verified hostname and numeric URLs, database writes, updates, and deletion of a disposable row.
The Maple application remained live after Claude exited. After reconnection, Claude found the same ready environment through MCP.

Claude first missed application dependencies and the frontend build prerequisite. It diagnosed the logs, installed dependencies, built the frontend, and retried successfully.
Cursor required a full restart to refresh cached tool descriptions. Neither issue required another Previewhost runtime mechanism.
Concurrent worktree routing, browser-launch failure, and partial Keychain writes were not repeated in these model trials.
The automated suite separately passed 112 tests, with no skips. Final focused tests passed 19 tests, and the installed-package consumer check passed.

## Agent skill

Use the [README installation and usage steps](../README.md#use-the-agent-skill).
The npm package includes `dist/skills/previewhost/SKILL.md` and materialized references. An agent can read them directly without installing a skill or accessing the repository.
Repository-based discovery installation remains optional.
The repository contains one `skills/previewhost/SKILL.md` entrypoint for preview operation and recipe creation.
Its references link to the maintained documentation and examples. Agents read these documents only when the task needs them.

The [skills CLI](https://github.com/vercel-labs/skills) resolves those repository symlinks into files during installation.
The installed references remain readable without the source checkout.
Local installation passed with skills 1.5.25 on macOS 26.5.1 in default and `--copy` modes after the source checkout became unavailable.
That result does not establish support for other installers or copying methods.
Repeat `skills add` to refresh the installed files, including reference-only changes.

Remote project installation from the default branch passed with skills 1.5.25 while access to local source checkouts was denied.
Codex CLI 0.146.0 discovered the installed skill and loaded its recipe guidance. All required references resolved within the installed directory.
Install from the default branch:

```sh
npx skills add RojhatToptamus/previewhost --skill previewhost --agent codex --yes
```

The installer found the project skill, and all installed references remained readable without the source checkout.

Select `--agent codex`, `claude-code`, `cursor`, or `opencode` for project installation.
The following table describes each client's documented discovery and invocation convention.
It does not establish execution support for untested clients.

| Client | Project discovery and invocation |
| --- | --- |
| [Codex CLI](https://developers.openai.com/codex/skills) | Reads `.agents/skills`. Use `$previewhost` or `/skills`. |
| [Claude Code](https://code.claude.com/docs/en/skills) | Reads `.claude/skills`. Use `/previewhost`. |
| [Cursor](https://cursor.com/docs/context/skills) | Reads `.agents/skills`. Select `/previewhost` in Agent chat. |
| [OpenCode](https://opencode.ai/docs/skills/) | Reads `.agents/skills`. Ask the agent to load the `previewhost` skill. |

Codex CLI 0.146.0 passed a native skill workflow with previewhost 0.1.0 on macOS 26.5.1.
With explicit `$previewhost` use, it discovered and loaded the installed skill and created a command recipe from a project without one.
It inspected the recipe, started the preview, waited for readiness, and verified the returned URL's page and health response against the application source.
After stop, it confirmed stopped state, a closed preview listener, an unreachable URL, and unchanged source files.
Its sandbox denied `ps`; separate host checks confirmed that no application processes or upstream listeners remained.

The check used Codex workspace-write permissions with direct network access and a separate daemon with source access and execution permission.
The CLI needs direct loopback access to the daemon. A proxy-only network configuration did not complete this workflow.
Automatic skill selection and other clients' skill workflows remain unverified.

Skill selection can also follow the task description. Automatic selection depends on the client and request.
Skill installation does not install previewhost, start its daemon, configure MCP, or grant execution permission.

## Connect an MCP client

Follow the [README MCP quick start](../README.md#use-mcp) for one global registration. The client confirms project access; registration supplies execution and database startup options.
Use the client configuration below for your host.
Each example starts the adapter with `previewhost` from PATH.
previewhost 0.1.0-alpha.0 passed static and README frontend/backend workflows through the CLI and MCP protocol.
The README embedded-library example also passed.
Cursor Agent 2026.09.02-c22c1a3 discovered all twelve tools through the project configuration.
That discovery check used no model.
For executable lookup errors, see [PATH troubleshooting](troubleshooting.md#the-client-cannot-find-previewhost).

After replacing a local MCP build, restart the client and open a fresh chat.
Cursor can retain old tool descriptions after **Reload MCP Server** or **Reload Window**.
Its [MCP update guide](https://cursor.com/docs/mcp) recommends a full Cursor restart for local server changes.
Confirm the new descriptions are available before testing agent behavior.

Use absolute source paths in MCP specs. The [API reference](api.md#http-and-mcp)
lists tool arguments. For a custom daemon, add `--endpoint` and `--token-file`
to the MCP arguments. Keep token values out of configuration files.

Discovery exposes 14 `preview_*` tools without an owner. Inspection works offline.
Global project approval, start/replace and secret setup can start the owner; read/status/cleanup tools never do.
A client disconnect leaves owner previews active.
Development servers require daemon execution permission through `--allow-exec`.
Client approval does not grant that permission.

## Codex

Add this server to your [Codex MCP configuration](https://developers.openai.com/codex/mcp/):

```toml
[mcp_servers.previewhost]
command = "previewhost"
args = ["mcp", "--allow-exec"]
```

### September 13 automatic-owner check

Codex CLI 0.146.0 passed a live model workflow against this branch's built CLI, using temporary invocation overrides and no saved configuration changes.
The project had no YAML or installed Previewhost skill. The agent read the application, prepared a spec, requested private setup, waited for public completion, started the application and verified `/health`.
The test harness performed the owner-only approval and entry with a disposable Keychain and fake value. No value or private capability appeared in the agent transcript, and no configuration file was created.
The first name failed the existing lowercase-name rule; the agent corrected it. A pre-start `get` returned `NOT_FOUND` and the agent continued normally.
This was not a zero-error transcript or a manual human approval usability study.

Separate Chrome checks exercised the private approval, entry, completion, cancellation and unavailable-link screens at desktop and mobile sizes.
Separate SDK/CLI checks exercised automatic owner sharing, concurrency, worktree roots, disconnection and restart.
The live check preapproved this disposable server's tools. It did not retest every host approval policy below or the desktop registration UI.
This historical check predates client-native project approval. Use the current global setup above.

### MCP approvals

Codex 0.146.0 with `gpt-5.5` passed standalone-command and API/web workflows
through `exec` and App Server. Each successful model run called inspect, start,
wait, and stop for both previews. HTTP checks covered successful startup, API connectivity,
and the URLs passed to the applications. Process groups and listeners closed after stop and daemon shutdown.

Approval policy and reviewer selection are separate controls.
Selecting `auto_review` alone does not prove that automatic review ran.
All configurations below used a read-only sandbox.

| Client and policy | Approval configuration | Result |
| --- | --- | --- |
| `exec`, `never` | `auto_review`, default MCP approval modes | Inspect passed. Exec canceled startup elicitation before dispatch |
| App Server, `never` | The client accepted each requested operation | Both workflows passed with client-mediated approval |
| `exec`, `on-request` | `auto_review`, start/stop approval mode `prompt` | Both workflows passed. Four completed reviews preceded mutation dispatch |
| App Server, `on-request` | `auto_review`, start/stop approval mode `prompt` | Four agent decisions reported `approved`. No client approval requests occurred |

For the verified automatic-review path, use this server and approval configuration.
Replace the earlier `previewhost` server entry with this example.
Place the first five options before any table headers in the Codex configuration:

```toml
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "read-only"
features.guardian_approval = true
features.tool_call_mcp_elicitation = true
[mcp_servers.previewhost]
command = "previewhost"
args = ["mcp", "--allow-exec"]

[mcp_servers.previewhost.tools.preview_start]
approval_mode = "prompt"

[mcp_servers.previewhost.tools.preview_stop]
approval_mode = "prompt"
```

Use the same server name in the tool rules and server definition.
The `exec` trace omitted decision payloads. Its approval result is an inference
from successful dispatch after each completed review. App Server recorded the
actual decisions with `decisionSource: agent`. Each request can receive a different decision.
See [Codex automatic review](https://learn.chatgpt.com/docs/sandboxing/auto-review).

For client-mediated approval, App Server sends `mcpServer/elicitation/request`
with `_meta.codex_approval_kind: "mcp_tool_call"`.
Check the server, tool, arguments, task, and turn against the authorized operation.
For an approved call, return `{"action":"accept","content":{},"_meta":null}` with the received request ID.
This grants that call without a saved approval.
See the [App Server protocol](https://learn.chatgpt.com/docs/app-server).

Direct App Server MCP calls also passed the shared-notes database workflow:
HTTP writes, replacement, cancellation, data retention, and explicit deletion.
That check used no model turns.

### Codex Desktop

Codex Desktop in ChatGPT 26.901.51231, build 8109, remains unverified.
The computer-use tool blocked access to `com.openai.codex` before a model turn.
The block prevented selection of **Approve for me** and inspection of the effective configuration.
No desktop MCP calls or reviewer decisions were observed.
This test access restriction does not establish a previewhost defect.

## Cursor and other MCP hosts

In Cursor, use the [global registration in the README](../README.md#use-mcp).
Each chat supplies its worktree through the tool's `project` field.
Global registration uses `preview_access` to request client confirmation without repository lists.
The dated checks below describe earlier implementations; they do not establish verification of the new access flow.
A fixed `--project` remains a default for clients that serve one project.

Use the host's approval controls to enable the server and its tools.
Other stdio MCP hosts can use these executable arguments.
Unlisted clients and models remain unverified.

### Cursor IDE

#### Global registration and Cursor worktrees

Cursor 3.20.21 passed the shared-connection routing check on September 14.
Two actual chats in one Agents window used Cursor-managed Git worktrees of the same disposable repository.
The visible model was Grok Bot, with High effort for Amber and Low for Violet.
One global MCP registration authorized the repository through `--root`; neither worktree had a manual MCP registration.

Cursor documents [global registration and workspace interpolation](https://cursor.com/docs/mcp), plus [managed worktrees](https://cursor.com/docs/configuration/worktrees).
These features do not establish that each chat gets a separate MCP process.
In this check, both chats sent tool calls to one process launched from the user's home directory.
The old connection-wide project selection therefore read the wrong root YAML and routed equal preview names to the same owner.
An absolute source path in a spec did not change that owner selection.

Using `--project ${workspaceFolder}` did not reliably repair the global Agents path in this client.
Some launches resolved the placeholder, while others passed it literally.
That check used one authorized repository root and the tool's required `project` argument on every call. The current global setup replaces manual root lists with client confirmation.
Both agents supplied their own checkout paths, including on later turns, through the same MCP process.
A first call without the newly required field failed; the agent corrected it without configuration coaching.

Each chat received an ordinary heading/color prompt, followed by a distinct subtitle prompt.
Both full applications ran simultaneously with separate frontend, backend, PostgreSQL, source paths, and private data directories.
Brave 153.1.95.101 showed only the corresponding worktree's edits and database note at each returned URL.
Both worktrees explicitly referenced one fake Keychain entry. Each owner required private approval; only the first needed value entry.
The agents diagnosed missing dependencies from startup failures and installed them in their own worktrees.
Stopping either preview closed its URL while the other remained usable with the same ready attempt.
Both restarted with their own saved notes and new public ports.
Amber's first restart failed because the disposable Keychain was locked. Unlocking that store and an ordinary retry restored it.

Reloading the Agents window retained the same MCP process.
After a deliberate, graceful MCP process stop, Cursor offered an **Authenticate** action for the existing server.
That action launched a new process from the refreshed local installation; both chats then used it successfully without registration changes.
Both preview owners and their exact ready attempts survived. This client recovery required a click; it was not automatic reconnection.

The check used a fresh local `previewhost@0.1.0-alpha.1` package with Node 22.23.1.
Installed JavaScript and declaration files were compared with the local build; the unchanged package version alone was not treated as proof.
A test-only preload selected Brave and a disposable native Keychain. Personal secrets were not used.
A metadata-only trace recorded MCP process IDs and submitted paths, excluding values, results, and private form capabilities.
An initial trace-wrapper bug was corrected before interpreting successful tool calls; early connection errors were not counted as product evidence.

Separate automated tests exercised two Git worktrees over one real stdio connection with managed PostgreSQL.
They covered concurrent startup, equal names, independent owners/data, cross-project attempt IDs, stale Git entries, denied roots, and stop/restart isolation.
These are automated runtime checks, not additional Cursor model turns.
The broad suite passed 112 tests with zero skips. The final focused run passed nine tests.
A clean tarball consumer passed, and HTTP contract tests passed against both running full stacks, including database create/read/update/delete operations.
Final review corrected the instructions for fixed-endpoint connections; focused automated checks passed afterward.
The last Cursor refresh initially stopped at a locked Mac. A resumed check later that day completed verification of commit `64f9dad`.

After a host restart, the temporary installation, repository metadata, and disposable Keychain were absent.
The old worktree files and database data were preserved. Two fresh Cursor-managed worktrees used a durable disposable fixture and fresh local package installation.
Only the existing global registration's fixture paths changed; no per-worktree registrations were added.
Both chats used the same MCP process for full-stack startup, private setup, distinct edits, replacement, and independent stop/restart.
Brave verified both returned URL forms and separate database notes before and after restart.
One private fake-value entry served both owners after separate approvals.
After deliberate MCP process loss, Cursor's **Authenticate** action restored both chats through one new process.
Both exact ready attempts survived reconnection. The final code needed no further changes.
This resumed run passed nine focused tests, the clean package-consumer checks, and two HTTP contract tests against the actual running stacks.
The earlier 112-test suite was not repeated during this resumed check.

The agent must know its checkout path. Previewhost cannot infer chat identity from a shared connection.
Authorization is configured once per repository or source root; new unrelated repositories still require explicit authorization.
Linked worktrees inherit repository source authority, but execution permission and owner-specific secret approval remain separate.
No chat registry, Cursor-specific runtime, or dashboard was added.

#### Earlier Cursor IDE checks

Cursor IDE 3.20.7 (Auto) passed a fresh full-stack check on September 13.
The project was an isolated copy of `previewhost-test-frontend` in `previewhost-test-lab`, with its sibling backend and managed PostgreSQL.
The agent read all three repositories, installed application dependencies, and prepared service bindings and source paths.
The project server exposed 14 tools through **Customize > MCPs**. Existing **Allow all** settings produced no per-call prompts.

The check installed a newly packed local `previewhost@0.1.0-alpha.1` tarball in a clean directory.
Every installed JavaScript and declaration file matched the current build byte for byte.
The registration used absolute Node and installed CLI paths, so the same version number on npm was not used as evidence of build identity.

| Actual IDE scenario | Result |
| --- | --- |
| No YAML | Direct spec started PostgreSQL, backend and frontend; no YAML was created. |
| Private setup | Missing fake value, delayed entry, public completion and continuation after the agent ended its turn passed. |
| Configuration | Explicit save, default root-file reuse, malformed-file errors, restoration and create-only save collision passed. Invalid input preserved the active preview. |
| Owner lifecycle | Stop/restart and owner shutdown/restart retained notes. Cold list did not launch an owner. New approval reused the existing value without entry. |
| Client reconnection | Workspace reload preserved the owner, URL and exact ready attempt. |
| Real Git worktrees | Two new worktrees ran full environments with separate data directories. One reused the exact shared secret; the other used a distinct privately entered value. Neither created YAML. |
| Cancellation | Cancel after name approval left the value missing. A fresh request completed, then the agent started the distinct worktree. |
| Failed replacement | A missing frontend entrypoint failed with `START_FAILED`. Bounded logs diagnosed it. The active attempt survived, and a valid replacement kept the URL. |

Brave 153.1.95.101 opened the returned hostname and numeric URLs for all three environments.
Browser checks wrote separate PostgreSQL notes and verified persistence after restart and replacement.
Separate HTTP contract tests exercised create, read, update, delete and repeated-delete behavior against each running full stack.

Changing an initial registration exposed a Cursor connection problem: the UI showed connected tools while agent calls timed out.
A new server name after workspace reload restored actual tool calls. Later worktree registrations and ordinary reconnection succeeded.
This is an observed client workaround, not a Previewhost transport fix or a guarantee for every Cursor version.

Both client checks used a disposable native Keychain fixture and fake values.
A test-only preload redirected Keychain calls to that store and selected Brave for the native browser opener.
The preload reached detached owners through `NODE_OPTIONS`; passing only Node `--import` arguments did not reach them because owners clear `execArgv`.
MCP handlers, authorization, private HTTP routes and application startup were unchanged.
No values or private capabilities were captured in screenshots.
The fresh automated run passed 111 tests with zero skips; focused tests, TypeScript checks and a clean tarball consumer also passed.

Earlier check:

Cursor IDE 3.19.14 with Composer 2.5 Fast passed standalone-command and API/web
workflows through model-driven inspect, start, wait, and stop calls.
The mode was **Allowlist (with Sandbox)**, with an empty MCP allowlist and
**MCP Tools Protection** off. No MCP approval overrides applied.

Inspect, start, and wait had no observed per-call prompts.
Both stop calls required manual approval through **Run** before dispatch.
No automatic-review decision payload was captured.

HTTP checks covered successful startup, API connectivity, and the URLs passed to the applications.
All application processes, MCP connections, and listeners closed after cleanup.
These IDE checks used Node.js 22.23.1 and no databases or stored secrets.

### Cursor Agent

Cursor Agent 2026.08.25-3e8eec8 passed the shared-notes database workflow in a
headless model turn. HTTP checks covered PostgreSQL writes, Redis values, and
replacement of all three applications at the same URL.
Stop retained data. A separate client reopened the environment, checked the
values, and explicitly deleted the fixture data. The recorded result does not
identify the model or establish IDE database support.

## Claude Code

Use the `mcpServers` JSON structure above in a file such as `previewhost.mcp.json`.
From the project directory, start Claude Code with that file:

```sh
claude --mcp-config ./previewhost.mcp.json --strict-mcp-config --model sonnet --effort low --permission-mode manual
```

Claude Code 2.1.270 passed a fresh full-stack check on September 13, using a separate installation of the same local tarball described above.
The actual terminal client ran inside Cursor's integrated terminal because Computer blocked Terminal.app access.
It displayed Sonnet 5 and used manual per-call approval, project-only settings and an explicit fresh MCP registration with 14 tools.

The agent inspected the frontend, backend and database repositories, installed dependencies, and prepared a direct three-service spec without YAML.
An initial unapproved secret reference failed with `SECRET_DENIED` before startup.
Private cancellation, a fresh request, delayed fake-value entry and continuation after the agent ended its turn passed.
The agent observed public completion and started the complete PostgreSQL/backend/frontend environment.

Explicit YAML saving and default-file restart passed. Both inspect and start rejected malformed root YAML without an inline fallback.
Restoring the exact valid file made inspection succeed; the parse failures preserved the running attempt.
Stop/restart and owner shutdown/restart retained the database note.
Cold list did not start an owner. Fresh private approval reused the stored value without another entry field.

Brave opened both returned URL forms and created and edited a database note.
The application stayed reachable after a real Claude exit. After resume, the agent confirmed the exact same ready attempt and URLs through MCP.
A separate HTTP contract test passed against this running full stack.
The additional shared/distinct worktree and failed-replacement scenarios were driven by Cursor, not repeated in Claude.

The earlier locked-store check motivated the current instruction that partial setup results require a fresh request.
The fresh build includes that wording, but this fresh Claude run did not reproduce a partial write.
Automated native-store tests covered locked, partial and unknown outcomes separately.

Earlier check:

Claude Code 2.1.239 passed both standalone-command and API/web workflows in its
interactive terminal. Sonnet with low effort was available.
The client displayed **Sonnet 5 with low effort** and recorded `claude-sonnet-5`.

The tested permissions allowed inspect/wait and required approval for start/stop.
All four start/stop calls required **Yes** for the current request before dispatch.
This was manual approval. HTTP checks covered successful startup, API connectivity, and
the URLs passed to the applications. Stop and client exit released the application processes, MCP
process, and listeners. The separate daemon also shut down.

These checks used Node.js 22.23.1 and installed `previewd@0.1.0`.
Other models and permission modes remain unverified. Database and secret checks for 2.1.270 are recorded above.
See [Claude Code model configuration](https://code.claude.com/docs/en/model-config).

## OpenCode

Add this server to your OpenCode configuration:

```json
{
  "mcp": {
    "previewhost": {
      "type": "local",
      "command": ["previewhost", "mcp"],
      "enabled": true
    }
  },
  "permission": {
    "previewhost_preview_inspect": "allow",
    "previewhost_preview_wait": "allow",
    "previewhost_preview_start": "ask",
    "previewhost_preview_stop": "ask"
  }
}
```

OpenCode 1.18.25 with `openai/gpt-5.5` passed standalone-server and API/web
previews through its interactive `--mini` terminal. No reasoning variant override applied.
The model called inspect, start, wait, and stop for each preview.

The tested permissions allowed inspect/wait and required approval for start/stop.
All four start/stop calls required **Allow once** before dispatch.
No automatic reviewer or saved approval was used.
HTTP checks covered successful startup, API connectivity, and the URLs passed to the applications.
Stop and client exit released the application processes, MCP process, and listeners.
The separate daemon also shut down.

These checks used Node.js 22.23.1 and installed `previewd@0.1.0`.
Other models, permission modes, databases, and secret workflows remain unverified.
See [OpenCode permissions](https://dev.opencode.ai/docs/permissions/).

## Private secret setup

Codex App Server 0.146.0 with `gpt-5.5` and Cursor Agent 2026.09.02-c22c1a3
with **Auto** passed the workflow to enter a missing secret and retry startup.
Save started no application. The retry delivered the value, and logs redacted it.
Client transcripts contained neither the value nor the private form grant or control token.

These host checks used synthetic storage and intercepted owner entry.
Separate tests used disposable macOS Keychains and the Chrome 152 owner form.
Browser checks covered validation, save, edit, cancel, partial results, expiry,
and keyboard focus on desktop/light and mobile/dark viewports.

The backend rejected `gpt-6-astra` on Codex 0.146.0 and required a newer client.
The passing check used `gpt-5.5`. Cursor **Auto** did not report its underlying model.

The packaged helper ran as arm64 and as x86_64 under Rosetta.
Native Intel hardware and interactive approval after a package update remain unverified.
See [Keychain access and updates](security.md#stored-secrets-and-private-entry).

## Existing task worktrees

The [task workflow](worktrees.md) passed with two Git worktrees that contained
staged, unstaged, and untracked changes. Startup failure, replacement,
cancellation, disconnect, and stop preserved their source files and Git metadata.
Codex App Server 0.146.0 used direct MCP calls, without model turns.
Stop/start retained one task's data and kept a second task's data separate.

Chrome 152 passed browser writes and reads through numeric and readable frontend
origins at desktop and mobile widths. The browser showed saved notes, reporting
results, and the stopped-backend state without application errors.

Codex's command runner passed installation, generation, failure, and cancellation checks.
Abrupt App Server loss left its setup processes alive.
The host must stop those processes before it retries setup or removes their source.
Setup included in a preview's HTTP startup command continued after the client disconnected
and stopped with the preview. This does not repair external host processes.
See [preparation ownership](worktrees.md#prepare-and-start).

## Task Monki

Task Monki can attach to previewhost's numeric loopback URL.
It owns the consumer recipe, attachment, approval, worktree, and consumer process.

1. Start the backend through previewhost.
2. Add an HTTP attachment and its service dependency to the Task Monki consumer recipe.
3. Pass the attachment origin through the recipe's `attached-http-origin` environment binding.
4. Bind that attachment to the ready previewhost URL.
5. Resolve and approve the Task Monki preview plan.
6. Start the Task Monki consumer preview.
7. After use, stop the consumer in Task Monki.
8. Stop the backend through previewhost.

Task Monki revision `aded142d47e1453d88fc028d9b060d5dd43babe0` passed this workflow
with its real service, SQLite store, Git worktree, approval, and native consumer.
The consumer fetched two backend versions at one URL.
Each system stopped its own processes independently and preserved source files.
Embedded runtime integration, Compose, the private vault, Design previews, and
the Task Monki browser UI remain unverified.

## Framework configuration

Install project dependencies before startup. The daemon requires `--allow-exec`
and access to each project directory through `--root`.
Replace the `/absolute/...` paths below with existing project directories.
Save the selected spec as `preview.json` in your application directory.

With the daemon active, run these commands from that directory:

```sh
previewhost start --file preview.json
previewhost get PREVIEW_NAME
```

Replace `PREVIEW_NAME` with the spec's `name`. Open the returned URL.
After use, run `previewhost stop PREVIEW_NAME`.
To close the daemon, run `previewhost shutdown`.

Vite 8.2.2 and Next.js 16.3.4 passed Chrome 152 checks on Node.js 22.23.1.
Both served interactive pages and source updates through numeric URLs and
`<name>--web.localhost` environment aliases, including WebSocket connections.
Desktop and mobile checks found no error overlay or application errors.
Python 3.14.6 passed HTTP and native process cleanup checks.

### Vite

```json
{
  "name": "vite-app",
  "type": "command",
  "cwd": "/absolute/vite-app",
  "command": ["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"]
}
```

Before startup, add this configuration to the Vite 8 project's `vite.config.js`:

```js
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    ws: process.env.PREVIEW_URL
      ? { clientPort: Number(new URL(process.env.PREVIEW_URL).port) }
      : undefined,
  },
});
```

This sets the WebSocket client to the public preview port.
Earlier Vite versions use `server.hmr.clientPort` and remain unverified.
See [Vite server options](https://vite.dev/config/server-options) and
[Vite command arguments](https://vite.dev/guide/cli.html).

### Next.js

```json
{
  "name": "next-app",
  "type": "command",
  "cwd": "/absolute/next-app",
  "command": ["node", "node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"],
  "timeoutMs": 120000
}
```

The CLI waits at most 30 seconds per request.
If initial compilation takes longer, run `get` and another `wait` with the returned attempt ID.
See the [Next.js CLI reference](https://nextjs.org/docs/app/api-reference/cli/next).

### Python

```json
{
  "name": "python-site",
  "type": "command",
  "cwd": "/absolute/site",
  "command": ["python3", "-m", "http.server", "{port}", "--bind", "127.0.0.1"]
}
```

Python must exist on the daemon PATH. This command uses Python's file server
and its file-access rules. Use a `static` spec for previewhost's own file restrictions.

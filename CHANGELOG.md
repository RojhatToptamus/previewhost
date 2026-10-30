# previewhost

## 0.6.0-alpha.0

### Minor Changes

- f152507: Let embedders start the supervisor of repository commands themselves, for example as another user, with `applicationProcesses`. Those commands start from the embedder's base environment, stop through the embedder, and leave crash recovery to it. The supervisor checks port ownership as the command's own user. `applicationSupervisorFiles()` lists the supervisor files to install for that user. With `applicationProcesses`, Compose image builds are refused; use `image:`.
  
  Run Docker Compose on private copies of the Compose, env, secret, and Dockerfile files read once during inspection, so a file changed or replaced afterwards is not used. This applies to every embedder: those files are now refused when reached through a symlinked directory or when they have more than one hard link, a Dockerfile, including an implicit `Dockerfile`, is refused when it is a symlink or larger than 64 KiB, and a Dockerfile-specific ignore file such as `Dockerfile.dockerignore` that is a symlink or has a second hard link refuses the build, and so does a Dockerfile-specific ignore file when Compose 5 has no Docker Buildx, since its legacy builder would not apply it. Build contexts must be local directories inside the source; remote and `~` contexts are refused.
  
  On macOS and Linux, static previews check the opened file's own path, so a directory replaced by a link during a request can no longer make them serve a file outside their directory.

## 0.5.1

### Patch Changes

- 0839dcf: Preserve redacted supervisor startup logs and distinguish supervisor failures from command failures. Report readiness timeouts with the readiness path, deadline, and last response so desktop integrations can show useful recovery steps.

## 0.5.0

### Minor Changes

- 4d0a097: Add desktop runtime APIs for persistent configuration, process recovery, source permissions, and controlled application replacement. Support packaged Electron hosts and CommonJS imports.
  
  Add workers, named ports, health probes, bounded restarts, and isolated Compose environments. Preserve accepted configuration after failed updates and fix streamed log formatting.

## 0.4.0

### Minor Changes

- 878285d: Start previews from local folders and worktrees in the dashboard. Edit environment bindings, save configuration files, and review changes before applying them. File edits preserve unmodified values and reject stale saves; direct configurations can run without creating a file.
  
  Compare previews across projects, pin and reorder sidebar projects, and give logs more working space.

## 0.3.1

### Patch Changes

- 923b180: Show startup dependencies and current readiness failures, and allow explicit recovery after cancellation without weakening data or secret safeguards.
  
  Preserve dashboard navigation and log filters, add surrounding search context, and display available projects while slower owners are still loading. Simplify configuration saving and Secret Manager controls.
  
  Group linked worktrees by repository, with branch labels and compact expandable sidebar lists. Keep the full overview searchable and preserve independent preview actions.
  
  Refine dashboard controls and contrast, show both application URLs, and fix favicons and browser page titles.
  
  Prevent completed setup jobs from reporting a startup failure when their final result arrives after the supervisor exits.

## 0.3.0

### Minor Changes

- 66a4bdf: Add Linux and Windows x64 support for native previews and automatic project owners, with platform-specific ownership locks, private storage, and process cleanup.

  Windows databases are experimental and tested with WSL Docker. Docker Desktop remains unverified. macOS and Linux retain x64 and ARM64 support; Windows ARM64 is unsupported.
- d295b72: Clarify failed updates and link failed resources to their logs. Add read-only prerequisite checks, secret search and pagination, log refresh with Clear view, and clearer reset and deletion results.

### Patch Changes

- d295b72: Show the current private setup request without stale cancellation messages from earlier requests.

## 0.2.0

### Minor Changes

- 7047993: Store secrets in a password-protected encrypted keystore, with optional automatic unlock through macOS Keychain.
  
  For earlier installations, initialize the keystore with `previewhost secrets init` and enter required secrets through the private browser form. Use a fresh data directory for new managed databases. Existing secrets and database data remain intact.
- f148c3b: Add finite setup jobs with explicit dependencies, retained seed results, and guarded reruns through the library, CLI, MCP, and dashboard.
- 5941fc6: Add a dashboard Secret Manager for listing references and privately replacing stored values. Use previewhost Keychain service names, item labels, and helper identities without migrating old entries.
- f3ea745: Use Previewhost names for runtime directories, Docker resources, the managed PostgreSQL user and database, and the gateway hop header.
  
  Before updating, stop existing owners with the installed version. Export any database data you need through that version. Earlier runtime directories and managed database records are not migrated. Follow the reset instructions in README.md before starting new previews.
- 4374df2: Rebuild the dashboard with React and shared UI components. Add stable navigation, searchable and wrapping logs, readable preview URLs, and bounded configuration and secret lists.
- f148c3b: Add source-filtered, cursor-based logs and confirmed dashboard data reset using existing stop, deletion and startup operations.
- af214d3: Register MCP once across projects and worktrees with explicit source approval. Restore approved backend access after owner restart, and show configuration errors without hiding the running application.

### Patch Changes

- f3ea745: Use preview.yaml as the default configuration filename, with preview.yml as a fallback. Reject ambiguous defaults and refuse to save over either existing file. Explicit file selections remain supported.
- 1ef7af6: Give automatic project owners private database storage without requiring a Docker socket override.
- 4fca058: Replace the Previewhost logo and improve dashboard sidebar spacing, alignment, hover states, and keyboard focus in both themes.

## 0.2.0-alpha.0

### Minor Changes

- af214d3: Register MCP once across projects and worktrees with explicit source approval. Restore approved backend access after owner restart, and show configuration errors without hiding the running application.

## 0.1.0

### Minor Changes

- 64bb312: Add an optional local dashboard for comparing worktrees, opening applications, inspecting services and logs, canceling updates, and stopping or restarting previews with retained database data.

  Reuse owner authorization for private-form handoff, exact-attempt configuration saving, and failed-start recovery. Include light and dark themes, bundled fonts, and README product screenshots.

  Use the same design system for private secret approval, entry, and recovery. Clarify worktree registration errors and project owner shutdown scope.
- 56567b8: Include library, CLI, HTTP, and MCP interfaces for local application previews on macOS.
- b88c14f: Start persistent project owners automatically from CLI and MCP. Bare clients now target the current project; use an explicit endpoint or token file for a manual daemon.

  Approve secret references through the private owner form, reuse existing Keychain values, wait for completion, and resume normal startup. Add optional root preview.yml, MCP file input, explicit create-only configuration saving, owner shutdown, source associations, CLI version output, and the packaged agent guide.

### Patch Changes

- 56567b8: Document global installation and connected frontend/backend previews through the CLI, MCP, and embedded library. Clarify database setup, replacement, and cleanup in the multi-service walkthrough.

## 0.1.0-alpha.2

### Minor Changes

- b88c14f: Start persistent project owners automatically from CLI and MCP. Bare clients now target the current project; use an explicit endpoint or token file for a manual daemon.
  
  Approve secret references through the private owner form, reuse existing Keychain values, wait for completion, and resume normal startup. Add optional root preview.yml, MCP file input, explicit create-only configuration saving, owner shutdown, source associations, CLI version output, and the packaged agent guide.

## 0.1.0-alpha.1

### Patch Changes

- 56567b8: Document global installation and connected frontend/backend previews through the CLI, MCP, and embedded library. Clarify database setup, replacement, and cleanup in the multi-service walkthrough.

## 0.1.0-alpha.0

### Minor Changes

- Release the initial macOS alpha with library, CLI, HTTP, and MCP interfaces for local application previews.

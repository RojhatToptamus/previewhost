# previewhost

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

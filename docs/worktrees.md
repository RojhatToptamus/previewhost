# Preview the current coding task

previewhost runs existing task directories, including uncommitted files and installed
packages. The coding host manages Git, installs dependencies, generates files, and removes task directories.
The daemon owns the preview's application processes, routes, and managed databases.

## Select the task and its source

1. Supply the task's actual checkout root as `project` on every automatic MCP call.
2. Use the task's existing frontend and backend paths.
3. Choose one preview name from the host's stable task identity.
4. Retain the submitted service paths and preview name in the host's task context.
5. Read the project commands and the selected environment file.
6. Check each service path and its command entrypoint.

Use one global registration without repository lists. `preview_access` asks for approval of each worktree and its required source directories.
The agent supplies `project`; the user does not edit registration between chats. Explicit `--root` restrictions remain supported.
A new chat does not imply a new MCP connection. No operation relies on the previously selected project.
With `--docker-socket` and no `--data-dir`, each automatic owner uses separate private data storage.
See the [current client checks](integrations.md#september-15-global-onboarding-check).

Branches do not need matching names. One repository can supply several services.
Paths in a configuration file resolve relative to that file.
An absolute command entrypoint still selects that file after a `cwd` change.

If no suitable checkout exists, use the source owner's preparation tools.
previewhost does not create checkouts or change Git state.

## Prepare and start

The example below uses a parent directory that contains the task worktrees.
Replace both `/absolute/...` paths with your source parent and private data directory.
Keep the data directory outside any task directory that the host can remove.
Managed databases also require the [database prerequisites](../examples/multi-repo/README.md#install-the-dependencies).

Normal automatic mode gives each canonical worktree root a separate owner. Use `--project` when launch context is uncertain.
For an explicitly shared owner across the task worktrees, this optional manual example starts a foreground daemon:

```sh
previewhost serve --root /absolute/task-worktrees --allow-exec \
  --data-dir /absolute/private-preview-data
```

`previewhost` must be on PATH. A local installation also provides
`./node_modules/.bin/previewhost` from the application directory.
`--allow-exec` permits ordinary execution as your user, without a sandbox.
Multiple tasks can share this daemon with different preview names.
For this manual example, append `--endpoint http://127.0.0.1:9400` to every CLI client command below, and pass that endpoint in the MCP registration.
Bare client commands use automatic project mode instead.

From the coding host, complete these steps:

1. Read `get` or `preview_get` for the task name before another start.
2. Before another setup attempt, wait for previous setup to finish or cancel it through the host.
3. Before setup changes files used by running previews, stop the affected previews.
4. Run the project's preparation through the host's command runner.
5. Wait for successful completion and process cleanup.
6. If preparation fails or cleanup remains uncertain, stop this procedure.
7. Inspect the environment spec with the actual service paths.
8. Start the environment.
9. Call `wait` or `preview_wait` with the returned attempt ID.
10. Open the ready URL and check the application's browser operation.

The host runner owns cancellation and cleanup of its preparation processes.
After a lost connection, check the original command through that host.
While cleanup is uncertain, retain source and block conflicting installation,
generation, or build retries. A port, directory, or process name alone does not
establish process ownership.

The tested Codex App Server version left setup processes alive after a crash.
`preview_stop` cannot clean up that external preparation.
See the [integration result](integrations.md#existing-task-worktrees).

An HTTP startup command can install dependencies or generate files before it serves requests.
That work must finish within the startup timeout.
The daemon owns that command through startup and stop.
This also permits setup that needs the service's managed database credentials.
Browser builds need their public URLs before the build.
A command that exits without serving HTTP is not a preview service.

### Shared-notes task recipe

The [task recipe](../examples/multi-repo/worktrees.mjs) accepts existing
directories with this shared-notes layout:

```text
frontend task/              backend task/
  server.mjs                 package.json
  index.html                 node_modules/
  app.js                     api/server.mjs
  style.css                  reporting/server.mjs
```

The backend's preparation must supply `pg` and `redis` before startup.
The frontend needs no packages.
The [example guide](../examples/multi-repo/README.md) describes the application and database requirements.

The npm package does not include this recipe.
[Clone and build the source](../CONTRIBUTING.md#build-and-install-a-tarball) to prepare its library import.
With the daemon active, run this command from the previewhost repository root.
Replace the frontend and backend placeholders with the existing task paths:

```sh
node examples/multi-repo/worktrees.mjs \
  --name task-notes-42 \
  --frontend /absolute/task-worktrees/frontend-task \
  --backend /absolute/task-worktrees/backend-task \
  | previewhost start --file -
```

Open the returned `url`. The page can save a note and read it through both backends.
The recipe prints a JSON spec with your task name and service paths.
It performs no source preparation.

`--file PATH` selects an edited shared-notes environment file instead of the
example default. That file supplies commands, bindings, readiness, and database types.
The recipe preserves command arguments and unrelated service paths.
Its directory arguments resolve from the current directory.

For inspection, change `start` to `inspect` in the command above.
For MCP, pass the same JSON object as `spec` to `preview_inspect` and `preview_start`.
Use `preview_wait` with the returned candidate ID.
For a custom daemon, add its `--endpoint` and `--token-file` client arguments.

## Continue the task

Live edits follow the application's reload or restart behavior.
Startup readiness does not check later edits.
Application commands can load `.env` files. previewhost does not load them itself.
Some applications give `.env` values priority over variables that previewhost supplies.

`{service: api}` selects the candidate dependency and waits for its readiness.
`{browserUrl: api}` supplies the public alias for browser code.
Before replacement finishes, that alias can still reach the active application.

During replacement, the old and new processes can use the same source directory.
Their dependencies and build output must work for both versions.
If the application cannot support overlap, stop it before preparation and startup.
Failed replacement does not restore source files, database writes, or migrations.

The same task name retains managed data across stop/start.
Different names keep managed databases separate under one data owner.
Equal external database URLs still share data.
Daemon access and native execution provide no security isolation between tasks.

## Stop before source removal

1. Find every preview that uses the directory, including previews from other tasks.
2. Stop each preview and wait for successful cleanup.
3. Resolve external preparation and the host's other source users.
4. After every process that uses the directory stops, remove or move it through the host.

Current `get` and `list` responses include `sources` on active, candidate and latest attempts, and on incomplete cleanup records.
Paths become canonical after source validation. Check the actual consuming attempts until every related process stops. An edited configuration can omit paths from older attempts.
If the host cannot identify those directories or processes, keep the source and do not retry setup.

A wait timeout leaves startup active. Cancel requires the exact candidate ID
and preserves an active attempt. After an uncertain response, read status before
another start, replacement, or stop. Missing status after a daemon restart does not prove that old
native processes stopped.

For the recipe above, stop the environment from your application directory:

```sh
previewhost stop task-notes-42
```

Stop preserves source and database data. To permanently remove this task's
managed database data after stop, run:

```sh
previewhost delete-data task-notes-42
```

Attached services remain under their original owner.
After all tasks finish with the daemon, run `previewhost shutdown`.
See [recovery limits](security.md#recovery) before source removal after a crash.

## Secret names across worktrees

The same exact `{secret: ID}` uses one Keychain value wherever that name is approved.
Each automatic worktree owner needs its own private approval, unless the name was explicitly selected at launch.
Existing values are reused; the form collects only missing values. For a different worktree value, choose a different qualified ID and change that binding explicitly.
Do not overwrite the shared entry or introduce a hidden worktree-specific copy. YAML remains optional.

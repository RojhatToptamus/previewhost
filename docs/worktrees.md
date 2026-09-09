# Preview the current coding task

previewhost runs existing task directories, including uncommitted files and installed
packages. The coding host manages Git, installs dependencies, generates files, and removes task directories.
The daemon owns the preview's application processes, routes, and managed databases.

## Select the task and its source

1. Use the task's existing frontend and backend paths.
2. Choose one preview name from the host's stable task identity.
3. Retain the submitted service paths and preview name in the host's task context.
4. Read the project commands and the selected environment file.
5. Check each service path and its command entrypoint.

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

In a separate terminal, start the daemon:

```sh
previewhost serve --root /absolute/task-worktrees --allow-exec \
  --data-dir /absolute/private-preview-data
```

`previewhost` must be on PATH. A local installation also provides
`./node_modules/.bin/previewhost` from the application directory.
`--allow-exec` permits ordinary execution as your user, without a sandbox.
Multiple tasks can share this daemon with different preview names.

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

The packaged [task recipe](../examples/multi-repo/worktrees.mjs) accepts existing
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

With the daemon active, run this command from the directory with your installed previewhost package.
Replace the frontend and backend placeholders with the existing task paths:

```sh
node node_modules/previewhost/examples/multi-repo/worktrees.mjs \
  --name task-notes-42 \
  --frontend /absolute/task-worktrees/frontend-task \
  --backend /absolute/task-worktrees/backend-task \
  | ./node_modules/.bin/previewhost start --file -
```

Open the returned `url`. The page can save a note and read it through both backends.
The recipe prints a JSON spec with your task name and service paths.
It performs no source preparation.

`--file PATH` selects an edited shared-notes environment file instead of the
packaged default. That file supplies commands, bindings, readiness, and database types.
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

Current `get` and `list` responses omit source paths.
The host must remember which directories each submitted spec uses until every
related process stops. An edited configuration can omit paths from older attempts.
If the host cannot identify those directories or processes, keep the source and do not retry setup.

A wait timeout leaves startup active. Cancel requires the exact candidate ID
and preserves an active attempt. After an uncertain response, read status before
another start, replacement, or stop. Missing status after a daemon restart does not prove that old
native processes stopped.

For the recipe above, stop the environment from your application directory:

```sh
./node_modules/.bin/previewhost stop task-notes-42
```

Stop preserves source and database data. To permanently remove this task's
managed database data after stop, run:

```sh
./node_modules/.bin/previewhost delete-data task-notes-42
```

Attached services remain under their original owner.
After all tasks finish with the daemon, run `./node_modules/.bin/previewhost shutdown`.
See [recovery limits](security.md#recovery) before source removal after a crash.

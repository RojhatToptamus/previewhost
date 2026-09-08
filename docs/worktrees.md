# Preview the current coding task

previewd runs the task directories supplied by the coding host, including
uncommitted files and existing packages. The host owns Git and source lifetime.
The daemon owns application processes, routes, and managed databases.

## Select the task and its source

1. Use the task's existing frontend and backend paths.
2. Choose one preview name from the host's stable task identity.
3. Retain the submitted service paths and preview name in the host's task context.
4. Read the project commands and the selected environment file.
5. Verify each service path and its command entrypoint.

Branches do not need matching names. One repository can supply several services.
Relative config paths resolve from the config file, not from a repository selector.
An absolute command entrypoint still selects that absolute file after a `cwd` change.

If no suitable checkout exists, use the source owner's existing preparation tools.
Creating another checkout is unnecessary for an existing task directory.
previewd performs no clone, checkout, reset, clean, or source deletion.

## Prepare and start

The daemon must already run under its selected owner. For trusted task code,
the owner can admit a parent containing the task directories:

```sh
previewd serve --root /absolute/task-worktrees --allow-exec \
  --data-dir /absolute/private-preview-data
```

The owner remains alive after individual CLI or MCP clients disconnect.
The private data directory belongs outside task directories that the host can remove.
Multiple tasks can share this owner with different preview names.

1. Read `get` or `preview_get` for the task name before another start.
2. If installation or generation is necessary, stop affected previews before incompatible writes.
3. Run the project's preparation commands through the host's command runner.
4. If preparation fails or cancellation remains unresolved, stop this procedure.
5. Inspect one environment spec with the actual service paths.
6. Start the environment and wait for the returned attempt ID.
7. Open the ready URL and test the application's browser operation.

A host runner must own cancellation and cleanup of its setup processes.
previewd adds no installer. Explicit project commands can install packages or
generate files as part of their intended work.

Normal cancellation does not prove cleanup after abrupt host loss. Source remains
in place while setup cleanup is uncertain. Project preparation that must outlive
the agent client can run inside its explicit application startup command.
The daemon then owns that process through readiness and stop.

Setup that needs managed database credentials can run in its owning service's
startup command before HTTP readiness. Browser builds need their public URLs
before the build. A command that exits successfully without serving HTTP is not
a preview service.

### Shared-notes task recipe

The packaged [task recipe](../examples/multi-repo/worktrees.mjs) accepts existing
directories for the shared-notes application:

```text
frontend task/              backend task/
  server.mjs                 package.json
  index.html                 node_modules/
  app.js                     api/server.mjs
  style.css                  reporting/server.mjs
```

The backend's project preparation supplies `pg` and `redis` before startup.
The frontend has no package dependencies. The [example guide](../examples/multi-repo/README.md)
lists the local Docker image prerequisites.

From the directory containing your installed previewd package, run:

```sh
node node_modules/previewd/examples/multi-repo/worktrees.mjs \
  --name task-notes-42 \
  --frontend /absolute/task-worktrees/frontend-task \
  --backend /absolute/task-worktrees/backend-task \
  | ./node_modules/.bin/previewd start --file -
```

The recipe prints one ordinary JSON spec. It does not start another owner or
store another workspace record. It changes only the name and the three source
paths in the example's existing environment spec.

`--file PATH` selects an edited shared-notes environment file instead of the
packaged default. That file owns commands, bindings, readiness, and database choices.
The recipe does not rewrite command arguments or unrelated service paths.
Its directory arguments resolve from the current directory.

For inspection, change `start` to `inspect` in the command above.
For MCP, supply the same JSON object as the `spec` argument to `preview_inspect`
and `preview_start`. Use `preview_wait` with the returned candidate ID.
Custom owners require the existing `--endpoint` and `--token-file` client arguments.

## Continue the task

Live edits follow the application's reload or restart behavior. Startup readiness
does not certify later edits. Existing `.env` files remain available to the application.
previewd does not load them itself. Explicit bindings avoid manual port edits,
subject to the application's own environment-file precedence.

`{service: api}` selects the candidate dependency and adds a readiness edge.
`{browserUrl: api}` supplies the public alias for browser code. Before replacement
finishes, that public alias can still reach the active application.

Overlapping replacement requires compatible shared build output and dependencies.
If the application cannot support overlap, use stop, project preparation, and start.
Failed replacement does not restore earlier source files or committed migrations.

The same task name retains its managed data across stop/start. Different names
isolate managed databases under one data owner. Equal external database URLs
still share data. Native execution and daemon access are not per-task security boundaries.

## Stop before source teardown

1. Find every submitted preview that consumes the directory, including another task's preview.
2. Stop those previews and await successful cleanup.
3. Resolve the host's other source users before removing or moving the directory.

An edited config cannot reconstruct all paths used by older attempts. Current
`get/list` responses omit those source paths. The host must retain the associations
from submitted specs until active, candidate, and cleanup consumers finish.

If those associations or previous-owner cleanup are uncertain, retain the source.
If the host cannot coordinate another task's directory lifetime, keep the initial
integration within source lifetimes that it controls together.

A wait timeout leaves startup running. Cancellation needs the exact candidate ID
and does not stop an active attempt. An uncertain response requires status
reconciliation before another mutation. Missing status after an owner restart
does not prove that old native processes stopped.

Stop preserves source and database data. Source removal remains the host's operation.
Explicit `delete-data` removes verified managed data separately. Attached services
remain under their original owner. See [recovery limits](security.md#recovery).

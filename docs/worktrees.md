# Worktrees

Run previews from several Git worktrees at once, with separate ports and managed databases for each worktree.

## Select a worktree

Previewhost uses the canonical Git worktree root as the project. Outside Git, it uses the current directory.
From a worktree with root `preview.yaml`, run:

```sh
previewhost inspect
previewhost start --allow-exec
```

To select a worktree from another directory, pass its path explicitly:

```sh
previewhost start --project /absolute/task-worktree --allow-exec
```

Replace the path with your existing worktree. Use the same `--project` for later status, replacement, stop, and shutdown commands.
Equal preview names in different worktrees remain independent.

With MCP, the agent supplies the actual worktree path as `project` on every call.
One [global registration](mcp.md) serves multiple worktrees. `preview_access` asks for approval of each worktree and its additional source directories.
A shared MCP connection does not identify which chat made a call.

Previewhost does not create worktrees or change Git state. Prepare the worktree with Git or your coding client before startup.

In the dashboard, **New preview** lists known project folders and their registered Git worktrees, including worktrees without running previews.
For another existing folder, choose **Enter a folder path** and supply its absolute path.
Discovery does not scan your machine. Selecting a folder does not move an existing preview, copy configuration, or share managed data.
Review that folder's file or pasted configuration before startup. See [dashboard startup](dashboard.md#start-a-preview).

## Prepare and start

Read the application's instructions and install its dependencies in the selected worktree.
Check command entrypoints as well as working directories. An absolute entrypoint can still refer to another worktree after a `cwd` change.
Paths in `preview.yaml` resolve relative to that file.

If preparation changes files used by a running preview, stop that preview first.
Wait for preparation to finish before startup.
Alternatively, declare finite preparation as [setup jobs](jobs.md) so Previewhost owns their execution and cleanup.
Commands that run separately in a terminal or coding client remain under that tool's control.

After startup, wait for the returned attempt ID and check the application at its returned URL.
The [CLI tutorial](first-preview.md) shows these steps. The [dashboard](dashboard.md) groups linked worktrees under their repository.
Separate clones and non-Git folders stay separate, even when their names match.

For services in separate repositories, use their existing directories in one environment.
Their branch names do not need to match. MCP requires approval for each source directory.
The [shared-notes example](../examples/multi-repo/README.md) includes a [recipe program](../examples/multi-repo/worktrees.mjs) that accepts separate frontend and backend worktrees.

## Continue work

Source files stay live. Edits follow the application's own reload behavior and can affect a running server before replacement.
Readiness checks only startup, so check the application again after edits.

During replacement, the old and new processes can use the same source directory and managed databases.
Their dependencies, build output, and database schema must support that overlap.
If they cannot, stop the preview before preparation and startup.
A failed replacement does not restore source files, database writes, or migrations.

Stop/start retains managed data under the same preview name and owner.
Two external database entries with the same URL still share data.
Separate owners do not sandbox native commands or isolate them from other files on your machine.

## Stop before removing a worktree

1. Find every preview that uses the directory, including previews in other projects.
2. Stop each preview and wait for successful cleanup.
3. Stop any preparation processes owned by your terminal or coding client.
4. Remove the worktree only after all processes that use it stop.

Current `get` and `list` responses include `sources` for active, candidate, and latest attempts, plus incomplete cleanup records.
Check these paths before removal. An edited configuration can omit sources still used by an older attempt.

From the selected worktree, stop a preview named `app`:

```sh
previewhost stop app
```

Stop preserves source files and managed data. Attached services remain under their original owner.
To remove disposable database data, follow [data deletion](databases.md#keep-or-remove-managed-data).
After all previews in the worktree finish, run `previewhost shutdown` to close its owner.

After a crash or lost response, read status before another operation.
Missing status after owner restart does not prove that old processes stopped.
See [cleanup recovery](troubleshooting.md#replacement-or-cleanup-is-incomplete) before removing their sources.

## Share or separate secrets

The same exact `{secret: ID}` uses one keystore value wherever that reference is approved.
Each owner needs private password unlock unless automatic unlock is available on macOS.
Each automatic owner needs its own approval unless the reference was selected at startup.
For a different value in another worktree, use a different reference. See [Secrets](secrets.md).

## Use one manual owner

A manual daemon can manage several worktrees under different preview names.
Use this mode only if you want one owner to control their lifetime and storage.
In a foreground terminal, run:

```sh
previewhost serve --root /absolute/task-worktrees --allow-exec \
  --data-dir /absolute/private-preview-data
```

Replace both paths. Keep private data outside source directories that you can remove.
Managed databases also need the [database prerequisites](databases.md#prepare-docker).

Append `--endpoint http://127.0.0.1:9400` to every client command for this daemon.
For a custom token path, also pass the same `--token-file` to the daemon and its clients.
Bare commands use automatic project mode instead.
Within a shared owner, distinct preview names keep managed databases separate.

# Dashboard

Inspect previews across live project owners, open the right application, and diagnose a failed start or update.

## Open the dashboard

After a preview starts through the CLI or MCP, run this in another terminal:

```sh
previewhost dashboard
```

The command opens your default browser. Keep its terminal running while you use the dashboard.
Closing the page or stopping this command does not stop your previews.

The dashboard lists live automatic project owners. Standalone `serve` instances and embedded runtimes do not appear automatically.
It does not start owners or grant execution permissions.

## Find the right preview

![Preview overview with separate Storefront worktrees](../assets/dashboard-worktrees.png)

Use the source path to distinguish worktrees. **Open app** opens the serving attempt, even if a later update failed.
The theme button switches between light and dark mode.

## Inspect services and updates

Open a preview's **Activity** tab to see services, setup jobs, and available recovery actions.
**Serving** identifies the active application. **Latest update** identifies the replacement attempt.

![Failed update beside the serving attempt and its ready services](../assets/dashboard-update.png)

| What you need | Action and consequence |
| --- | --- |
| Diagnose a failure | Open the failed job's **Logs**, or choose its attempt in the Logs tab. |
| Abandon a pending update | **Cancel update** leaves the previous application running. |
| Stop the preview | **Stop** ends owned processes and retains managed data. |
| Start after stop | **Start preview** uses retained configuration and current source. Its URL can change. |
| Retry a failed initial start | **Retry start** reruns that attempt after you fix its cause. |
| Start with fresh managed data | **Reset data** names the databases before confirmation. Deletion cannot be undone. |

Start and retry do not reload `preview.yml`. To apply recipe changes, use CLI or MCP start/replace with the updated file.
See [setup jobs](jobs.md#progress-and-recovery) for explicit reruns and reset behavior.

## Read logs

![Logs for a failed migration, with attempt, source, and search controls](../assets/dashboard-logs.png)

Choose the attempt before comparing output. A failed replacement and a serving app have separate logs.
Then select a service or job, or use **All output**.
Search ignores letter case. **Clear** or Escape restores the captured lines.
Logs are bounded tails, not a permanent archive.

## Save configuration and manage secrets

In **Configuration**, **Save as preview.yml** writes the selected attempt's recipe to the project root.
It never overwrites an existing file and does not change the running application.
Secret references remain references. Stored values do not appear in this view.

**Secret Manager** edits existing stored references. **Open private form** handles missing values and access approval.
See [Secrets](secrets.md) before changing a value shared across projects.

# Secrets

Bind a stored credential by name. Approve access and enter missing values in a private browser form, outside the agent conversation.

## Declare references

In a command service, bind the application's variable to a Keychain reference:

```yaml
env:
  API_TOKEN: {secret: "shop/dev/api-token"}
```

`API_TOKEN` is the application variable. `shop/dev/api-token` identifies the stored value.
The same exact reference shares one value across every project and worktree that approves it.
Use a different reference for a different value. Preserve existing references unless you intend to change the binding.

Stored secrets require macOS 13 or later and the packaged Keychain helper.
`--allow-exec` does not select secrets by itself.

## Approve and enter values

From the project with root `preview.yaml`, run:

```sh
previewhost secrets setup --allow-exec
```

For a different file, add `--file PATH`. MCP uses `preview_secrets_setup` with the project and its file or spec.

The private form shows the requested names and recipients.
Approve the intended access, then enter missing values. Existing values are reused.
The approval lasts for this owner's lifetime.

After saving, use the request ID from setup:

```sh
previewhost secrets status REQUEST_ID --timeout-ms 25000
```

Replace `REQUEST_ID` with the actual ID. A `complete` result means setup finished, not that an application started.
Read the current recipe and preview status before starting or replacing the preview.
If the agent turn ended, send it “Secrets saved—continue”.

If setup is `pending` or `saving`, keep the same request ID.
If you cancel the form, that request stays canceled. Partial saves retain completed writes.
Use the [recovery guide](troubleshooting.md#stored-secrets-are-missing-or-inaccessible) for expired forms or access errors.

## Change a stored value

In the dashboard's **Secret Manager**, find the reference and select **Edit**.
The list shows names, never stored values. Saving changes future starts in all projects that use that reference.
Running applications keep the value they already received.

For terminal entry:

```sh
previewhost secrets set shop/dev/api-token
previewhost secrets list
```

`set` uses hidden input. It stores a value but does not grant an owner access to it.
Keep secret values out of command arguments, recipes, and agent chats.

## Understand the boundary

Only declared recipients receive a resolved value. Previewhost hides values from status and uses best-effort log redaction.
Application code can still expose credentials through files, transformed output, or HTTP responses.
Private entry does not protect secrets from hostile code with your user permissions.

For explicit launch selections, stdin entry, deletion, and size limits, see the [secret reference](api.md#stored-secrets).

---
"previewhost": minor
---

Let embedders start the supervisor of repository commands themselves, for example as another user, with `applicationProcesses`. Those commands start from the embedder's base environment, stop through the embedder, and leave crash recovery to it. The supervisor checks port ownership as the command's own user. `applicationSupervisorFiles()` lists the supervisor files to install for that user. With `applicationProcesses`, Compose image builds are refused; use `image:`.

Run Docker Compose on private copies of the Compose, env, secret, and Dockerfile files read once during inspection, so a file changed or replaced afterwards is not used. This applies to every embedder: those files are now refused when reached through a symlinked directory or when they have more than one hard link. Build contexts must be local directories inside the source; remote and `~` contexts are refused.

Static previews no longer serve a file outside their directory when a directory on its path is replaced by a link during a request.

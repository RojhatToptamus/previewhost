---
"previewhost": minor
---

Let embedders start the supervisor of repository commands themselves, for example as another user, with `applicationProcesses`. Those commands start from the embedder's base environment, stop through the embedder, and leave crash recovery to it. The supervisor checks port ownership as the command's own user. `applicationSupervisorFiles()` lists the supervisor files to install for that user. With `applicationProcesses`, Compose image builds are refused; use `image:`.

Run Docker Compose on private copies of the Compose, env, secret, and Dockerfile files read once during inspection, so a file changed or replaced afterwards is not used. This applies to every embedder: those files are now refused when reached through a symlinked directory or when they have more than one hard link, a Dockerfile, including an implicit `Dockerfile`, is refused when it is a symlink or larger than 64 KiB, and a Dockerfile-specific ignore file such as `Dockerfile.dockerignore` that is a symlink or has a second hard link refuses the build. Build contexts must be local directories inside the source; remote and `~` contexts are refused.

On macOS and Linux, static previews check the opened file's own path, so a directory replaced by a link during a request can no longer make them serve a file outside their directory.

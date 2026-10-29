---
"previewhost": minor
---

Let embedders start the supervisor of repository commands themselves, for example as another user, with `applicationProcesses`. Those commands start from the embedder's base environment, stop through the embedder, and leave crash recovery to it. The supervisor checks port ownership as the command's own user. `applicationSupervisorFiles()` lists the supervisor files to install for that user.

Run Docker Compose on private copies of the Compose, env, and secret files read once during inspection, so a file changed or replaced afterwards is not used.

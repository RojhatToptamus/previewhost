# CI performance investigation

The investigation separates existing CI from the unmerged Linux and Windows work.
The benchmark starts at main commit `36ed345`, without those platform changes.
Three agent reviews checked workflow structure, test isolation, source behavior, and comparable projects.
The next strategy below is a proposal. It has not been implemented or qualified.

## Measured baseline

GitHub job and step timestamps from five successful runs show:

| Run | macOS job | Docker startup | Image pulls | Release verification | Package check |
| --- | ---: | ---: | ---: | ---: | ---: |
| [35535639888](https://github.com/RojhatToptamus/previewhost/actions/runs/35535639888) | 22m30s | 3m59s | 1m34s | 15m42s | 23s |
| [35541625843](https://github.com/RojhatToptamus/previewhost/actions/runs/35541625843) | 25m51s | 5m20s | 1m36s | 17m34s | 27s |
| [35548604769](https://github.com/RojhatToptamus/previewhost/actions/runs/35548604769) | 26m27s | 5m24s | 1m57s | 17m44s | 32s |
| [35549306748](https://github.com/RojhatToptamus/previewhost/actions/runs/35549306748) | 28m07s | 5m10s | 1m29s | 20m24s | 23s |
| [35551077245](https://github.com/RojhatToptamus/previewhost/actions/runs/35551077245) | 26m00s | 4m30s | 1m43s | 18m31s | 26s |

These are execution times, not approval or queue delays. Run 35551077245 also waited about 35 minutes before execution.
Documentation jobs already run independently and finish in 44–49 seconds. They do not determine the critical path.
Dependency installation took 14–24 seconds on the sampled macOS jobs.

Run 35551077245 spent 1,073.05 seconds in its 163 tests, or 96.6% of release verification.
Type checking took about 13.7 seconds. Build, test compilation, and native fixture preparation took about 23.1 seconds.
The largest test-file totals were jobs (364.1s), worktree example (165.0s), data (151.2s), project (74.4s), and project database (72.8s).
Database diagnostics measured 33.3 seconds for initial startup, 20.4 seconds for reopening, and 3.0 seconds for stopping.

In run 35551077245, Colima startup included two VM boots and provisioning. Downloading its disk image took about four seconds; decompression took about 40 seconds.
A successful [historical QEMU run](https://github.com/RojhatToptamus/previewhost/actions/runs/35528170825) still took about 26.7 minutes.
It used 458 seconds for combined Docker setup and 1,063 seconds for verification.
Different source revisions prevent a causal comparison; these measurements do not justify reverting to QEMU.

The current-main [release attempt](https://github.com/RojhatToptamus/previewhost/actions/runs/35579987616/job/106270458643) hit the 30-minute job limit.
It reported 160 test results without a final summary, so publication was skipped. GitHub's job annotation confirms the timeout.
The second attempt also hit the 30-minute limit, after 121 test results. Neither attempt qualifies as a passing baseline.

Colima's [Docker startup code](https://github.com/abiosoft/colima/blob/v0.10.3/environment/container/docker/docker.go#L82-L104) explains the second boot.
It restarts when root can access Docker but the ordinary user's session cannot, to activate Docker-group membership.
No verified safe configuration switch removes that recovery. Docker provisioning remains unchanged.

## Coverage and duplication review

- Packing already disables lifecycle scripts. The workflow builds production output once; it does not repeat the full source suite during packaging.
- Production and test Keychain binaries differ intentionally. Both builds remain necessary.
- The package check installs the tarball outside the repository and first checks runtime behavior without development dependencies.
  Its later compiler installation verifies declarations. Combining these installs would weaken dependency-isolation coverage.
- Source TypeScript is checked again during emission. This is a small measured cost, not the main bottleneck.
- Slow database tests cover different retention, reset, authentication, crash-recovery, and cleanup properties. Keep all of them.
- The worktree fixture copies all repository dependencies. Its logs do not isolate copy time, so the full test duration cannot justify removing that work.

## Optimization plan presented before edits

1. Benchmark two concurrent test files, while keeping tests within each file serial.
   Colocate the real Keychain tests because fixture creation temporarily changes the user's global Keychain search list.
   Keep every title, assertion, timeout, and the single TAP summary with its zero-skip release gate.
2. Cancel superseded PR runs. Preserve release serialization, verification, and publication of the verified tarball.
3. Measure npm download caching separately. Keep clean installs; do not cache installed dependencies or production output.
   Installation is a small fraction of elapsed time, so caching cannot explain a large improvement.
4. Investigate Colima provisioning independently before changing VM configuration.
   Do not cache mutable VM disks, database volumes, ownership records, or private state.
5. Profile the worktree dependency-copy phase before narrowing its independent dependency tree.

The fixture audit found private directories, random Docker owner identifiers, ephemeral ports, and exact cleanup across other files.
There are no global Docker prune operations or cross-file container-count assertions.
Two concurrent files can still compete for Colima's two CPUs and roughly 3.8 GiB of memory. Measurement must establish the result.

## Cache decisions

[setup-node](https://github.com/actions/setup-node) supports caching npm downloads using the lockfile while preserving a clean `npm ci`.
That is a candidate for read-only CI; privileged release jobs currently disable automatic caching deliberately.
Warm and cold runs must include cache restore/save time before claiming a benefit.

The [Playwright CI guidance](https://playwright.dev/docs/ci) does not recommend browser caching by default.
The docs job is already off the critical path, so browser caching is not part of this first change.

## Measurement protocol

Compare the unchanged serial baseline and candidate with the same test inventory, Node version, runner class, Docker resources, and images.
Record test counts, failures, skips, TAP duration, verification duration, setup duration, and total job time.
Local macOS arm64 measurements are useful regression checks, but cannot establish a hosted Intel CI improvement.
Hosted candidate results and local measurements are recorded after execution.

The baseline and both hosted trials used Node 24.19.0, runner image 20260824.0482.1, Colima 0.10.3, and Docker Engine 29.5.2.
The PostgreSQL multi-platform index changed, but registry inspection confirmed identical amd64 manifests, configuration, and all ten layers.
Only riscv64 entries changed. The Redis image digest also matched. This image change does not affect the Intel comparison.

Local checks used macOS 26.6.2 arm64, Node.js 22.23.1, and Docker Desktop 29.6.1 with four CPUs and 3.83 GiB of memory.
All four runs passed the same 163 test titles, with zero failures, cancellations, skips, or TODOs.

| Local test execution | Serial | Two files |
| --- | ---: | ---: |
| First run | 207.007s | 111.319s |
| Repeat | 203.342s | 111.387s |
| Mean | 205.174s | 111.353s |

The mean reduction was 93.822 seconds, or 45.7%. Individual test durations stayed similar; the gain came from overlapping existing work.
These measurements do not establish a hosted Intel improvement.

A separate local npm experiment used an empty download cache, then reused it for another clean install.
The installs took 2.919s and 1.720s. This excludes hosted cache restoration and upload, so it does not justify a CI caching claim.
Copying the example's approximately 195 MiB dependency tree took 3.410s and 2.114s locally.
Hosted copy timing remains unknown. No dependency-copy or caching change is included.

## Hosted concurrency trial: rejected

[Run 35583054933](https://github.com/RojhatToptamus/previewhost/actions/runs/35583054933) tested two concurrent files on the existing two-CPU Colima VM.
The job took 21m30s, with 15m26s in verification and 879.162s in the test runner.
Only 153 of 163 tests passed. Three failed and seven were canceled by test deadlines; none were skipped.
Package verification did not run. This result is not a performance improvement.

All ten unsuccessful tests used Docker. Initial database startup increased from 33.3s to 47.6s.
The worktree example increased from 164.2s to 282.6s. All Keychain tests passed; a gateway deadline test stayed near 10.02s.
Both agent reviews found evidence consistent with Docker resource contention, without evidence of cross-owner resource collisions.
The logs cannot distinguish CPU, memory, and disk pressure.

The follow-up restored the original serial suite and test locations. It changed only Colima's CPU allocation from two to four.
[GitHub documents four CPUs and 14 GB of memory](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) for the existing Intel runner.
VM memory stayed at 4 GiB. Every test deadline and all package checks stayed unchanged.
Standard Apple Silicon runners do not support nested virtualization, so they are not a supported replacement for this Colima job.

## Hosted serial trial: retained with qualification

[Run 35585447986](https://github.com/RojhatToptamus/previewhost/actions/runs/35585447986) passed all 163 tests with four Docker CPUs and serial test files.
It had zero failures, cancellations, skips, or TODOs. Installed-package verification and the documentation job also passed.
The actual test-title inventory matched the baseline. All package-script and test-source changes from the concurrent experiment were reverted.
Main commit `36ed345` has the same source tree as baseline commit `4d4f980`, verified with Git.

| Measurement | Baseline 35551077245 | Four CPUs 35585447986 | Observed reduction |
| --- | ---: | ---: | ---: |
| Complete macOS job | 26m00s | 22m26s | 3m34s (13.7%) |
| Docker startup | 4m30s | 2m30s | 2m00s |
| Database image pulls | 1m43s | 1m28s | 15s |
| Release verification | 18m31s | 17m24s | 1m07s (6.0%) |
| Test runner | 1,073.053s | 995.216s | 77.837s (7.3%) |
| Installed-package check | 26s | 24s | 2s |

Database diagnostics improved: initial startup took 21.1s instead of 33.3s; reopening took 12.0s instead of 20.4s.
The worktree example took 126.7s instead of 164.2s. Some other tests were slower.

The repeat [35587874149](https://github.com/RojhatToptamus/previewhost/actions/runs/35587874149) passed the same 163 tests, package validation, and documentation checks.
It took **27m06s**, including 4m43s for Docker startup, 1m14s for pulls, and 19m49s for verification.
Its test runner took **1,154.196s**, 16.0% longer than the first four-CPU run.
The jobs file increased from 353s to 447s; data integration increased from 123s to 172s.
The retention case reached 74.5s of its 90s deadline. The canceled-seed case reached 102.3s of its 120s deadline.

The third [four-CPU run, 35590354093](https://github.com/RojhatToptamus/previewhost/actions/runs/35590354093/job/106303097680), hit the 30-minute job limit.
GitHub's annotation confirms the timeout. The job lasted 31m02s including cancellation cleanup; package validation was skipped.
It emitted 160 case results, including one failed native MCP authorization/stdio case, without a final TAP summary.
That separate failure remains unexplained and must not be attributed to Docker without evidence.
Colima startup took 7m00s and image pulls took 2m09s. Startup included two boots and about 44s of image decompression.
Most remaining setup time was VM boot, SSH readiness, provisioning, and the second boot—not repeated npm installation.

| Four-CPU serial run | Result | Job duration | Docker startup + pulls |
| --- | --- | ---: | ---: |
| 35585447986 | 163 passed, package passed | 22m26s | 3m58s |
| 35587874149 | 163 passed, package passed | 27m06s | 5m57s |
| 35590354093 | Incomplete, one observed case failure, job timeout | 31m02s including cleanup | 9m09s |

**The four-CPU change has not demonstrated a stable performance improvement.**
The first run needed one VM boot; the two-CPU baseline needed two. The failed concurrent trial also needed only one boot.
Image decompression differed before the VM started. These results do not isolate CPU allocation from host or storage variation.
The branch retains four CPUs for now, but that small change does not solve growth or deadline headroom.
PR cancellation avoids obsolete work; its aggregate savings have not been measured.

## Why the concurrent trial failed

The failed trial increased summed case time from 1,060.730s to 1,699.512s, a 60.2% increase.
Seven cases hit their deadlines; three failed around pending Docker mutations or database startup.
All ten used Docker. Unrelated native cases and Keychain tests passed.
This supports shared-resource contention, rather than useful overlap, as the immediate scheduling problem.
The original logs cannot identify CPU, memory, storage, or socket latency as the underlying resource constraint.
There is no recorded owner collision, wrong-resource deletion, duplicate identifier, or port conflict.
Absence of those errors does not prove that every possible race is excluded.

Source tracing identifies the safety checks that the optimization must preserve.
Raising test deadlines could absorb variance, but would not resolve contention or demonstrate the intended speed improvement:

- Database operations check engine identity, exact resource IDs, and owner labels before mutation.
- Durable intent is saved before Docker requests. Uncertain creation remains cleanup debt instead of being assumed absent.
- Metadata writes sync the temporary file, rename it, and sync the directory. Keystore transactions retain SQLite FULL synchronization and scrypt.
- PostgreSQL retains normal durability. Redis retains its append-only log and `appendfsync always`.
- Readiness runs authenticated protocol probes with bounded polling. It is not an unconditional sleep that can simply be removed.
- Seed cancellation, crash recovery, reset authorization, and retained data test different properties. They remain necessary.

A local duration probe ran three serial samples and three concurrent pairs of the unchanged retention case.
All nine passed. Median per-case time increased from 2.780s to 2.983s, about 7.3%.
Host fsync totals were 416/460ms; non-wait Docker request totals were 1,239/1,422ms.
SQLite COMMIT totals were about 2ms in both modes. These categories can overlap and must not be added together.
A Docker wait request measures container lifetime, so it is excluded from request-overhead totals.
The local ARM64 Docker Desktop environment did not reproduce the hosted Intel failure.

The [hosted probe](https://github.com/RojhatToptamus/previewhost/actions/runs/35590354093/job/106303097670) reproduced pressure on the original two-CPU, 4 GiB Intel Colima configuration.
It ran one uninstrumented control, then serial/pair/pair/serial/serial/pair blocks on the same fresh engine.
All ten invocations passed the unchanged retention, authentication, and cleanup assertions. No deadlines or durability settings changed.

| Hosted metric per invocation | Serial median (3) | Paired median (6) |
| --- | ---: | ---: |
| Process elapsed time | 59.2s | 71.7s |
| Non-wait Docker calls | 45.1s | 53.0s |
| Eight image list/inspection requests | 19.6s | 21.1s |
| 44 engine identity requests | 5.4s | 6.9s |
| Four container creates | 5.8s | 7.3s |
| Four container starts | 5.9s | 9.1s |
| 85 host file/directory fsync calls | 0.96s | 0.84s |
| Seven SQLite commits | 0.006s | 0.007s |

The image/create/start rows are parts of the Docker total; they are not additional costs.
Serial process times ranged from 49.4–62.0s; paired times from 59.8–84.8s.
The slowest paired test body consumed 84.3s of its 90s deadline. Passing this narrow probe does not rehabilitate the failed full-suite parallel run.
The uninstrumented control took 52.1s, within the serial range. One control cannot tightly quantify instrumentation overhead.

Across 439 one-second guest samples, excluding the initial cumulative sample, average CPU time was 12.3% user and 74.8% system.
Median runnable tasks were five on two CPUs; 79% of samples exceeded two runnable tasks.
Average I/O wait was 1.9%, swap activity was zero, and free guest memory stayed above 2.4 GB.
Node itself used only about 2.6 CPU-seconds per serial invocation. Its event-loop P99 was about 27ms.
These measurements support guest CPU/system pressure and slow Docker operations. They do not support keystore encryption, host fsync, or memory paging as the dominant probe bottleneck.
They do not identify the kernel/hypervisor hotspot, nor prove that every failure in the earlier mixed workload had exactly the same cause.

Image lookup is now a concrete optimization lead. The probe combines list and inspect into one category, so it cannot allocate the 20s between them.
`Docker.image()` lists all local images, finds the configured tag, then inspects its immutable ID. The caller retains that ID for container creation.
No image is pulled during these tests; fixture pulls occur before verification. Thus the measured image-query cost is not a registry download.
A separately measured lookup simplification precedes any claim that more runners are the only answer.
The hosted engine uses the containerd image store. Docker 29.5.2 performs manifest/content/snapshot summary work for both [listing](https://github.com/moby/moby/blob/docker-v29.5.2/daemon/containerd/image_list.go#L73-L182) and [inspection](https://github.com/moby/moby/blob/docker-v29.5.2/daemon/containerd/image_inspect.go#L23-L76).
Turning off manifest output does not bypass that work. API 1.40 already omits those optional fields.
An [open upstream report](https://github.com/moby/moby/issues/53077) describes costly image listing on 29.6.1, but does not prove the cause on our 29.5.2 runner.

## Comparable projects and current guidance

Research date: 2026-09-21. Workflow sources below use exact commits, including their invoked actions and test configuration.
The review found no formal numeric PR-feedback SLO in these inspected sources. Job and test timeouts are failure limits, not latency targets.
Current guidance favors measuring phases, bounding workers, and distributing independent heavy workloads.
[Playwright recommends one worker on constrained CI and separate jobs for wider parallelism](https://playwright.dev/docs/ci).
[Vitest explains phase profiling and why summed worker time differs from elapsed time](https://vitest.dev/guide/improving-performance.html).

| Project | Verified workflow choices | Fit for Previewhost |
| --- | --- | --- |
| [Prisma main / 8 RC](https://github.com/prisma/prisma/blob/ad23f6f47f7964a12f07899c39d2449f1d5b99ea/.github/workflows/ci.yml) | Four package shards, each with PostgreSQL; four integration shards with different setup; separate build, type, lint, example, and E2E jobs. | Separate resource-heavy jobs. Its schema reset strategy cannot replace tests of retained volumes and container ownership. |
| [TypeORM](https://github.com/typeorm/typeorm/blob/f279fd1367f24ad108a1b11cf833f1620274088d/.github/workflows/tests-linux.yml) | Compile artifact consumed by driver/version jobs; six deterministic Cockroach file shards; overlap slow service startup with dependency setup, then check readiness. | Independent engines and safe setup overlap fit. A large driver matrix and shared build artifact are not currently justified. |
| [Testcontainers Node](https://github.com/testcontainers/testcontainers-node/blob/99ff0a2bf4becb17265d0e07ecabe8a564ea2c6c/.github/workflows/checks.yml) | Module × Node × Docker/Podman jobs on independent Ubuntu engines; maximum 20 concurrent test jobs; real container lifecycle and consumer smoke tests. | Closest product comparison. Copy the isolation principle, not its matrix, affected-module system, or three test retries. |
| [Playwright](https://github.com/microsoft/playwright/blob/07f1a6154795f055f341b8972086533e8e48b36f/.github/workflows/tests_primary.yml) | Two Ubuntu/macOS shards and three Windows shards, with platform weights. Separate installation tests retain a 45-minute ceiling. | Keep package consumer coverage and choose partitions using actual work. Browser infrastructure and timeout ceilings do not transfer. |
| [Vitest](https://github.com/vitest-dev/vitest/blob/a0a939653bc8441848579bb6ac18706372242cd6/.github/workflows/ci.yml) | Separate unit, E2E, coverage, and platform jobs. A measured expensive browser file has its own Windows job. | Split a demonstrably large test file along independent behavior. Keep process isolation for global environment and prototype mocks. |
| [pnpm](https://github.com/pnpm/pnpm/blob/06bdef392d98025336b49d1f60003b2496dcf9e9/.github/workflows/ci.yml) | Compile artifact, native fixture per OS, Windows chunks, measured command exit status, and a final required check. | Keep a stable aggregate gate. Its chunk weights are file bytes, not historical duration; its monorepo selection engine is unnecessary here. |

Prisma's [worker configuration](https://github.com/prisma/prisma/blob/ad23f6f47f7964a12f07899c39d2449f1d5b99ea/vitest.config.ts) explicitly reserves capacity after database workers starved event loops and dropped sockets.
That supports resource bounds; it does not establish the correct worker percentage for Previewhost.
Its [single-writer build cache](https://github.com/prisma/prisma/blob/ad23f6f47f7964a12f07899c39d2449f1d5b99ea/.github/actions/setup/action.yml) separates build inputs from test outcomes.
Prisma and TypeORM cache the package download store. Testcontainers instead caches installed modules.
These are different engineering choices, not a universal instruction to cache everything.
Our native dependency boundary and 14–24s installation cost favor clean installs.

The [Prisma CI engineering tutorial](https://blog.prisma.io/blog/testing-series-5-xWogenROXm) explains separate unit, integration, and E2E jobs with a healthy PostgreSQL service.
It teaches application CI, not Prisma's internal latency. A static service database cannot exercise Previewhost's creation, retention, owner-crash, and deletion behavior.
GitHub's [three-times-faster CI write-up](https://github.blog/engineering/infrastructure/making-github-ci-workflow-3x-faster/) describes a different tradeoff: deferring enterprise compliance coverage.
It concerns GitHub's Rails application, not a comparable TypeScript library. That coverage reduction is unsuitable for Previewhost's ownership and secret-isolation PR checks.

Publishing also differs between projects. [Playwright](https://github.com/microsoft/playwright/blob/07f1a6154795f055f341b8972086533e8e48b36f/.github/workflows/publish_release.yml) builds for publication; [Vitest](https://github.com/vitest-dev/vitest/blob/a0a939653bc8441848579bb6ac18706372242cd6/.github/workflows/publish.yml) has a separate release gate and disables publishing caches.
None of those choices supersedes Previewhost's existing requirement to publish the exact tarball already verified.
[TypeORM's Windows workflow](https://github.com/typeorm/typeorm/blob/f279fd1367f24ad108a1b11cf833f1620274088d/.github/workflows/tests-windows.yml) covers embedded SQLite drivers. It is not evidence of Docker-backed Windows support.

### Actual upstream run timings

These are successful first-attempt samples, not controlled benchmarks or published targets.
The broad-suite examples include executed database/core work. Green samples with no test jobs, or only narrow affected-module coverage, were excluded.
Upstream job records do not certify zero skipped test cases inside every test runner.
Execution span covers first job start through last completion. Summed job duration measures resource consumption.

| Project / run | Observed workflow span | Summed job time | Interpretation |
| --- | ---: | ---: | --- |
| [Prisma 35369669642](https://github.com/prisma/orm/actions/runs/35369669642) | 8m26s | 62m30s | 18 jobs; integration shards 251–269s. [Another run](https://github.com/prisma/orm/actions/runs/35367592890) took 11m54s, with shards 524–664s. |
| [Testcontainers 31441797323](https://github.com/testcontainers/testcontainers-node/actions/runs/31441797323) | 13m09s | 215m09s | 262 jobs including core, PostgreSQL, Redis, and smoke tests. Longest job 247s. |
| [Testcontainers 30830584509](https://github.com/testcontainers/testcontainers-node/actions/runs/30830584509) | 51m58s | 222m36s | Longest job still only 246s; start times spread much further apart. More jobs do not guarantee fast feedback. |
| [Vitest 35280094704](https://github.com/vitest-dev/vitest/actions/runs/35280094704) | 8m08s* | Not used | 22 jobs; longest Windows E2E job 7m06s. Separate heavy Windows browser job 3m30s. |
| [Playwright 35411614399](https://github.com/microsoft/playwright/actions/runs/35411614399) | 36m29s* | Not used | 27 jobs passed. macOS shards 21m29s/27m10s; Windows installation 27m53s. |

\* Vitest and Playwright spans use workflow creation/completion metadata and can include initial scheduling.
The Prisma/Testcontainers API samples separate initial scheduling from execution; those initial delays were 3–60 seconds.
Later scheduling gaps can include job dependencies and matrix limits. The API does not distinguish every cause; do not call all gaps queue time.
The sampled workflows were also checked at the runs' actual source revisions.
Large projects trade aggregate compute for latency, and still show substantial variance. Their runtime is not our performance promise.

## Proposed smallest scalable implementation

First measure the image-query lead, then benchmark the smallest isolated-job layout. Keep these experiments separate so their effects remain attributable.

### First code candidate: local image lookup

Time the exact API 1.40 list and inspect endpoints separately on hosted Colima, with both configured fixture images present.
Compare unfiltered listing, reference-filtered listing, direct tag inspection, and inspection by immutable ID. Verify equivalent selected IDs.
The first conservative candidate keeps list-then-inspect behavior and adds the documented reference filter to listing.
Docker 29.5.2 applies the [reference filter before expensive per-image summaries](https://github.com/moby/moby/blob/docker-v29.5.2/daemon/containerd/image_list.go#L118-L159).
Retain exact tag matching and ID validation after filtering. Fewer image summaries might help; that benefit is not yet measured on hosted CI.

A direct tag inspection could remove an entire request, but it is not qualified.
The [API 1.40 contract](https://github.com/moby/moby/blob/v19.03.15/api/swagger.yaml#L7091) accepts a name or ID, and history shows no added requirement to list first.
However, a local read-only experiment initially returned 404 for an advertised short tag while ID inspection succeeded.
A later fully qualified lookup succeeded; three subsequent rounds returned matching IDs for short tags, full tags, filtered lists, and ID inspections.
The initial mismatch remains unexplained. Do not ignore it or add speculative fallback branches to claim compatibility.
The local ARM64 measurements do not establish hosted Intel performance. Preserve current lookup behavior until the mismatch is understood.

For either candidate, keep actionable missing-local-image errors and reject malformed IDs or unexpected statuses before mutation.
Keep local-only behavior and pass the validated immutable ID to container creation. Resolve afresh on later opens; do not cache image tags or engine identity.
Test missing/malformed images, error propagation, no mutation on failure, and tag movement after resolution.
Run real PostgreSQL/Redis retention and ownership coverage after any change.
Benchmark the chosen small change independently, then refresh the group weights before comparing CI layouts.
Do not switch storage backends, update Docker, weaken checks, or introduce caches as part of this candidate.

### CI layout candidate

**Two serial database jobs, one macOS native/package job, and the existing independent documentation job.**
Each database job owns a fresh Colima engine. Retain four Docker CPUs and 4 GiB until the diagnostic evidence justifies a separate resource experiment.
Run one test file at a time within each engine. Keep real Keychain tests serial on one macOS account.
All existing tests remain mandatory on every PR and before release.
Add the complete existing `npm run typecheck` command to the independent Ubuntu documentation job.
This retains both source/test TypeScript and dashboard TypeScript checks; Vite build and website checks do not replace them.

### Partition by measured behavior

The first passing four-CPU run contains 28 files and 163 cases, with 982.707s of summed case time.
Node 24.19 [sorts files and applies index modulo shard count](https://github.com/nodejs/node/blob/v24.19.0/lib/internal/test_runner/runner.js).
Applying it to this inventory gives two shard weights of 429/554s, three of 147/238/598s, and four of 233/37/196/517s.
These are estimates excluding process/setup cost. Three equal-file shards would be less balanced than two.
Do not rename files to game their sort positions or introduce a historical-duration scheduling service.

Split only `jobs.integration.test.ts` along its existing independent scenarios:

- Four real database/seed lifecycle cases.
- Two dashboard reset cases.
- Five remaining fake-engine or native cases.

Keep every assertion and deadline. Extract only the fixture operations actually shared by these files into one direct test helper.
Leave the example's five dependent attempts together. Keep existing mixed files intact when splitting them adds little benefit.
The result has 30 files and the same 163 cases; this is a migration comparison, not a permanent hardcoded test-count gate.

| Proposed group | Files / cases | First four-CPU case totals | Second four-CPU case totals |
| --- | ---: | ---: | ---: |
| Runtime database workflows: seeds, reset, environment data | 3 / 9 | 388s | 497s |
| Ownership/project consumers: data, example, project, project database, lifecycle | 5 / 19 | 431s | 474s |
| Native and remaining script cases | 22 / 135 | 164s | 170s |

These are summed case measurements regrouped from serial runs, not executed shard timings. Setup and runner overhead are additional.
The slower passing observation predicts roughly 15 minutes after its 357s Docker setup and about 50s of other preparation.
Using the third run's 549s setup raises that sensitivity estimate above 18 minutes. These estimates demonstrate why job splitting alone might fail the proposed budget.
A three-database-group alternative reduces measured test-body maxima to 291s/344s, but repeats another VM and consumes four macOS jobs per PR.
The agents differed on that tradeoff: the latency review favored three DB jobs; the capacity review favored two.
Start with two to measure the smallest option. If it cannot meet the admission targets below, do not describe it as the scalable solution.

Use one small file selector around the current Node test runner. Discover the existing source, example, and script test globs once.
List only database-group membership; the native group is the discovered complement.
Reject absent configured files and duplicate membership. Every discovered file must execute exactly once.
A new native test is automatically covered. A new database file initially lands in the native group, where the absent Docker prerequisite causes a skip and fails the gate.
All current real-Docker tests use this explicit-skip convention. Document that future tests must not silently omit registration or return early without infrastructure.
A second exhaustive native manifest would duplicate inventory without preventing omission inside an existing file.

### Preserve the gates and release boundary

Each group must return exit zero and its own complete, positive TAP summary with zero failures, cancellations, skips, or TODOs.
The current `checkReleaseResult` keeps the last matching summary. Concatenating shard logs and calling it once would hide earlier failures.
Reuse it on each group's result; explicitly reject missing or truncated results.
Keep the Docker prerequisite for database groups. Give the native group an explicit no-Docker path instead of deleting the release prerequisite globally.

Preserve the stable required check name, **Verify macOS package**, as an aggregate result.
It must require success from every mandatory dependency, including documentation and package validation. Skipped, canceled, missing, or failed groups cannot qualify.
Keep the release publish-plan validation, channel selection, native build, runtime-only install, declaration check, and exact artifact-ID handoff.
The native/package job may prepare the tarball in parallel, but publication must wait for all required results.
Do not rebuild in the publisher or select a previous run's latest artifact.

Keep PR cancellation and non-canceling release serialization. PRs get all current coverage; no safety suite moves to nightly.
Additional future compatibility matrices can have a separate policy, but that does not authorize removing current macOS or database qualification.
The package minimum Node version remains unchanged; adding a broader runtime matrix is separate coverage work, not a claimed speed improvement.

### Setup and caching decisions

Do not add a shared build coordinator initially. Production build, test compilation, and native fixture preparation cost tens of seconds.
Repeating that small work keeps jobs independent and avoids artifact transfer and a serial build dependency.
A database-job matrix can share its setup steps without copying the workflow or test fixtures.

After the isolation candidate is measured, test npm download caching with the lockfile and OS/runtime boundary.
Retain `npm ci`; measure restore/save overhead and cold misses. Never cache installed native modules, test success, private state, Keychains, VM disks, or database volumes.
[GitHub warns that PR authors can read eligible caches](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching); caches must contain no secrets.
Keep privileged publishing cache policy unchanged. Do not add browser caching to an already sub-minute off-critical-path job without a net saving.

Colima provisioning and image pulls remain measured steps. Do not weaken Docker socket permissions or run tests as root to skip provisioning.
Overlap independent build/install work with VM startup only after proving failure propagation and readiness ordering. Expected savings are tens of seconds, not a solution to the whole bottleneck.
Docker image caching needs a restore/load-versus-pull experiment before adoption. Mutable engine-state caching is excluded.

### Budgets, growth, and runner capacity

Targets below are acceptance hypotheses for the isolated-job candidate, not measured improvements.

| Metric | Initial acceptance target |
| --- | --- |
| Documentation / cheap type feedback | At most 2 minutes of execution |
| Native tests and installed package | At most 5 minutes of execution |
| Required-check execution span | Median at most 13 minutes; no qualification run above 16 minutes |
| Two overlapping PR runs | Both complete within 18 minutes in the throughput experiment |
| Total runner time | At most 1.6× the median summed job duration of three same-source serial controls |
| Correctness | Every existing case retained; all required groups pass; no test retries or increased deadlines |

Record creation-to-required-check completion as the user-visible measurement, plus execution span and each job's duration.
Report external scheduling separately; do not silently discard slow runs to meet the target.
An explained target miss is still a miss. The execution budget does not promise a queue-free user-visible duration.
The passing controls suggest roughly 12–15 minutes for two database groups; the latest setup outlier suggests more than 18 minutes.
Thus 13/16 minutes are admission criteria, not a demonstrated forecast. Image-query and setup work may be necessary before this layout qualifies.
If the target fails, report it and reassess the cause before adding another job. More shards cannot eliminate a long startup on the slowest runner.

[GitHub's default macOS concurrency limit](https://docs.github.com/en/actions/reference/limits) is five for Free, Pro, and Team accounts, across repositories.
The authenticated account API did not reveal its plan; custom capacity is unverified. The public repository has free standard hosted execution, but capacity still matters.
Three macOS jobs per PR initially request six slots for two simultaneous PRs. A short native job releases one slot; the overlap test must establish actual behavior.
A third database job would request four macOS slots per PR, repeat another VM setup, and risk worse throughput.
Treat that as a measured fallback, not the default; it must meet the same coverage and resource budget.

Use lightweight job summaries for setup, test, package, and total duration. Preserve command exit status.
Review balance after repeated feedback-budget misses, or when useful test time differs by more than 20% and 60s across three comparable passing runs.
These are proposed operating thresholds. Setup inflation calls for setup investigation, not test rebalancing.
First move an independent file; split a file only at a real scenario boundary. Do not add shards automatically as the suite grows.
After 20 ordinary runs, report empirical P95 and failure rate with the sample size. That is preliminary tail evidence, not a guaranteed SLA.

### Qualification before adoption

1. Keep source, Node, runner class, Colima, resources, architecture-specific images, and the test inventory comparable. Record any drift.
2. After any independently accepted image optimization, run the partition candidate five times and interleave three serial controls on that same source. Two of the five candidates form the overlap experiment. Include cold setup and label warm/cold cache state if caching is later tested.
3. Count every failure and cancellation. Do not rerun failures away, relax test timeouts, disable fsync, reuse persistent databases, or skip expensive scenarios.
4. Investigate the observed native MCP failure rather than assuming database isolation fixes it. Compare complete test-title inventories during the split. Exercise a missing result, failing group, canceled/skipped dependency, and truncated TAP to prove the aggregate gate fails closed.
5. Check all required paths: normal PR packaging and release-plan packaging without publication. Verify that the exact tested artifact remains the publisher's input.
6. Include two overlapping PR-equivalent runs to test account capacity. Compare user-visible latency, useful execution, and total runner time separately.
7. Keep the serial arrangement available until the candidate passes the coverage, latency, and resource criteria. Remove temporary probes after measurement.

Linux can eventually avoid Colima startup by using native Docker, but this branch still has macOS runtime requirements.
Qualify the Linux implementation directly on Linux x64 before using it in this pipeline. Local ARM results do not establish that qualification.
Windows ownership, Job Objects/process cleanup, ACLs, named pipes, and Docker-backed workflows still require direct Windows tests.
Neither this CI research nor another project's Windows matrix establishes Previewhost's Windows support.

## Decision and current change boundary

The research supports independent engines, measured semantic groups, complete per-group results, and one release gate.
It does not support deleting tests, replacing lifecycle scenarios with a shared database, increasing timeouts, or copying a monorepo CI framework.
The temporary profiling job and both probe scripts have been removed after measurement. Their source remains available in commit `5a283d0`.
The implementation now uses two independent database engines and one native/package job.
Each group keeps serial file execution and the existing test deadlines.
The complete serial command remains available for controls.
The image lookup candidate filters the image list by reference, then retains exact tag and immutable-ID checks.
A temporary hosted pilot compares both queries before qualification.
Caching and setup overlap remain deferred.

Local checks and hosted qualification results are recorded below as they become available.
Implementation does not establish that the runtime targets passed.
The separate Linux/Windows implementation is untouched by this investigation.

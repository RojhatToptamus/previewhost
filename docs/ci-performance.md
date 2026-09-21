# CI performance investigation

The investigation separates existing CI from the unmerged Linux and Windows work.
The benchmark starts at main commit `36ed345`, without those platform changes.
Two independent agent reviews checked workflow duplication, test coverage, and shared fixture state.

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

This is one passing hosted measurement, not proof of a stable CPU-driven improvement.
Previous successful 163-test runs varied by approximately 108 seconds, more than the observed 78-second test reduction.
The new run needed one VM boot; the baseline needed two. The failed two-CPU concurrent trial also needed only one boot.
Image decompression was faster before the VM started, which also shows host variability.
Do not attribute the complete 3m34s difference to CPU allocation.

Both agent reviews recommend retaining the small four-CPU allocation while keeping the suite serial.
The final implementation changes only that allocation and cancellation of superseded PR runs.
Release serialization, test coverage, deadlines, memory allocation, and verified-tarball publication remain unchanged.
Cancellation avoids obsolete PR work; its aggregate savings have not been measured.

Assess subsequent hosted runs before claiming sustained gains. If further parallelism is needed, test independent Docker engines on separate runners.
Node's built-in test sharding can avoid a custom scheduler, but adds setup cost and requires release gating across every shard.
That larger change, caching, and dependency-copy changes remain deferred. No runtime or Windows qualification result is implied by this CI experiment.

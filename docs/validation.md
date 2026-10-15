# v1 validation

## Compatibility baseline

| Component    | Tested revision                  | Gate                                                   |
| ------------ | -------------------------------- | ------------------------------------------------------ |
| OpenCode CLI | `@opencode/cli@2.0.24`           | ACP availability check (`opencode --version`)          |
| Tauri app    | This repository's current commit | Rust CI on Linux, macOS, Windows; desktop WDIO locally |

Sail starts OpenCode as `<binary> acp` and requires the exact CLI version above. Update the version pin in `src-tauri/src/lib.rs` and this table together.

Remote MCP registration behavior of the pinned client is re-verified by `node scripts/opencode-remote-mcp-probe.mjs` (see `docs/provider-runtime.md`); the unit suite runs it when the pinned client is available and skips otherwise.

## Automated checks

Run `npm ci && npm run build:e2e && npm run test:e2e` on a desktop. WDIO launches the actual Tauri binary against the scripted ACP agent in `test/e2e/acp-agent.mjs` and checks repository setup, missing paths, agent threads, Ship runs and settings.

On macOS, use the supported entry point after `npm ci`:

```sh
SAIL_NATIVE_ROOT=/absolute/task-owned/sail-native npm run test:native -- --spec test/e2e/native-isolation.spec.ts
```

Keep the same task-owned root for sequential runs. The runner validates the source revision and contents, Rust, Node and Apple SDK/compiler toolchains, architecture, private bundle identity, binary hash, ad-hoc signature and E2E entitlements before reusing a build. Apple Command Line Tools and full Xcode are supported through `xcrun`. Each invocation copies it to a new app with a fresh macOS bundle identity, matching context service and signature, canonical temporary/config paths, private XDG/worktree/agent/fixture directories, and a free WebDriver port. It launches with `open -n -g`, verifies that the private app owns the ready endpoint, then checks Main and Settings navigation and required webview capabilities before product assertions. A setup failure cannot produce a PASS result.

A runner killed with SIGKILL cannot stop its app or its build and WebdriverIO commands. Each run records its runner, app executable and command groups in `sail-native-runs` inside the per-user temporary folder (`SAIL_NATIVE_RUN_REGISTRY` selects another absolute folder). The next `test:native` run stops the app and command groups of every record whose runner no longer exists, matching the runner by pid and start time, and leaves a run whose runner is alive alone. It then removes the folders of dead runs as before. A record whose owner cannot be checked is kept, and a failed stop is reported and retried by the following run.

`SAIL_NATIVE_SETUP_ATTEMPTS` sets the setup attempt limit (1–5, default 2). Only setup failures are retried; product failures stop immediately. `result.json`, per-attempt setup failures, build/WDIO logs and the redacted fixture environment remain in the printed diagnostics directory. Interrupts and failures stop only this invocation's app and command processes. Keep the root until its evidence is reviewed, then remove only that task-owned directory. A default private root is created when `SAIL_NATIVE_ROOT` is absent; pass an explicit root to reuse artifacts. The runner supports macOS ad-hoc development signing; it does not assert trusted distribution signing.

On macOS, set `SAIL_E2E_CONFIG_DIR` to a private directory strictly inside the app process’s temporary directory before `build:e2e`, and keep the same value when launching the app or running `test:e2e`. Pass the same private `TMPDIR` to the build, app, and runner. The E2E app rejects config paths outside its temporary directory, including symlink aliases. The bundled context LaunchAgent uses this path for its approval store and the build fails when it is absent.

Settings > Agents > Concurrent jobs caps active agent turns, embedded browser tabs, Ship validation gates, and E2E test runs separately. Validation gates queue against the same machine-pressure and workspace-disk policy as other Sail work, hold capacity until their owned session ends, and resume automatically when capacity returns. The WebdriverIO runner reads the E2E limit before launching workers and queues concurrent invocations in launch order. `SAIL_E2E_JOB_LIMIT` overrides the saved E2E limit for an isolated runner; `SAIL_E2E_LIMIT_DIR` selects a private queue directory when independent test environments must not share slots.

## Idle and startup footprint

On macOS, `npm run measure:footprint` checks that a long-running Sail stays flat and starts its maintenance quickly. It launches a private app (the same isolation as `test:native`, plus a private `HOME`) on a generated profile: one repository with 26 linked worktrees, 32 abandoned `sail-*` scratch roots older than two hours, and 1,000 unrelated temporary entries. It makes no change to running Sail instances or the real profile, and it removes its app, data and scratch when it ends, including on Ctrl-C.

```sh
npm run build:e2e   # once, as build-slot npm run build:e2e on a shared machine
npm run measure:footprint -- --app "path/to/Sail E2E <id>.app"
```

Without `--app` the command builds the app itself, which needs 20 GiB free. `--help` lists the profile size, sample times, windows, tolerance and `--json` result file.

- Two snapshots, at 10 minutes and at 2 hours after launch, each cover the five minutes before them. ACP session listings and settings file writes are rates per minute over the window.
- Total RSS is judged over two long windows instead of those snapshots, because the footprint cycles between an active phase with child processes (about 90 MB) and an idle phase without them (about 46 MB). The early window starts at the first sample point (10 minutes) and the late window ends at the second (2 hours); each is 40 minutes wide (`--rss-window-minutes`, shortened so the two never overlap). Within each window the median RSS is taken per phase, active (the app has child processes) and idle (none), and each phase is compared across the windows. A phase counts when both windows hold at least 10% of their expected readings (and 3 at minimum), so a short blip cannot decide it; when no phase qualifies in both windows (a cycle longer than a window), the whole windows are compared. The child count is compared the same way, over the active readings. The report prints both windows, the readings and median of each phase, and the change.
- Child processes are the descendants of the app; RSS is the app plus those descendants. WebKit's WebContent and Networking helpers are launched by launchd, not by the app, so they are outside both numbers.
- Session listings are counted by the scripted ACP agent (`SAIL_E2E_ACP_LIST_LOG`; each line is a time and the listed directory). The `--json` result also carries an `events` object with every listing, agent start (`SAIL_E2E_ACP_START_LOG`), agent close and agent idle exit, so a rate above zero can be traced to its source. The private app starts in the background, so its window is hidden and turns visible whenever another window uncovers it; that flip alone must not list sessions, only a focus does. Settings writes are counted by polling `settings.json` and `records/` for a replaced file every 250 ms, so a burst of writes between two polls counts once.
- Startup maintenance is `elapsedMs` of the `startup_maintenance_finished` event in the app's `sail.log`. The profile exercises the `$TMPDIR` sweep; the worktree storage and Git overlay phases have no state to restore on a fresh profile.
- The result passes when the median child count of the active readings and the median RSS of every compared phase are each within 10% across the two windows (`--tolerance`, in either direction), at least one comparison was possible, and startup maintenance finishes in under 30 seconds. A footprint that grows steadily moves both phases and fails; a cycle without growth passes whichever phase a window ends in. The command exits 1 on failure and 130 when cancelled.

### Reference run, 2026-10-15

macOS 26.6.2, Apple M4 Max, 36 GiB. App built from `9c9a63df` (`npm run build:e2e`), default options, run alongside other agents' builds and test apps. The run reported FAIL on RSS.

| Metric                     | At 10 min | At 120 min | Difference |
| -------------------------- | --------: | ---------: | ---------: |
| Child processes            |         3 |          3 |         +0 |
| Total RSS                  |   81.6 MB |   101.2 MB |   +19.6 MB |
| ACP session listings / min |       0.0 |       10.8 |      +10.8 |
| Settings file writes / min |       0.0 |        0.0 |       +0.0 |

- Child processes passed (+0.0%), RSS failed (+24.1%, limit ±10%), startup maintenance passed at 10.7 s (`scratchSweep` 10,535 ms, `worktreeStorage` 101 ms, `gitOverlay` 51 ms), and all 32 stale roots were removed.
- Over the 2 hours the app made 864 session listings and 7 settings writes (about 7 listings per minute on average; none fell in the first window).
- The footprint is not flat, it cycles. The app's children dropped from 3 to 0 at 10.7, 35.7, 75.6 and 98.1 minutes and came back at 21.2, 41.6, 84.6 and 113.6 minutes. With 0 children the median RSS is 46.2 MB (34% of readings); with 3 children the median is 90.5 MB. Medians of the active phases in minutes 12–40, 40–80 and 80–120 are 89.8, 77.8 and 95.5 MB, so the sample difference comes from where each window lands in the cycle, not from growth.
- Both 5-minute windows landed in an active phase: RSS ranged 75.8–82.8 MB in the first and 97.0–108.7 MB in the second. A 5-minute window cannot average a cycle that lasts tens of minutes, so that run's single-sample RSS check was sensitive to timing. The command now compares per-phase medians over 40-minute windows, which that run's data passes (its active-phase medians of 89.8 MB in minutes 12–40 and 95.5 MB in minutes 80–120 differ by 6%).

CI runs the frontend and Rust checks on Ubuntu, macOS, and Windows. The desktop WDIO suite requires a graphical runner and is a release check on each supported platform until hosted graphical runners are configured.

## Credentialed release smoke

Use a clean user profile, the compatibility baseline above, a disposable Git repository, and a provider credential with an enabled model. Record the app, OpenCode, and OS versions alongside the result. Keep a separate copy of the repository to inspect changes.

1. Start the packaged app with no OpenCode on `PATH`. Confirm Settings > OpenCode names the missing binary. Install the tested CLI, save the path or use automatic detection, and confirm Settings shows the detected executable.
2. Select the disposable Git repository and confirm New plan opens an OpenCode thread.
3. Start an OpenCode thread in plan mode. Ask for a plan that requires two choices, answer the questions in the form, and check that the plan version changes. Request a revision with a step comment, inspect the revised plan, then approve it. Reject a stale review from an earlier version and confirm the current plan remains available.
4. During execution, trigger a tool permission and reject it once, then allow a repeat request. Cancel a pending question/form and confirm it leaves the pending list. Confirm the run continues or reports a clear stopped state. Inspect step status, checkpoints, and history.
5. Have the agent edit two files. Inspect the file list and diff, switch files, and compare the changed content with `git diff`. Send enough messages to exceed one 50-message transcript page; scroll back to load older messages without losing newer ones.
6. Kill the `opencode acp` child. Confirm the thread reports the disconnect and resumes on the next message. Quit and reopen the app; confirm the project, session, transcript, plan, checkpoint, and diff can be restored. A session from another repository must not appear in the current project.

Record failures with the exact versions, OS, step, visible error, and relevant OpenCode log. The scripted e2e agent does not invoke a model, so it does not replace this smoke.

## Agent workflow failure replay

The redacted corpus in `test/fixtures/agent-failures/corpus.json` captures failures that must remain fixed across Claude, Codex, and OpenCode. Add a case when a production or manual-validation failure exposes a reusable workflow boundary. Remove repository names, revisions, credentials, user data, and absolute paths before committing it.

Run the matrix with one profile entry per routing or workflow policy under evaluation:

```sh
npm run test:agent-replay -- \
  --config replay-config.json \
  --corpus test/fixtures/agent-failures/corpus.json \
  --output replay-output-candidate \
  --baseline replay-output-current/report.json
```

The config names a release, providers, profiles, and one runner command per provider. Runner arguments must contain `{input}` and `{output}` placeholders. Sail gives every matrix entry a private working directory, home, temporary directory, XDG directories, and stable seed. Only environment variables named in `forwardEnvironment` enter the run.

Each runner reads the invocation JSON and writes an observation JSON with evidence-backed grades for ownership, acceptance, evidence freshness, permission behavior, recovery, and final outcome. It also records elapsed time, turns, tool calls, permission requests, retries, human interventions, failed commands, and repeated work. A task is accepted only when its outcome and all six grades pass.

When a baseline is supplied, the command fails before a policy becomes the default if any provider/profile route loses coverage, acceptance rate, or a grade pass rate. It also fails when average accepted-task cost increases by more than the configured threshold, which defaults to 15 percent. Keep the generated report as a release artifact so routing and workflow policy changes compare against the same corpus.

## Release checklist

- [ ] Bump `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` to the same version; update `Cargo.lock` and the compatibility baseline.
- [ ] Run the full CI on Ubuntu, macOS, and Windows.
- [ ] Run the Desktop packages workflow on the release commit; inspect four fresh-runner smoke tests, five packages, per-target hashes, and signing modes.
- [ ] Run the credentialed release smoke above on clean macOS ARM and Intel, Linux x64, and Windows x64 machines. Record the OS version, result, and any platform gaps.
- [ ] Configure Apple Developer ID signing, notarization secrets, and Apple's managed browser public-key credential entitlement before claiming a trusted macOS build. Otherwise keep the ad-hoc development label. Configure Windows signing before claiming a trusted Windows build.
- [ ] Create `vX.Y.Z` only after the checks above. The tag workflow verifies version parity and source revision, attests the packages, and publishes a development prerelease with checksums and a manifest.
- [ ] Verify downloaded package hashes and GitHub attestations from a separate clean machine; install and launch each package there before directing users to the release.

Current platform limits: installers are macOS ARM64/x64, Linux x64, and Windows x64. Linux packages are built on Ubuntu 22.04 for older glibc compatibility; other distributions still require a compatible graphical stack. Windows NSIS may download WebView2 during installation. The app relies on a separately installed OpenCode v2.0.24 and does not self-update. The hosted package smoke checks do not exercise credentialed model execution, so the manual release smoke remains required.

# v1 validation

## Compatibility baseline

| Component    | Tested revision                  | Gate                                                   |
| ------------ | -------------------------------- | ------------------------------------------------------ |
| OpenCode CLI | `@opencode/cli@2.0.24`           | ACP availability check (`opencode --version`)          |
| Tauri app    | This repository's current commit | Rust CI on Linux, macOS, Windows; desktop WDIO locally |

| OpenCode CLI | `@opencode/cli@2.0.24` | ACP availability check (`opencode --version`) |
| Tauri app | This repository's current commit | Rust CI on Linux, macOS, Windows; desktop WDIO locally |

Sail starts OpenCode as `<binary> acp` and requires the exact CLI version above. Update the version pin in `src-tauri/src/lib.rs` and this table together.

Remote MCP registration behavior of the pinned client is re-verified by `node scripts/opencode-remote-mcp-probe.mjs` (see `docs/provider-runtime.md`); the unit suite runs it when the pinned client is available and skips otherwise.

## Automated checks

Run `npm ci && npm run build:e2e && npm run test:e2e` on a desktop. WDIO launches the actual Tauri binary against the scripted ACP agent in `test/e2e/acp-agent.mjs` and checks repository setup, missing paths, agent threads, Ship runs and settings.

On macOS, set `SAIL_E2E_CONFIG_DIR` to an absolute private directory before `build:e2e` and keep the same value when launching the app or running `test:e2e`. The bundled context LaunchAgent uses this path for its approval store and the build fails when it is absent.

Settings > Agents > Concurrent jobs caps active agent turns, embedded browser tabs, and E2E test runs separately. The WebdriverIO runner reads the E2E limit before launching workers and queues concurrent invocations in launch order. `SAIL_E2E_JOB_LIMIT` overrides the saved E2E limit for an isolated runner; `SAIL_E2E_LIMIT_DIR` selects a private queue directory when independent test environments must not share slots.

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

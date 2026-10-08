# v1 validation

## Compatibility baseline

| Component          | Tested revision                                                      | Gate                                                   |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------ |
| OpenCode server    | `@opencode/cli@2.0.24`                                               | Live contract on Linux, macOS, Windows                 |
| JavaScript client  | `@opencode/client@2.0.24`                                            | Frontend build and live contract                       |
| Plan-review plugin | `fdc575ba5ffccc6420ad5b3b68372f99f70290f5` (package version `0.2.0`) | Live `get` RPC                                         |
| Tauri app          | This repository's current commit                                     | Rust CI on Linux, macOS, Windows; desktop WDIO locally |

Configure the tested plugin revision in `opencode.jsonc`:

```json
{
  "plugins": [
    "github:smykla-skalski/opencode-plugin-plan-review#fdc575ba5ffccc6420ad5b3b68372f99f70290f5"
  ]
}
```

The app requires the exact OpenCode server revision above. Update the CLI version, client version, plugin SHA, and this table together. The live contract fails when a method or response shape used by the app drifts.

## Automated checks

Run `npm ci && npm run build:e2e && npm run test:e2e` on a desktop with OpenCode installed. WDIO launches the actual Tauri binary and checks fresh Git setup without the plugin, missing paths, binary discovery, invalid binary retention, and server death/reconnect. The CI contract job installs the pinned server and plugin in an isolated profile, starts a real loopback server, and checks location, plugin, agent, model, provider, integration, session, message, diff, permission, form, and plan-review RPC responses. Run the contract locally with `npm run test:contract`; set `SAIL_PLUGIN_PATH` to a local checkout of the tested plugin revision to avoid package installation.

CI runs the contract and Rust checks on Ubuntu, macOS, and Windows. The desktop WDIO suite requires a graphical runner and is a release check on each supported platform until hosted graphical runners are configured.

## Credentialed release smoke

Use a clean user profile, the compatibility baseline above, a disposable Git repository, and a provider credential with an enabled model. Record the app, OpenCode, client, plugin, and OS versions alongside the result. Keep a separate copy of the repository to inspect changes.

1. Start the packaged app with no OpenCode on `PATH`. Confirm setup names the missing binary. Install the tested CLI, reopen the app, and confirm Settings shows the detected executable. Save an invalid path while a session runs; confirm the old server stays live. Restore automatic detection.
2. Select the disposable Git repository before configuring the plugin. Confirm setup explains the missing plugin and disables New plan. Configure the tested plugin revision, restart OpenCode from Settings, and confirm the plugin and Architect checks become ready. Disconnect the provider; confirm setup explains the missing model. Reconnect it.
3. Start an Architect session. Ask for a plan that requires two choices, answer the questions in the form, and check that the plan version changes. Request a revision with a step comment, inspect the revised plan, then approve it. Reject a stale review from an earlier version and confirm the current plan remains available.
4. During execution, trigger a tool permission and reject it once, then allow a repeat request. Cancel a pending question/form and confirm it leaves the pending list. Confirm the run continues or reports a clear stopped state. Inspect step status, checkpoints, and history.
5. Have the agent edit two files. Inspect the file list and diff, switch files, and compare the changed content with `git diff`. Send enough messages to exceed one 50-message transcript page; scroll back to load older messages without losing newer ones.
6. Kill the owned OpenCode child. Confirm the app reports recovery and reconnects to the selected project/session. Quit and reopen the app; confirm the project, session, transcript, plan, checkpoint, and diff can be restored. A session from another repository must not appear in the current project.

Record failures with the exact versions, OS, step, visible error, and relevant OpenCode log. Do not claim the credentialed Architect flow passed from the contract test alone: it does not invoke a model, create prompts, or generate file changes.

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
- [ ] Run the full CI and live OpenCode contract checks on Ubuntu, macOS, and Windows.
- [ ] Run the Desktop packages workflow on the release commit; inspect four fresh-runner smoke tests, five packages, per-target hashes, and signing modes.
- [ ] Run the credentialed release smoke above on clean macOS ARM and Intel, Linux x64, and Windows x64 machines. Record the OS version, result, and any platform gaps.
- [ ] Configure Apple Developer ID signing, notarization secrets, and Apple's managed browser public-key credential entitlement before claiming a trusted macOS build. Otherwise keep the ad-hoc development label. Configure Windows signing before claiming a trusted Windows build.
- [ ] Create `vX.Y.Z` only after the checks above. The tag workflow verifies version parity and source revision, attests the packages, and publishes a development prerelease with checksums and a manifest.
- [ ] Verify downloaded package hashes and GitHub attestations from a separate clean machine; install and launch each package there before directing users to the release.

Current platform limits: installers are macOS ARM64/x64, Linux x64, and Windows x64. Linux packages are built on Ubuntu 22.04 for older glibc compatibility; other distributions still require a compatible graphical stack. Windows NSIS may download WebView2 during installation. The app relies on a separately installed OpenCode v2.0.24 and does not self-update. The hosted package smoke checks do not exercise credentialed model execution, so the manual release smoke remains required.

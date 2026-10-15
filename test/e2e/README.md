# E2E suite observations

Run WebdriverIO against a private Sail build and app profile as described in the repository `AGENTS.md`. The fixture specs and later app specs share one app process, so the WebdriverIO `before` hook selects the main window, closes a leftover settings window, resolves pending agent requests, terminates fixture ACP runtimes, clears browser storage, disk-backed fixture settings, and fixture navigation, then reloads the app before each spec. The E2E-only runtime reset prevents fixture processes from exhausting the app’s file descriptors in a full suite.

The E2E build accepts `SAIL_E2E_MACHINE_READING=healthy` to supply fixed healthy host memory and swap readings to the normal machine-pressure guard while keeping the real disk reading. Production builds ignore this variable. For an attached macOS app, pass it and a private `CLAUDE_CONFIG_DIR` through `open --env` and to WebdriverIO. The runner sets both automatically when it starts the app itself. The E2E build requires `SAIL_E2E_CONFIG_DIR` to be a private directory strictly inside the app process’s `TMPDIR`; pass the same private `TMPDIR` to the build, app, and attached runner. Settings, context approval, and memory storage reject config paths outside that directory, including symlink aliases.

Attached app and runner processes must share `SAIL_E2E_OPEN_URL_LOG` for `conversation-links.spec.ts`: leaving it unset in the runner failed with “Conversation link did not invoke the external browser command”; passing the app’s log path to both made the same spec pass. Set `SAIL_E2E_FAKE_GH_DIR` and `SAIL_E2E_FAKE_GH_BIN` to the private fake-gh fixture paths in both processes. A missing fake-gh fixture directory with no real `gh` on `PATH` returned exit 127 and `gh is not installed`; the fake shim can fall through to a real `gh` if one is available, so do not run attached ship specs with a missing fixture path.

## Per-run app data

Each native run launches the app with a fresh bundle identifier, and macOS and WebKit create a folder for it in `~/Library/Logs`, `~/Library/Caches`, `~/Library/WebKit`, `~/Library/Application Support`, and the per-user temporary and cache folders. `npm run test:native` removes the run's folders when its app stops, whether the run passed, failed or was cancelled, and a failed removal is reported in `result.json` under `leftovers`. At the start of each run it also removes folders of earlier `dev.smykla.sail.e2e.<32 hex>` runs whose `Sail E2E <8 hex>.app` process is gone (only a process started from the executable in an existing bundle counts; a command such as `tail -f` that merely names a file inside the bundle does not), and WebdriverIO state folders in the temporary directory whose owning process exited. The app also writes its log and `owned-processes` folders under the identifier compiled into the build, which a cached artifact shares between runs; those folders are removed after a run unless a live app was built with them, and otherwise by the next sweep. A run that is still in progress keeps its folders. Folders with other identifiers, such as ones an agent names for a manual test bundle, are never touched.

## Signed pre-quiescence run on 2026-10-10

The full private app run on `0e1a6109` completed all 53 spec files in 32m23s: 31 passed and 22 failed. The original `activity-history → agent-questions` and `task-overview-scale → task-overview` fixture transitions passed. `agent-status-bar` failed both in the full run and alone on the same missing permission assertion; `inbox` failed both ways on the same unread-attention timeout. `conversation-links` failed only when the attached app and runner used different URL log paths, as described above.

An additional exact-head `agent-spawn → attention` run failed both attention tests, while attention alone and `agent-status-bar → attention` passed attention. The old app repopulated private disk settings with spawn receipts and activity history after the before-spec reset. The current teardown drains its settings writes and unloads that webview before resetting the locked settings file; its final full-suite result belongs in PR #533.

## Clean macOS run on 2026-10-10

The full suite on `7e0fc1f8` reached its 30-minute limit after 50 of 51 spec files: 23 passed, 27 failed, and `zoom.spec.ts` did not start. `activity-history.spec.ts` followed by `agent-questions.spec.ts` passed both in this run and when selected alone.

The later focused reset also made `agent-status-bar.spec.ts` pass after `agent-spawn.spec.ts`. `agent-spawn.spec.ts` still failed the same two assertions when run alone: “starts selected providers without approval” expected a Claude thread but received an OpenCode thread; “routes MCP validation gates and enforces strict model selection” received an error result. Those failures are independent of fixture query state.

The full run before that focused reset also reported failures in these files. Their results have not been compared with isolated runs on the final revision:

- `acp.spec.ts`
- `agent-switching.spec.ts`
- `command-palette.spec.ts`
- `onboarding.spec.ts`
- `panes.spec.ts`
- `post-turn-checks.spec.ts`
- `project-menu.spec.ts`
- `settings.spec.ts`
- `ship-queue.spec.ts`
- `ship.spec.ts`
- `sidebar-resize.spec.ts`
- `sidebar-titles.spec.ts`
- `styled-dialogs.spec.ts`
- `subagent-navigation.spec.ts`
- `task-location.spec.ts`
- `task-overview-scale.spec.ts`
- `task-overview.spec.ts`
- `terminal-inspect.spec.ts`
- `terminal.spec.ts`
- `topbar.spec.ts`
- `transcript-keyboard.spec.ts`
- `transcript.spec.ts`
- `type-scale.spec.ts`
- `visual.spec.ts`
- `worktree-responsive.spec.ts`

The full-suite result for the final revision is recorded in PR #533. Keep failures tied to the exact revision and app profile used for each run.

## Signed 15bb diagnostic run on 2026-10-11

The private full suite on `15bb6788` completed all 53 spec files within the 70-minute bound: 31 passed and 22 failed. `close-worktree.spec.ts`, `task-overview-scale.spec.ts`, and `task-overview.spec.ts` passed in full order. The failing files were:

- `acp.spec.ts`
- `agent-spawn.spec.ts`
- `agent-status-bar.spec.ts`
- `agent-switching.spec.ts`
- `command-palette.spec.ts`
- `inbox.spec.ts`
- `memory-import.spec.ts`
- `onboarding.spec.ts`
- `panes.spec.ts`
- `post-turn-checks.spec.ts`
- `project-menu.spec.ts`
- `recent-threads.spec.ts`
- `right-panel.spec.ts`
- `ship.spec.ts`
- `sidebar-titles.spec.ts`
- `styled-dialogs.spec.ts`
- `subagent-navigation.spec.ts`
- `task-location.spec.ts`
- `terminal-control.spec.ts`
- `terminal-inspect.spec.ts`
- `topbar.spec.ts`
- `visual.spec.ts`

Compared with the earlier `8f272ceb` full-versus-isolated matrix, only `memory-import`, `right-panel`, and `styled-dialogs` changed from passing to failing. On fresh `15bb6788` apps, memory import and styled dialogs passed alone and after their immediate predecessor; the right panel failed alone with the same mobile bounds assertion as in the full run. This run is diagnostic for the pre-guard revision.

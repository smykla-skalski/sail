# E2E suite observations

Run WebdriverIO against a private Sail build and app profile as described in the repository `AGENTS.md`. The fixture specs and later app specs share one app process, so the WebdriverIO `before` hook selects the main window, closes a leftover settings window, and resets the window size, fixture navigation, pending agent requests, and the durable E2E settings flag between specs.

The E2E build accepts `SAIL_E2E_MACHINE_READING=healthy` to supply fixed healthy host memory and swap readings to the normal machine-pressure guard while keeping the real disk reading. Production builds ignore this variable. For an attached macOS app, pass it and a private `CLAUDE_CONFIG_DIR` through `open --env` and to WebdriverIO. The runner sets both automatically when it starts the app itself.

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

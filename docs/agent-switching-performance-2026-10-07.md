# Agent switching profile — 2026-10-07

## Finding

- Every recent-thread switch called `validate_repository`, including switches within the selected worktree. That command runs `git rev-parse`.
- An ACP thread in another worktree waited for `loadProject` before selection. Project hydration can register the OpenCode browser MCP server, inspect repository setup, list OpenCode sessions, and restore an OpenCode session. None of those calls is needed to show the requested ACP thread.
- The command palette had a separate ACP thread path with the same hydration wait.

## Change

- Check that the selected worktree still has a Git directory without spawning Git again.
- Open ACP threads as soon as the target worktree is selected. Finish OpenCode hydration in the background, while keeping its existing project selection guards.
- Route command palette thread selection through the same path.

## Desktop check

- Built and signed a private macOS E2E app with isolated data, WebDriver port, and ACP test agent.
- The E2E test delayed OpenCode browser setup by 2 seconds. The requested Claude thread appeared in 52 ms from click to DOM mutation in the rebased private build (342 ms in the preceding private run), before setup finished. It stayed selected and became ready after setup completed. The test also reopened the saved thread through the command palette.
- The review found that external removal of the selected worktree must reject saved thread selection. The same E2E suite passed that case.
- The existing command palette desktop suite passed all five cases. Svelte check, lint, and 307 unit tests passed.
- The broader ACP desktop suite did not pass. Its first test failed at the effort picker before reaching thread switching; later exploratory runs found outdated assertions for the busy card and permission status. Those assertions were left outside this change.

## Remaining measurement

- This test measures time until the requested thread appears. It does not measure readiness of real Claude or Codex adapters with long session histories. ACP `session/load` still replays history when the adapter requires it.
- OpenCode thread switches across worktrees still wait for project hydration. Its session selection and setup share a generation guard, so moving that wait requires a separate change to prevent a late restore from replacing the requested session.

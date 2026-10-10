# Agent instructions

## Isolated Sail desktop runs

- Treat existing Sail windows, dev servers, and E2E sessions as owned by other worktrees. Do not stop them or reuse their ports.
- Build test apps with a private `CARGO_TARGET_DIR` under a unique temporary directory. Give each macOS test bundle a unique Tauri `identifier` and `productName`; the identifier separates its system and webview data.
- Give each embedded WebDriver instance a free port through `TAURI_WEBDRIVER_PORT` or WebdriverIO's `embeddedPort`. The default is `4445`. Set `SAIL_E2E_CONFIG_DIR`, `SAIL_WORKTREE_ROOT`, and the XDG directories to private paths. Keep `SAIL_ACP_TEST_AGENT` pointed at this checkout's `test/e2e/acp-agent.mjs`.
- Set `SAIL_E2E_BINARY` to the private build when running WebdriverIO; the default is `src-tauri/target/debug/sail`. Avoid a shared Vite dev server on port `1420` by testing a bundled app.
- On macOS, sign the private `.app` bundle and launch a separate instance with `open -n -g`, passing the isolated environment through `open --env`. Verify readiness at `http://127.0.0.1:<port>/status` before driving it. In the Orca command sandbox, a localhost request can fail even while the endpoint is listening; run the readiness probe outside that sandbox.
- Stop only the processes started for the current run, then remove their temporary state.

## Scratch and build output

- Put all scratch and build output of a worker or gate run under one scratch root made with `mktemp -d "${TMPDIR:-/tmp}/sail-<issue>-<role>.XXXXXX"`. Point `CARGO_TARGET_DIR` and other build caches inside it so a single `rm -rf` removes everything, including the private target dir of an E2E build.
- Record the creating process with `printf '%s\n' "$$" > "$scratch_root/.sail-scratch-root"` after creating the root. Sail's startup sweep uses this marker to protect a live owner and recognize abandoned roots after two idle hours.
- Only the run that created a scratch root removes it, via a `trap` or `finally` so it also runs when the run succeeds, fails, is canceled, or stops blocked. Before `rm -rf`, check the path is non-empty and starts with `sail-`.
- Never delete directories or worktrees you did not create, including other runs' `sail*` directories and roots left by a dead run. Report those instead.
- Reuse one target dir per worktree for sequential gates of the same revision; use a fresh one when the revision changes. Concurrent builds use separate target subdirectories inside the root.
- Pass the scratch root to review and test subagents. They build in their own subdirectory of it instead of creating scratch directories elsewhere, and never remove the root.
- Check free space before a build-heavy task with `df -Pk "${TMPDIR:-/tmp}"`. Under 20GB free, report it in your handoff, remove your own earlier scratch roots first, and stop if space stays under 20GB.
- Leftover target dirs once reached about 150GB across about 190 directories on a dev machine. Issue 339 tracks automatic cleanup in code; this rule is the interim guard.

## Visual checks

- These rules apply to changes with a visible UI effect.
- Treat large displays as the primary target, because most Sail use is on one, but not the only one. Judge each UI change at 2560x1440 and 1920x1200 first, in light and dark themes, then confirm no horizontal overflow at 390 px; the app's minimum width is 320 px.
- In the e2e harness, size the window with `browser.setWindowSize(2560, 1440)` and check `browser.execute(() => innerWidth)` before saving a screenshot. A smaller display clamps the window silently; if it does, say so in the PR and do not call the capture 2560.
- At large sizes, look for wasted space, sparse layouts, and over-stretched elements. The main chat, transcript, and workspace panes use the available width; do not center them or cap their width unless the task asks for it. Max widths remain correct for dialogs, menus, popovers, and forms; when you cap something else, say why in the PR.
- Large-display work must not regress the keyboard and low-vision checks in `docs/persona-usability.md`: 200% zoom, visible focus, and keyboard reachability.
- PR screenshots: one per theme at 2560 wide for each changed view. Say in the PR which views were only unit-tested and never seen in the app.

# Persona walkthrough results — 2026-10-01

Four agents ran separate, task-based walkthroughs of the macOS Tauri app at commit `dcd9283`. Each used a disposable Git repository and the real Sail UI through embedded WebDriver. Claude and Codex were exercised with the repo's local ACP test agent; no provider credential or paid model was used. These are **simulated persona expert audits**, not tests with representative people.

The main reference flow was [Orca's documented repo → worktree → agent → review → cleanup path](https://www.onorca.dev/docs/first-session). Sail's tested path is summarized below.

| Persona                           | Tasks completed                                                                                                                                                                                                                      | Limit                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Maya, AI power user               | Created worktree; ran Claude and Codex conversations; approved and stopped agent actions; switched repositories; checked live diff, reverted file, and saw Changes clear; restored both threads.                                     | Architect plan/diagram unavailable without plan-review plugin and provider.                    |
| Alex, first-time user             | Found repository setup, runtime path, group and worktree controls; saw repair steps for missing plugin/provider; restored repo and theme after reload; recovered from invalid runtime path.                                          | Native macOS repository picker is outside embedded WebDriver.                                  |
| Jordan, multi-repo maintainer     | Grouped two repositories; created worktrees in Sail's folder; ran separate Claude/Codex threads; switched and reloaded without thread crossover; dirty deletion refused; clean deletion removed only the chosen worktree and thread. | WebDriver's select helper failed to send a native change event; explicit select change worked. |
| Sam, keyboard and low-vision user | Enlarged UI, used the worktree dialog and Escape, opened/closed Changes with Cmd+L.                                                                                                                                                  | WebDriver did not advance focus with Tab; plan/diagram unavailable without plugin/provider.    |

## Findings and response

1. **Medium — Worktree creation did not offer an agent.** Compared with Orca's worktree launcher, Sail required a second navigation step. The dialog now offers available agents and remembers the choice. The selected agent opens in the new checkout.
2. **Medium — ACP activity was unclear.** The header showed “Ready” during a running prompt and the sidebar gave no running cue after a switch. The header and active thread row now show working state.
3. **Medium — Cancelled tool looked pending.** Escape cleared the permission but left the tool row marked pending. Tools now show “stopping” until the agent confirms cancellation, then “cancelled.”
4. **Medium — Group editor focus and Escape.** Opening `+ Group` left focus on the trigger; Escape did not dismiss the editor. The input now receives focus, and Escape closes it and restores focus.
5. **Low — Session empty state.** “No sessions found” appeared beside an active ACP thread. It now says “No OpenCode sessions found.”
6. **Low — Runtime override error.** An invalid binary error appeared beside “OpenCode connected,” although the old connection correctly remained live. The error now says the current connection remains active.

## Coverage limits

- No credentialed Architect plan, generated diagram, or live model execution was available in the disposable profile. The [release validation script](validation.md) remains the procedure for that flow.
- Embedded WebDriver cannot operate the native macOS folder picker or provide reliable Tab traversal here. Those need a separate native accessibility pass.
- The test agent simulates ACP protocol behavior; the installed Claude/Codex CLIs and their remote authentication were not used in this audit.

## Final verification

The rebuilt macOS desktop app passed all 5 WebDriver spec files (13 tests). These cover repository grouping and switching; worktree creation from the default or selected base; agent selection in the worktree dialog; dirty-file protection and deletion; separate Claude and Codex conversations; thread restore; running and cancellation states; runtime recovery; settings persistence; and zoom. The 22 unit tests, Svelte check, and lint also passed. A review found a delayed ACP cancellation could update a different thread after switching; generation and session guards now prevent that cross-thread update.

# Session continuity walkthrough — 2026-10-07

Maya, the AI power user, runs several agents and moves between them while they work. This walkthrough repeats her path against a private macOS build through embedded WebDriver, with the repository's ACP test agent emulating the Claude adapter's session fingerprint: a load whose MCP settings differ from the live session restarts it and cancels its work. It is a scripted, simulated persona pass, not a study with real users.

| Task                                                                                                                                               | Result                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a long answer, switch to another thread in the same worktree and back three times, then to a thread in another worktree and back three times | The answer kept streaming. Every part arrived once, the header showed Working, the model picker kept its value, and the agent recorded no restart. |
| Let the answer finish while looking at another thread                                                                                              | The post-turn check ran once, and switching back showed the complete answer.                                                                       |
| Start background work, switch away and back                                                                                                        | The background result arrived after the switch.                                                                                                    |
| Delegate to a subagent, switch away and back while it works, then again after it finishes                                                          | The subagent stayed Working while live, finished once, and the sidebar showed one subagent row with no Disconnected copy.                          |
| Use Sail's tools from a thread after switching                                                                                                     | The agent's `worktree_list` call succeeded.                                                                                                        |
| Reopen a thread whose agent process dropped the session                                                                                            | The thread recovered on the next activation and answered.                                                                                          |
| Repeat the long answer in a Codex thread whose agent restarts on any load                                                                          | Switching never restored the running session, and the answer finished.                                                                             |

With the previous per-load MCP settings restored (`SAIL_ACP_PER_LOAD_MCP=1`), four of these tasks fail because switching restarts the session. A real Codex turn kept running through a mid-turn load, but restarted its MCP server; the result is recorded on the tracking issue.

# Attention walkthrough — 2026-10-08

Priya, a lead who runs many Ship issues, needs one place that says what waits on her. Jordan maintains several repositories, and Sam works from the keyboard at a narrow width. This walkthrough drives a private macOS build through embedded WebDriver with seeded Ship runs. It is a scripted, simulated persona pass, not a study with real users. The Dock badge and OS notifications are native and were not observed; their counts and click routing are covered by unit tests and by an emulated click event at the app boundary.

| Persona | Task                                                                               | Result                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Priya   | Open Sail with two Ship issues that need input and read the count on every surface | Inbox button, Inbox header and status bar all said 2. The Ship tab said 2 as well, because both items were Ship issues that need input.                                    |
| Priya   | Dismiss one Ship item from the Inbox                                               | Inbox and status bar dropped to 1 together. The item came back only after its state changed (unit tested).                                                                 |
| Priya   | Click a Ship notification for the second issue                                     | Sail opened the Ship view with that issue focused. The click was emulated at the app boundary, not through the OS.                                                         |
| Jordan  | Read the Inbox with items from the repository                                      | Items sat under their repository name, with the same global count in the header.                                                                                           |
| Sam     | Press Cmd+J twice from the Ship view                                               | Focus moved to the first item, then to the second, and wrapped. Cmd+Shift+J still opens the side chat. The Inbox button advertises the shortcut through aria-keyshortcuts. |
| Sam     | Narrow the window to 640 px                                                        | The status bar kept "! 2" visible. Before, its counts were hidden below 700 px.                                                                                            |

Not covered: a real OS notification, the Dock or taskbar badge, snooze expiry in the live app, and the Settings window's per-type selects (not exercised through WebDriver).

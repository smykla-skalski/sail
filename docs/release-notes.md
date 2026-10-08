# Sail development build

These installers are development builds. macOS artifacts use ad-hoc signing unless a Developer ID certificate and notarization secrets were configured for the workflow. Windows and Linux artifacts are unsigned. Check `release-manifest.json` for the signing mode, source commit, target, and SHA-256 of each package before installing. The tag workflow also records GitHub artifact attestations for the packages.

OpenCode v2.0.24 is a separate prerequisite; it is not bundled. Install the tested plan-review plugin revision before starting an Architect plan. See [installation and first project](https://github.com/smykla-skalski/sail/blob/main/docs/install.md) and [validation limits](https://github.com/smykla-skalski/sail/blob/main/docs/validation.md).

There is no automatic updater. To update, download the next package for your platform and install it over the previous version after quitting the app. Verify the new manifest and run the first-project checks again.

## Text size, chat width and theme

- **Theme default changed.** Settings > General > Appearance now offers System, Light and Dark. System follows the operating system appearance and switches live when it changes. New profiles start on System; a stored Light or Dark choice is kept.
- No interface text is smaller than 12 px. Sidebar thread titles are 13 px in the foreground color, and status badges, labels, timestamps and counts that were 9 to 11 px are now 12 px.
- Chat text uses the full width of the window again, with a 20 px margin on each side, in every thread view. Lines keep line height 1.5, and code blocks and tables scroll horizontally inside the chat.
- Markdown headings in the transcript have their own sizes.
- Durations, counts and timestamps use tabular digits, so numbers line up. The Ship run launch time no longer wraps.

## OpenCode in the agent pane

- OpenCode threads open in the same pane as Claude and Codex, in the main pane and in split panes. The sidebar, command palette and `project_threads` list OpenCode sessions through `opencode acp`, including sessions started outside Sail.
- On first start Sail moves saved OpenCode references (pane layouts, recent threads, spawn receipts, Ship runs, messages, post-turn checks) to the ACP form once. OpenCode session ids do not change.
- **Rename** works for every agent thread. The title is stored in Sail; the agent's own title is not changed.
- **Delete** removes a thread from Sail only. An OpenCode session stays in OpenCode's store and stays hidden in Sail.
- **New plan** now opens an OpenCode thread; choose the plan mode there.

## Keyboard, shortcuts and screen readers

- The command palette also runs app actions: split, terminal, side chat, Inbox, next attention item, task overview, Ship runs, Changes, settings, theme and the shortcut sheet. Each shows its shortcut when it has one. A **⌘K** button in the top bar opens the palette.
- Cmd+/ (Ctrl+/ elsewhere) opens a sheet that lists every keyboard shortcut.
- The composer shows "Enter to send · ⇧Enter newline" again.
- Every sidebar thread row has a **⋯** button, so its menu opens from the keyboard.
- **Select-to-copy stays on by default.** Settings > General > Clipboard turns it off. When it is on, each copy shows and announces "Copied".
- Detail tabs are announced as tabs with the selected one marked. The Inbox button's accessible name now matches its label, "Inbox (N)". The command palette is a combobox with a list of options.
- Failed tool cards no longer re-announce old errors when a thread loads; only errors that arrive while you watch interrupt a screen reader.
- Scrollbars appear when you hover a scrollable area, not only while it scrolls.

## Attention and notifications

- **Notification default changed.** OS notifications now default to "Only when Sail is in the background". Before, Sail notified whenever the thread was not the one on screen, even while you were using Sail. Choose Never, Only when Sail is in the background, or Always for each type (Needs your input, Turn completed, Ship updates) in Settings. Existing profiles move to the new default, except one that had OS notifications switched off: it keeps Never for every type.
- Notifications are batched: at most one per 10 seconds, with a count when several arrive together. Clicking one opens the thread, Ship issue or pull request it is about.
- One attention count covers permission and question requests, Ship issues that need input, are ready to merge, were closed without merging or stalled, and waiting subagents. The Dock badge, Inbox button, status bar and Ship tab read the same list; the Ship tab shows the Ship issues that need input instead of the run count. The status bar keeps its counts below 700 px.
- The Inbox groups items by repository. You can dismiss a Ship or subagent item until its next state change, or snooze it for an hour or until tomorrow at 08:00. Items clear when their state resolves.
- Cmd+J (Ctrl+J elsewhere) goes to the next item needing attention. Cmd+Shift+J still opens the side chat.

## One transcript view

- Claude, Codex and OpenCode threads now render through one transcript view, so the main thread, the OpenCode pane and the agent workspace look and behave the same.
- OpenCode tool calls are grouped like Claude and Codex tool calls, and OpenCode thinking shows as a collapsed "Show thinking" row. Thinking is collapsed for every agent.
- Hooks, post-turn checks and the subagent group card appear in event order between the messages, with one card per turn, instead of after the last message.
- Messages show their time. The assistant avatar is the provider's mark instead of "S.".
- Code blocks have a **Copy** button. **Jump to latest (N new)** appears when you scroll away from the end of a live transcript.
- Permission requests use one card. It shows the exact command and files, links back to the tool call, and never offers "Allow always" for unknown or high-risk actions.

## Ship queue, archive and actions

- **Ship queue** (More actions, Ship queue) lists the issues of every run in one full-width table. Issues that need you come first, merged and closed issues stay hidden until you show them, and a Run filter narrows the table to one run. The header shows worker usage against the run limits; a ship-it coordinator itself starts at most 3 workers and keeps a slot free for gates.
- Direct `/ship-it` runs now show the real issue title instead of "Issue #N".
- **Archive.** A run archives after all its issues are merged or closed, its claims are released and its checkpoints are complete. Choose Off, Immediately, 1 day (default) or 7 days under Settings, Ship archive. Archiving only hides the run: checkpoints, evidence, branches and worktrees stay, so a repository's branch cleanup policy is unaffected. The Archived filter in the queue and the Ship panel lists archived runs, and Unarchive brings one back and keeps it out of auto-archive. On upgrade Sail archives the runs that already qualify and shows "N runs archived · Show".
- **Actions** ask for confirmation and name their target. **Merge** follows the repository's release policy (`.sai/ship-it-release.json` or its instructions): a bot comment such as `squash`, or a GitHub merge pinned to the head SHA. It refuses when the pull request head differs from the checkpoint revision or the evidence is not ready, and it never uses an admin override. **Retry** restarts a failed issue from its checkpoint with a fresh worker. **Stop run** stops unfinished issues and releases their claims as cancelled. **Archive** and **Unarchive** apply to a whole run.
- Task checkpoints accept `cancelled` and `failed` statuses, matching the ship-it checkpoint contract.

## Subagent navigation and control

- A subagent's breadcrumb shows its parent thread, with **Parent** and previous/next sibling buttons. The keys are Cmd+[ (Ctrl+[ elsewhere) for the parent and Cmd+Shift+[ and Cmd+Shift+] for the previous and next sibling. Cmd+Alt+Arrows still moves pane focus.
- A permission request from a subagent is answered inline in the parent's subagent card, and it replays in the child's own view. Answering one request from two places resolves it once; the other place shows "Answered" instead of an error.
- Native Claude subagents are read-only and have no Stop button: stop the parent turn to stop them. The composer of a native subagent turns on only when its agent advertises a prompt capability; the current Claude adapter advertises none.
- **Stop** on a subagent card stops OpenCode and MCP-spawned subagents one at a time. **Stop all** asks for confirmation and leaves Ship workers and validation gates running; stop those with Stop run.
- The sidebar indents subagents with guide lines and shows a (+N) descendant count on the parent. A subagent spawned in another worktree also appears under its parent as a reference row, and its own row says which thread spawned it. OpenCode subagents nest under their parent.
- The Ship dependency map offers **Open** on subagent nodes and no longer lists "Checks: Unavailable" for them.

## Changes in this build

- The top bar keeps the project and thread path, **Inbox**, **New agent ▾**, **Changes**, and a **⋯** menu. Task overview, thread switching, commands, **Run project**, agent terminals, agent browser access, and thread actions are in **⋯**, so the top bar no longer overlaps or clips at 1280 px with panes open.
- **Delete thread…** asks before removing a thread from Sail, and cancelling keeps it. Delete confirmations use a red button.
- Text, input borders, and buttons meet WCAG 2.2 AA contrast in the light and dark themes. Buttons keep the right colors when the theme changes while Sail is in the background.
- The selected thread in the sidebar shows an accent bar and a bold title.
- **Ship runs** shows the repository name; hover it for the full path.
- A new thread shows **Connecting** until its agent session starts, and an OpenCode thread without a model shows **Model setup needed** instead of **Needs input**, so the thread header and the status bar agree on whether an agent is running.

## Ship list and detail

- Ship rows take two lines and sit under **Needs input**, **Fixing & active**, **Waiting**, and **Queued**. The second line shows the newest of the checkpoint blocker, its first open question, its next action, and live activity. Placeholder checkpoint text stays hidden until the worker updates it.
- **Done** is hidden by default. When every issue is merged, the list says "All N issues merged" with **Show done**. A selected or focused row that becomes done stays visible until you select another, and rows do not move while focus is inside the list.
- The detail shows a stage indicator that does not move backwards: a fix round shows "round N" on the furthest stage reached, and gates the risk policy did not select show "not required". A **Task contract** section collects the objective, criteria, risk and gates, evidence, claim, and context handoff.
- Below about 560 px of pane width the detail replaces the list (**← All issues** or Escape returns to the row). Wider panes show the list and detail side by side. Focus moves to the detail heading when you open an issue.
- ↑ and ↓ move between rows and Enter opens one. A **List | Graph** switch shows the dependency map. All four Ship panel mounts show the same panel, and **Close** is now **Hide panel**.
- The empty state offers both routes: `/ship-it <issue-url>` and an issue graph from a plan.

## Adapter diagnostics

- When an agent adapter writes to stderr, `sail.log` now records its lines as `agent_stderr_line` entries tagged with the agent, and the existing `agent_stderr` entry still reports the total byte count.
- Forwarding is bounded per adapter process: the first 48 lines, at most 12 KB in total, each cut to 512 bytes. Later output is dropped, and `agent_stderr` reports `forwardedLines`, `forwardedBytes`, `droppedLines` and `droppedBytes`.
- Secrets are redacted before writing: live `SAIL_BROWSER_TOKEN` values, `Bearer` and `Basic` credentials, values of keys such as token, password, API key and cookie, URL passwords, and common key formats (OpenAI, GitHub, Slack, AWS, Google, JWT). Redaction is best effort; do not attach `sail.log` to public reports without reading it.

## Ship status

- Ship shows "Fixing · round N" while a worker repairs NEEDS_FIXES or FAIL findings, and "Fixing (CI)" while it repairs failing checks. Only a blocked worker report or a BLOCKED verdict shows "Needs input", with the checkpoint blocker as the reason.
- A pull request with no required checks can reach "Ready to merge". A pull request closed without merging shows "Closed without merge". An issue closed before its worker launched shows "Closed" instead of failed.
- Dependent issues show "Waiting on #N", or "Waiting on #N (needs input)" when that dependency has failed.
- Settings has a new "Who merges Ship PRs" choice. "You" is the default: workers stop at a mergeable pull request and report `awaiting_merge`. "Agent, per repository release policy" leaves merging to the worker. Repository instructions that say who merges take precedence.
- Stored `blockedReason` text from earlier fix rounds is ignored while a NEEDS_FIXES or FAIL verdict is current.

## Subagent results and status

- A finished subagent shows its agent type, task, duration and tool count. Its result is clamped to three lines, with Expand and Open.
- A finished subagent no longer repeats its state as the result, and a child with no output appears once.
- Subagent cards share one screen-reader announcement that speaks state changes only.
- A finished OpenCode subagent reads "Finished" instead of "Queued". Running and finished children are listed apart, can be opened, and appear in workspace activity.
- A failed subagent stays in the sidebar, and its parent shows "1 failed child" until the parent's next turn completes or you open the child.

# Sail development build

These installers are development builds. macOS artifacts use ad-hoc signing unless a Developer ID certificate and notarization secrets were configured for the workflow. Windows and Linux artifacts are unsigned. Check `release-manifest.json` for the signing mode, source commit, target, and SHA-256 of each package before installing. The tag workflow also records GitHub artifact attestations for the packages.

OpenCode v2.0.24 is a separate prerequisite; it is not bundled. Install the tested plan-review plugin revision before starting an Architect plan. See [installation and first project](https://github.com/smykla-skalski/sail/blob/main/docs/install.md) and [validation limits](https://github.com/smykla-skalski/sail/blob/main/docs/validation.md).

There is no automatic updater. To update, download the next package for your platform and install it over the previous version after quitting the app. Verify the new manifest and run the first-project checks again.

## Changes in this build

- The top bar keeps the project and thread path, **Inbox**, **New agent ▾**, **Changes**, and a **⋯** menu. Task overview, thread switching, commands, **Run project**, agent terminals, agent browser access, and thread actions are in **⋯**, so the top bar no longer overlaps or clips at 1280 px with panes open.
- **Delete thread…** asks before removing a thread from Sail, and cancelling keeps it. Delete confirmations use a red button.
- Text, input borders, and buttons meet WCAG 2.2 AA contrast in the light and dark themes. Buttons keep the right colors when the theme changes while Sail is in the background.
- The selected thread in the sidebar shows an accent bar and a bold title.
- **Ship runs** shows the repository name; hover it for the full path.
- A new thread shows **Connecting** until its agent session starts, and an OpenCode thread without a model shows **Model setup needed** instead of **Needs input**, so the thread header and the status bar agree on whether an agent is running.

<<<<<<< HEAD

## Ship list and detail

- Ship rows take two lines and sit under **Needs input**, **Fixing & active**, **Waiting**, and **Queued**. The second line shows the newest of the checkpoint blocker, its first open question, its next action, and live activity. Placeholder checkpoint text stays hidden until the worker updates it.
- **Done** is hidden by default. When every issue is merged, the list says "All N issues merged" with **Show done**. A selected or focused row that becomes done stays visible until you select another, and rows do not move while focus is inside the list.
- The detail shows a stage indicator that does not move backwards: a fix round shows "round N" on the furthest stage reached, and gates the risk policy did not select show "not required". A **Task contract** section collects the objective, criteria, risk and gates, evidence, claim, and context handoff.
- Below about 560 px of pane width the detail replaces the list (**← All issues** or Escape returns to the row). Wider panes show the list and detail side by side. Focus moves to the detail heading when you open an issue.
- ↑ and ↓ move between rows and Enter opens one. A **List | Graph** switch shows the dependency map. All four Ship panel mounts show the same panel, and **Close** is now **Hide panel**.
- The empty state offers both routes: `/ship-it <issue-url>` and an issue graph from a plan.
  \=======

## Adapter diagnostics

- When an agent adapter writes to stderr, `sail.log` now records its lines as `agent_stderr_line` entries tagged with the agent, and the existing `agent_stderr` entry still reports the total byte count.
- Forwarding is bounded per adapter process: the first 48 lines, at most 12 KB in total, each cut to 512 bytes. Later output is dropped, and `agent_stderr` reports `forwardedLines`, `forwardedBytes`, `droppedLines` and `droppedBytes`.
- Secrets are redacted before writing: live `SAIL_BROWSER_TOKEN` values, `Bearer` and `Basic` credentials, values of keys such as token, password, API key and cookie, URL passwords, and common key formats (OpenAI, GitHub, Slack, AWS, Google, JWT). Redaction is best effort; do not attach `sail.log` to public reports without reading it.

> > > > > > > origin/main

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

# Plan review for ACP agents

Sail reviews structured plans for every ACP agent. The tools live on the `sail-browser` MCP server that Sail adds to each ACP session, so they need no plugin and no agent-specific setup.

## Tools

| Tool                | Purpose                                                                                                       |
| :------------------ | :------------------------------------------------------------------------------------------------------------ |
| `sail_plan_propose` | Submit a plan: summary, steps, an overview flowchart, a sequence diagram, optional diagrams and alternatives. |
| `sail_plan_ask`     | Ask every clarifying question at once as one form.                                                            |
| `sail_plan_step`    | Report `in_progress`, `done` (with a `check`), `blocked` or `skipped` for an approved step.                   |
| `sail_plan_amend`   | Add steps found during execution. Routine steps inside approved files continue; others pause for the user.    |

The names differ from the OpenCode plugin's `plan_*` tools on purpose, so an agent that still loads the plugin can tell the two sets apart. Native OpenCode sessions do not list the tools. The tools are available to every capability profile because proposing a plan changes no files.

## Flow

1. The agent calls `sail_plan_propose` and ends its turn. The plan appears in the Plan tab of the pane.
2. The user approves, rejects, revises, edits or comments on each step, then sends the review. Sail resumes the same session by sending an ACP prompt that carries the review (`<plan-review>`). Answers to `sail_plan_ask` arrive the same way (`<plan-answers>`).
3. Approving execution switches the session out of plan mode with `session/set_config_option` when the agent exposes a mode option that has a `plan` value. Sail returns to the mode the user used before planning, or to the first of `build`, `default`, `acceptEdits`, `code`, `agent` or `auto`. Agents without such an option stay as they are.
4. The agent reports each step with `sail_plan_step`. A high-risk or failing step pauses the plan at a checkpoint for another review. When every approved step is finished, the tool result contains a digest of what changed.

Each version of a plan and each review is kept as plan history. State is stored per agent, worktree and session in Sail's settings, so a pending review, questions and history survive an app restart. Sail keeps the newest 50 sessions and 200 history entries per session, and trims older history and sessions first so the saved value stays under 400,000 characters; the settings mirror in local storage has a quota of a few megabytes shared with every other setting.

## Edits outside the approved files

The OpenCode plugin asked before an edit outside the approved files. Sail cannot intercept an edit in another agent's process, so the check is advisory:

- Sail watches completed edit tool calls of the executing plan and records their files on the active step.
- A file that no approved step lists is flagged in the result of the next `sail_plan_step` or `sail_plan_amend` call, which tells the agent to amend the plan or revert the edit.
- The Plan tab shows the same files under "Work outside approved steps", and the Changes tab marks them in the diff list.

Nothing blocks the edit. Use the agent's own permission mode if an edit must be prevented.

## OpenCode

OpenCode keeps its own plan-review plugin until the native integration is removed. When the plugin is still enabled in the user's OpenCode configuration (the global config directory, `OPENCODE_CONFIG`, or any `opencode.json` or `.opencode` directory above the worktree), Sail warns in the OpenCode ACP pane (once OpenCode runs on the ACP path; the native pane still needs the plugin) that the agent sees two plan tool sets and asks the user to remove the plugin.

## Related issues

- [#292](https://github.com/smykla-skalski/sail/issues/292) unifies visual planning across agents.
- [#295](https://github.com/smykla-skalski/sail/issues/295) covers revision feedback for the native Claude and Codex plans (`ExitPlanMode`, `plan_update`), delivered separately. Structured plans from the tools above take revision feedback through the Plan view's review instead; Sail does not duplicate the native flow.

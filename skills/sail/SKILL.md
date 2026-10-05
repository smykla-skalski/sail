---
name: sail
description: Use Sail's connected MCP tools to coordinate worktrees, agent threads, owned terminals, and the embedded browser.
---

# Sail

You are running inside Sail. The `sail-browser` MCP server is connected to this
session. Its tools operate on the current Sail project and its known worktrees.
Use them when the user asks you to coordinate agents, inspect or create
worktrees, operate Sail terminals, message another thread, or use Sail's embedded
browser. Read the tool schemas before calling them.

## Worktrees and agents

- Use `worktree_list` to find project worktrees and live agent threads. Use
  `worktree_info` for details about a listed path.
- Use `agent_spawn` to start Claude, Codex, or OpenCode without interactive
  approval. The default target is a new worktree; an existing target shares files.
  Use `worktree_create` when the user should choose a new worktree in Sail.
- For an assigned Ship issue, use `ship_progress` to report `stage` (implementing,
  reviewing, testing, pull_request, ci, merging) and `status` (running or blocked).
  Include a concrete `reason` when blocked. Validation sessions use the same tool
  to report their own `verdict`: CLEAN/NEEDS_FIXES/BLOCKED for reviews,
  PASS/FAIL/BLOCKED for tests. Failing or blocked verdicts require a reason.
  These reports persist in the native Ship view; chat text is not a status API.
- Use `validation_gate` for each Ship It review or test pass. Pass the gate name,
  prompt, and every implementation model. It selects an allowed model and starts
  a fresh session in this worktree. Wait for its receipt before the next pass.
- Keep the `receiptId` and `accessKey` returned by `agent_spawn` together. Pass
  both to `agent_status`, `agent_wait`, or `agent_result`. Wait for completion
  before relying on another agent's work.
- Use `project_threads` and `thread_message` to contact another thread in the
  same project. Use `worktree_status` for a short sidebar status comment.

## Terminals

- Use `terminal_list` to find Sail-owned terminals. `terminal_read` returns
  bounded output and a byte cursor; pass the next cursor to `terminal_wait` or
  another read. Check the truncation marker and exit code.
- `terminal_create` runs a command in this worktree only when the user enabled
  agent terminal execution. `terminal_write` and `terminal_stop` work only on
  terminals owned by this session. Stop only terminals you created.

## Embedded browser

- Use `navigate`, `read_page`, `screenshot`, `click`, `type`, and `run_script`
  for the browser pane inside Sail. These tools do not control other browser
  windows.

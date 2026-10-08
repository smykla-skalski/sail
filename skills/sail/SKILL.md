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

Sail assigns this session an `explore`, `review`, `build`, or `release`
capability profile. The MCP catalog contains only tools enabled by that profile,
and disabled tools are rejected even if called from stale schema context. Do not
work around a missing tool. Permission prompts include Sail's risk classification,
reason, and policy revision; unknown and high-risk actions require a person.

## Workflow references

- Bundled workflow prompts contain the core contract only. When that contract
  links a detailed reference, load it with `skill_reference` instead of guessing.
- Call `skill_reference` with a skill and no reference to list its bundled files
  and exact SHA-256 versions. Calls and selected reference names remain visible
  in the task transcript.
- References are embedded in Sail and remain available offline.

## Worktrees and agents

- Before resuming a Ship task, call `task_checkpoint_read` and inspect its
  reconciliation result. Stop on a revision or delivery-state mismatch, unless
  the user merged a pull request you left mergeable for them; then continue
  with completion.
- Call `task_checkpoint_update` after every phase, blocker, revision,
  required-gate, unresolved-question, or next-action change. Keep one concrete
  next action; never infer success from the phase alone. Pass the sequence and
  revision from the last read. If Git drifted, inspect it and set
  `rebindRevision` explicitly; on a stale-update error, read and merge again.
- Read the checkpoint execution boundary before each command, then record results
  with `task_evidence_record` using its `expectedRevision`,
  `expectedMutationGeneration`, and `expectedBaseRevision`, plus the exact
  acceptance criterion strings from the checkpoint and a bounded log, terminal,
  or URL reference. Read the checkpoint before an inline gate and pass its `revision`
  with the `ship_progress` verdict; cross-validation gates use their launch
  revision. Re-read after source changes; stale evidence never makes a
  task merge-ready.
- Before starting Ship validation, call `validation_policy` with an explicit
  `low`, `medium`, or `high` risk. Inspect the returned selected risk, required
  gates, policy sources, and revision. Run only the required gates. If the
  worktree changes, select the policy again; Sail retains earlier escalation.
- Use `worktree_list` to find project worktrees and live agent threads. Use
  `worktree_info` for details about a listed path.
- Use `agent_spawn` with an explicit `role` and `risk`; Sail selects the exact
  configured provider, model, and variant. Roles are `exploration`,
  `implementation`, `debugging`, `review`, and `ci-triage`; risks are `low`,
  `medium`, and `high`. Never replace a rejected or missing route with an alias or
  an unconfigured model. The default target is a new worktree; an existing target
  shares files. Use `worktree_create` when the user should choose a new worktree
  in Sail.
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
  before relying on another agent's work. Inspect the receipt's requested and
  actual provider, model, and variant. When it marks independent review as
  required, launch the configured review route before treating the task as done.
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

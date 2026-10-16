---
name: sail
description: Use Sail's connected MCP tools to coordinate worktrees, agent threads, owned terminals, the embedded browser, and shared project memory.
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

## Session tasks

- Each turn starts with a Sail starting task. Read `sail_tasks_read` at the start
  of work, then call `sail_tasks_report` to describe routine tasks and progress.
- Use stable task IDs within the turn and statuses `pending`, `in_progress`,
  `done`, `blocked`, or `skipped`. Report updates as work changes.
- Pass the current `turnId` and `expectedRevision` from the latest snapshot.
  After a stale error, read again before retrying. Task scope comes from your
  session; never send another session's work.
- Set `focus` to the ID of your current `in_progress` task, or `null` when no
  task is active. Tasks track routine work alongside formal plan review.

## Workflow references

- Bundled workflow prompts contain the core contract only. When that contract
  links a detailed reference, load it with `skill_reference` instead of guessing.
- Call `skill_reference` with a skill and no reference to list its bundled files
  and exact SHA-256 versions. Calls and selected reference names remain visible
  in the task transcript.
- References are embedded in Sail and remain available offline.

## Shared memory

- In Sail sessions, use the `sail-browser` memory tools. A system-wide `sail-shared-memory` installation accesses the same project store; do not search or write through both servers for the same task.
- When memory tools are available, search for relevant prior decisions or conventions before work that depends on them. Inspect matches before relying on them; skip recall for trivial tasks.
- Search before saving to avoid duplicates. Remember only confirmed, durable project facts, never secrets, raw transcripts, or temporary progress.
- Use `memory_supersede` for a corrected handoff. Set `resolveConflicts: true` when that correction settles its existing disagreements; otherwise unresolved conflicts carry forward. Use `memory_mark_conflict` when current handoffs disagree without a chosen replacement. Search omits superseded handoffs; inspect preserves their history.
- Memory belongs to the current Git project and its linked worktrees, not every project. Current user instructions and repository rules take precedence over stored memories.
- Forget a memory only when the user asks.

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
  actual provider, model, and variant. A fresh validation session satisfies
  review and test context isolation; its provider and model may match the
  implementation worker. Do not launch a second review route for that receipt.
- Use `project_threads` and `thread_message` to contact another thread in the
  same project. Use `worktree_status` for a short sidebar status comment.
- On the first substantive task turn, once you understand the work, call
  `thread_keywords` with 5–10 concise search terms. Prefer domain nouns,
  components, technologies, issue identifiers and the user's terminology;
  omit generic verbs such as fix, implement and work. Replace the list when the
  task scope materially changes.

## Plan review

- Follow an approved plan or an assigned Ship issue's resolved task contract. Do not require a second plan solely because that authorized work spans multiple files. Ask only for a material decision or scope change not covered by the existing contract.
- For risky, ambiguous or multi-file work without an approved plan or assigned Ship task contract, propose a plan instead of editing:
  read the code first, then call `sail_plan_propose` (steps, an overview
  flowchart and a sequence diagram, each as lists of lines) and end your turn.
  Small, obvious changes need no plan.
- If requirements are unclear, call `sail_plan_ask` once with every question,
  prefer choices with a recommendation, and end your turn.
- The user reviews the plan in Sail, step by step, and answers by sending you a
  `<plan-review>` or `<plan-answers>` message in this session. On `revise`,
  address every comment and call `sail_plan_propose` again, keeping the ids of
  steps you keep.
- After approval, work only on approved steps. Report each with
  `sail_plan_step` (`in_progress`, then `done` with a `check`, or `blocked`).
  Use `sail_plan_amend` for work the plan does not cover. When a result says the
  plan is paused, end your turn.
- Sail does not block edits outside the approved files. It flags them in tool
  results and to the user, so amend the plan instead of editing silently.
- If your own configuration also provides `plan_propose`, `plan_ask`,
  `plan_step` or `plan_amend` tools, use the `sail_plan_*` tools instead.

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

## Ship workflow host contract

These rules apply when Sail delivers the ship-it skill or its `ship_progress`, `task_checkpoint_read` and `task_evidence_record` tools are connected. They extend the phases, hard stops and references. Where any of those describes Sail differently, this section and Sail's prompt rules win. The checkpoint, evidence and progress rules apply when those tools accept this thread. When they reject it because Sail does not track this thread as a Ship run, keep only the portable records.

- **References:** Load the upstream optional `sail.md` and `helper-loading.md` references through `skill_reference`. Preserve the pinned bytes and relative paths when materializing helpers. Use one private package root: save the bundled `plugin.json` reference at `<package>/plugin.json`, Python helpers at `<package>/skills/ship-it/scripts/<name>` and policy resources at `<package>/skills/ship-it/references/<name>`. Materialize each entry point's transitive dependencies from `helper-loading.md` before execution. The telemetry helper also needs `plugin.json` even though the upstream dependency inventory omits it. Verify each saved body's SHA-256 against its reference version. Telemetry stays optional and never blocks.
- **Worktree:** In a Sail-managed worktree, stay on its assigned branch. Skip branch creation and the return to the default branch, and leave worktree cleanup to Sail.
- **Gate routing:** Every review and test attempt runs in its own fresh subagent session, including each retry and reproduction rerun. In Sail, use `validation_gate` for every gate pass and wait for its receipt before starting the next pass. The assigned implementation provider and model may be reused; a different model is optional. Use a configured validation pool or role route when present. If a fresh session cannot launch, pause and report the gate and reason. Follow the mandates in `review.md` and `test.md`, or the full ones from `skill_reference`: `code-adversary.md` and `findings-adversary.md` from `adversarial-review`, and `test-adversary.md` from `adversarial-test`. CI triage uses a fresh subagent when available; in Sail, pause if one cannot launch.
- **Native capacity:** Sail's native `agent_spawn` workers and `validation_gate` sessions use separate agent and validation resource queues. Those queues own admission and release; submit ready work and let Sail queue it within configured limits. For native Sail gates, the `validation_gate` request is the capacity request: workers call it directly and wait for their own receipts. Do not require coordinator lease messages or send gate-capacity requests through `thread_message`; review/test profiles forbid that tool, and messages to an active coordinator wait until its turn ends. The coordinator fills eligible issue slots and observes its launch receipts while Sail services the validation queue. A queued gate is temporary saturation, not a missing capability. The global Codex agent limit governs native children inside one Codex session; it does not set Sail's separate session queue limits. Shared-budget lease rules in the portable references apply only when the host actually exposes that shared budget, not to Sail's separate native queues.
- **Gate environment:** In a gate's input manifest, declare `SAIL_ENVIRONMENT_ID` in `environment.variables` instead of `PATH`. Sail sets it, identical, in the agent, its terminal commands and the terminals the agent creates for the worktree. It ignores per-run temp, scratch and build paths and tool directories created later. Terminal panes the user opens do not have it. Put tool versions in `facts`. The identity does not cover a PATH the agent sets itself or the PATH a login shell builds in a Sail terminal. Raw `PATH` can differ between a worker's shell surfaces and invalidates the receipt even when nothing relevant changed.
- **Checkpoint:** Keep the portable checkpoint, claim and evidence records the references require, and mirror them into Sail's task checkpoint. Call `task_checkpoint_read` before resuming and stop on a revision or delivery mismatch, except the merge handoff below. After every phase, blocker, revision, required-gate, question or next-action change, call `task_checkpoint_update` with the sequence and revision from the last read; rebind only after inspecting worktree drift. Replace Sail's initial objective and acceptance criteria with the resolved task contract. Sail's checkpoint has no `cancelled` or `failed` status: mirror a terminal outcome by keeping the last phase before `complete`, with `status: blocked`, the reason as `blocker` and a concrete `nextAction`.
- **Claims:** When Sail's prompt gives a local claim ID, use it as your ownership. Sail keeps the claim in its local store and renews and releases it. Keep the portable checkpoint's GitHub-comment `claim` null; Sail tracks its local claim separately. Do not create, update, renew, take over or release a GitHub claim comment. Without a Sail claim, keep `claim: null` and ask Sail for ownership before repository writes.
- **Risk and Sail gates:** After selecting risk, call `validation_policy` with that level before validation. Sail combines it with the repository's `.sail/worktree.json` defaults and changed-path rules, never lowers an earlier selection, stores the required Sail gates as the checkpoint's `requiredGates`, and returns them. Run exactly the returned review and test gates through fresh `validation_gate` sessions. Record `inline-review` as its own review evidence result, and record Code/Findings passes as the portable `adversarial-review` result and Test Adversary passes as `adversarial-test`; do not set `requiredGates` yourself. Select the policy again after the worktree changes. Record `local-checks` results with `task_evidence_record`. Keep `ci` and `hosted-review` in the portable checkpoint; Sail reads pull request checks itself.
- **Evidence:** Before each quality command, read the execution boundary from `task_checkpoint_read`. Then call `task_evidence_record` with its `expectedRevision`, `expectedMutationGeneration` and `expectedBaseRevision`, the exact acceptance criterion strings the result verifies and a bounded output reference. After any source change, rebind and rerun required evidence; never reuse a stale result.
- **Progress:** Call `ship_progress` with `{ stage, status: "running" }` before implementing, reviewing, testing, opening the pull request, waiting on CI and merging, using stages `implementing`, `reviewing`, `testing`, `pull_request`, `ci` and `merging`. When work cannot continue, report `status: "blocked"` with a concrete reason before explaining the blocker. NEEDS_FIXES, FAIL and CI fix rounds stay `running`. In Sail, a blocked report is how you reach the user: when the convergence budget stops the run, report `status: "blocked"` with the exhausted limit and the last surviving findings as the reason. A verdict reported from this session includes the checkpoint `revision` read before the pass, the exact acceptance criteria the pass verified and a bounded output reference. `validation_gate` sessions report their own verdicts.
- **Merge owner:** Repository instructions such as `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` or release-policy prose that state who merges take precedence over Sail's "You merge" rule in either direction. The structured release policy has no merge-owner field; it says how to merge, not who merges. Never post a GitHub comment in Sail mode, including a bot merge comment. If the repository requires a bot comment, hand the merge to the user. When the repository says nothing about who merges, Sail's prompt decides: with its "You merge" rule the user merges, and without it you merge through the resolved release policy.
- **Merge handoff:** When the user merges, stop at a mergeable pull request. Every merge precondition in `pr-loop.md` holds for the current PR head, the worktree is clean, `git rev-parse HEAD` equals the PR `headRefOid`, and `task_checkpoint_read` reports `reconciliation.revisionMatches` and `evidence.readiness.ready`. Do not post a merge comment or run a merge command. Report `awaiting_merge` through `ship_progress` when its schema lists that value; otherwise Sail marks the open pull request as awaiting merge when your turn ends. Leave the checkpoint at `phase: pr` with the user's merge as `nextAction`, and end the turn without releasing the claim; it expires. If you resume after the user merges, the delivery mismatch from `task_checkpoint_read` and a source issue closed by this pull request are the expected handoff, not stops: continue with completion verification. When you acquired your own `claims.md` claim and it has expired, take it over as a terminal delivery takeover from `claims.md`, then release it with reason `merged`. A claim Sail holds is never taken over or released by the worker.

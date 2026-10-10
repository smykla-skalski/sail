---
name: ship-it
description: Ship a change or coordinate an approved complex plan through risk-selected gates, PR feedback and merge. Accepts a task description, GitHub issue or Jira ticket. Use for end-to-end shipping.
license: MIT
compatibility: Works in Claude Code, Codex, opencode and Copilot CLI. Needs git and authenticated gh. Uses adversarial-review and adversarial-test when installed.
argument-hint: '[--issue] [--risk low|medium|high] <task description | github-issue-url | jira-url>'
allowed-tools: Agent Bash Edit Glob Grep Read Skill ToolSearch Write
user-invocable: true
metadata:
  short-description: Ship a change, issue, or Jira ticket to merge
  upstream: smykla-skalski/sai plugins/ship-it 1.4.36 with Sail mode
---

# Ship It

Take a change to a merged PR, or coordinate independently shippable issues from an approved complex plan.

**Mode:** autonomous. Ask only on material ambiguity. Use blocking waiters until merged or a hard stop; never foreground-poll.

**Other agents:** Read [references/fallbacks.md](references/fallbacks.md) only when an agent feature is missing.

Invocation: `/ship-it [--issue] [--risk low|medium|high] <task|GitHub issue|Jira URL>` (`$ship-it` in Codex). If arguments are absent, use the request.

## Workflow contract

- Run phases in order; a missing preferred tool never skips a gate.
- Read this entry once. Read each selected phase reference once, immediately before that phase, and keep its rules in the checkpoint. Do not reread a reference on phase transitions.
- Resolve routine capabilities from current tools and the phase reference. Read [references/capabilities.md](references/capabilities.md) and [references/capabilities.json](references/capabilities.json) only on a missing/changed capability or fallback; then rerun the machine preflight.
- Phase references name routine routes. Read [references/roles.md](references/roles.md) and [references/roles.json](references/roles.json) only for unresolved aliases or policy overrides. Give each gate its mandate by path or inline exactly once in fresh context.
- After each subagent dispatch, use one blocking wait of at least ten minutes unless the worker returns sooner. Do not list agents or read status between waits; close the worker after its verdict.
- Maintain the checkpoint through the helper. Read [references/checkpoint.md](references/checkpoint.md) only for migration, recovery or validation error. Claims, evidence and telemetry default off; read [references/claims.md](references/claims.md), [references/evidence.md](references/evidence.md) or [references/telemetry.md](references/telemetry.md) only when enabled.
- Routine guidance is this entry, selected phase references, [references/risk-policy.json](references/risk-policy.json), [references/release-policy.json](references/release-policy.json) and [references/convergence-policy.json](references/convergence-policy.json): keep it under 12k input tokens. After compaction, read only the checkpoint and current phase reference.
- Read [references/risk.md](references/risk.md) or [references/release.md](references/release.md) only on override/ambiguity; read [references/convergence.md](references/convergence.md) only after failure, recovery or exhaustive opt-in. Checkpoint gates, release policy and budget before validation.
- Every source change invalidates completion evidence from the previous revision.
- Never bypass hooks, suppress checks, force-push after the first push, or force-merge.
- In Sail mode, missing worker or gate subagents pause the run; never replace them with inline work.

## Sail mode

These rules apply when Sail delivers this skill or its `ship_progress`, `task_checkpoint_read` and `task_evidence_record` tools are connected. They extend the phases, hard stops and references. Where any of those describes Sail differently, this section and Sail's prompt rules win. The checkpoint, evidence and progress rules apply when those tools accept this thread. When they reject it because Sail does not track this thread as a Ship run, keep only the portable records.

- **References:** A bundled Sail prompt omits reference bodies. Load `references/<name>` with `skill_reference` and reference `<name>`, and `scripts/<name>` with reference `scripts/<name>`. A bundled skill has no skill directory: write the script body, the text after the response header and its first blank line, to a private temporary directory outside the repository. Check that its SHA-256 matches the reported reference version, then run that copy. Telemetry stays optional and never blocks.
- **Worktree:** In a Sail-managed worktree, stay on its assigned branch. Skip branch creation and the return to the default branch, and leave worktree cleanup to Sail.
- **Gate routing:** Every review and test attempt runs in its own fresh subagent session, including each retry and reproduction rerun. In Sail, use `validation_gate` for every gate pass and wait for its receipt before starting the next pass. The assigned implementation provider and model may be reused; a different model is optional. Use a configured validation pool or role route when present. If a fresh session cannot launch, pause and report the gate and reason. Follow the mandates in `review.md` and `test.md`, or the full ones from `skill_reference`: `code-adversary.md` and `findings-adversary.md` from `adversarial-review`, and `test-adversary.md` from `adversarial-test`. CI triage uses a fresh subagent when available; in Sail, pause if one cannot launch.
- **Checkpoint:** Keep the portable checkpoint, claim and evidence records the references require, and mirror them into Sail's task checkpoint. Call `task_checkpoint_read` before resuming and stop on a revision or delivery mismatch, except the merge handoff below. After every phase, blocker, revision, required-gate, question or next-action change, call `task_checkpoint_update` with the sequence and revision from the last read; rebind only after inspecting worktree drift. Replace Sail's initial objective and acceptance criteria with the resolved task contract. Sail's checkpoint has no `cancelled` or `failed` status: mirror a terminal outcome by keeping the last phase before `complete`, with `status: blocked`, the reason as `blocker` and a concrete `nextAction`.
- **Claims:** When Sail's prompt says Sail holds a visible claim with an exact claim ID for this task on behalf of this worker, that `sail-claim:v1` comment is your ownership. Do not post a `claims.md` comment, and do not renew, take over or release Sail's claim; Sail does. Record its ID in the portable checkpoint and evidence claim, and read its comment URL and expiry from the matching `sail-claim:v1` issue comment. Without such a prompt, follow `claims.md`. Either way, another holder's active, unexpired `sail-claim:v1` marker on the issue is a conflicting claim: stop. An expired one is audit history.
- **Risk and Sail gates:** After selecting risk, call `validation_policy` with that level before validation. Sail combines it with the repository's `.sail/worktree.json` defaults and changed-path rules, never lowers an earlier selection, stores the required Sail gates as the checkpoint's `requiredGates`, and returns them. Run exactly the returned review and test gates through fresh `validation_gate` sessions. Record `inline-review` as its own review evidence result, and record Code/Findings passes as the portable `adversarial-review` result and Test Adversary passes as `adversarial-test`; do not set `requiredGates` yourself. Select the policy again after the worktree changes. Record `local-checks` results with `task_evidence_record`. Keep `ci` and `hosted-review` in the portable checkpoint; Sail reads pull request checks itself.
- **Evidence:** Before each quality command, read the execution boundary from `task_checkpoint_read`. Then call `task_evidence_record` with its `expectedRevision`, `expectedMutationGeneration` and `expectedBaseRevision`, the exact acceptance criterion strings the result verifies and a bounded output reference. After any source change, rebind and rerun required evidence; never reuse a stale result.
- **Progress:** Call `ship_progress` with `{ stage, status: "running" }` before implementing, reviewing, testing, opening the pull request, waiting on CI and merging, using stages `implementing`, `reviewing`, `testing`, `pull_request`, `ci` and `merging`. When work cannot continue, report `status: "blocked"` with a concrete reason before explaining the blocker. NEEDS_FIXES, FAIL and CI fix rounds stay `running`. In Sail, a blocked report is how you reach the user: when the convergence budget stops the run, report `status: "blocked"` with the exhausted limit and the last surviving findings as the reason. A verdict reported from this session includes the checkpoint `revision` read before the pass, the exact acceptance criteria the pass verified and a bounded output reference. `validation_gate` sessions report their own verdicts.
- **Merge owner:** Repository instructions such as `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` or release-policy prose that state who merges take precedence over Sail's "You merge" rule in either direction. The structured release policy has no merge-owner field; like any documented merge mechanism, such as a bot comment, it says how to merge, not who merges. When the repository says nothing about who merges, Sail's prompt decides: with its "You merge" rule the user merges, and without it you merge through the resolved release policy.
- **Merge handoff:** When the user merges, stop at a mergeable pull request. Every merge precondition in `pr-loop.md` holds for the current PR head, the worktree is clean, `git rev-parse HEAD` equals the PR `headRefOid`, and `task_checkpoint_read` reports `reconciliation.revisionMatches` and `evidence.readiness.ready`. Do not post a merge comment or run a merge command. Report `awaiting_merge` through `ship_progress` when its schema lists that value; otherwise Sail marks the open pull request as awaiting merge when your turn ends. Leave the checkpoint at `phase: pr` with the user's merge as `nextAction`, and end the turn without releasing the claim; it expires. If you resume after the user merges, the delivery mismatch from `task_checkpoint_read` and a source issue closed by this pull request are the expected handoff, not stops: continue with completion verification. When you acquired your own `claims.md` claim and it has expired, take it over as a terminal delivery takeover from `claims.md`, then release it with reason `merged`. A claim Sail holds is never taken over or released by the worker.

## Phase reference index

| Phase             | Read immediately before starting                             |
| :---------------- | :----------------------------------------------------------- |
| 1 — Resolve       | [references/inputs.md](references/inputs.md)                 |
| 2 — Explore       | [references/explore.md](references/explore.md)               |
| 3 — Branch        | [references/branch.md](references/branch.md)                 |
| 4 — Implement     | [references/implementation.md](references/implementation.md) |
| 5 — Publish draft | [references/publish.md](references/publish.md)               |
| 6 — Review        | [references/review.md](references/review.md)                 |
| 7 — Test          | [references/test.md](references/test.md)                     |
| 8–10 — PR loop    | [references/pr-loop.md](references/pr-loop.md)               |
| 11 — Complete     | [references/completion.md](references/completion.md)         |

## Phase 1 — Resolve the task

Resolve the source and acceptance criteria, then create or resume the durable checkpoint before repository changes.

For an approved complex plan or umbrella, read [references/orchestration.md](references/orchestration.md); the parent never implements a child. Ordinary issues use the phases below. In Sail, missing workers or gates pause the run.

## Phase 2 — Explore

Discover repository instructions, affected code and gates.

## Phase 3 — Branch

Use an isolated branch from the current default branch or assigned Sail worktree.

## Phase 4 — Implement

Implement the smallest complete change with behavior tests and signed conventional commits.

## Phase 5 — Publish draft PR

After the first committed revision passes local checks, push it and open a draft PR so CI starts. The draft remains pending review and test gates.

## Phase 6 — Review

Run the selected review gates for the current committed revision.

## Phase 7 — Test

Run each selected broad test gate once, only for the review-clean committed revision.

## Phases 8–10 — Wait, fix, ready, merge

Resolve hosted gates and threads, revalidate changes, mark ready only when review, test and CI pass for one head, then use the documented merge convention.

## Phase 11 — Close, report, clean up

Verify delivery, close only the GitHub issue, report evidence and clean up when safe.

## Hard stops

Stop and name the exact next human action when: a capability preflight fails; the source is invalid or ownership conflicts; a required control cannot pass; a hosted requirement exceeds its deadline; a delivery blocker survives the convergence budget; a selected test is BLOCKED; or the repository cannot answer a required product decision.

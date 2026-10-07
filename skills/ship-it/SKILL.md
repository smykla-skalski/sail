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
  upstream: smykla-skalski/sai plugins/ship-it 1.4.19 with Sail mode
---

# Ship It

Take a change to a merged PR, or coordinate independently shippable issues from an approved complex plan.

**Mode:** autonomous. Ask only when ambiguity cannot be resolved from the repository. Keep polling selected hosted gates until merged or a hard stop.

**Other agents:** Read [references/fallbacks.md](references/fallbacks.md) when not in Claude Code or an agent feature is missing.

Invocation: `/ship-it [--issue] [--risk low|medium|high] <task description | github-issue-url | jira-url>` (`$ship-it` in Codex). Runs only when invoked by name or asked to ship a change. Claude Code appends the arguments; if none are appended, take them from the user's request.

## Workflow contract

- Run phases below in order; do not skip a gate because a harness lacks a preferred tool.
- Before each phase, read [references/capabilities.md](references/capabilities.md) and [references/capabilities.json](references/capabilities.json), select its profile and satisfy the machine-readable preflight before any side effect.
- Read [references/roles.md](references/roles.md) and [references/roles.json](references/roles.json) before dispatch.
- Load each phase reference immediately before that phase, not during initial skill discovery.
- After resolving, maintain [references/checkpoint.md](references/checkpoint.md) before repository changes, GitHub [references/claims.md](references/claims.md) before branch or source changes, and [references/telemetry.md](references/telemetry.md) through completion.
- Read [references/evidence.md](references/evidence.md) when the first task revision is committed. Evidence due at each PR or merge gate must pass for the exact current revision.
- Read [references/risk.md](references/risk.md) after exploration. Select and report the revision's risk, policy source and required gates before validation.
- Read [references/release.md](references/release.md) after exploration. Resolve repository, GitHub and default release policy into the checkpoint before validation.
- Every source change invalidates completion evidence from the previous revision.
- Never bypass hooks, suppress checks, force-push after the first push, or force-merge.
- In Sail mode, follow [Sail mode](#sail-mode). A missing worker, or a gate session that Sail's gate rule requires, pauses the run; never replace it with inline work.

## Sail mode

These rules apply when Sail delivers this skill or its `ship_progress`, `task_checkpoint_read` and `task_evidence_record` tools are connected. They extend the phases, hard stops and references. Where any of those describes Sail differently, this section and Sail's prompt rules win.

- **References:** A bundled Sail prompt omits reference bodies. Load `references/<name>` with `skill_reference` and reference `<name>`, and `scripts/<name>` with reference `scripts/<name>`. A bundled skill has no skill directory: write the script body, the text after the response header and its first blank line, to a private temporary directory outside the repository. Check that its SHA-256 matches the reported reference version, then run that copy. Telemetry stays optional and never blocks.
- **Worktree:** In a Sail-managed worktree, stay on its assigned branch. Skip branch creation and the return to the default branch, and leave worktree cleanup to Sail.
- **Gate routing:** Sail's prompt gate rule selects how review and test gates run. With a configured validation pool or strict different-model routing, run the Code Adversary, Findings Adversary and Test Adversary in separate fresh `validation_gate` sessions, in order. Pass every implementation model, wait for each receipt before the next pass, report each pass's actual provider and model, never substitute a model outside the pool, and pause when no allowed session can launch. Under Sail's default gate rule, run the three passes in this Ship It session with the implementation agent and model and do not call `validation_gate`. Follow the mandates in `review.md` and `test.md`, or the full ones from `skill_reference`: `code-adversary.md` and `findings-adversary.md` from `adversarial-review`, and `test-adversary.md` from `adversarial-test`. Reference lines that say Sail never runs a gate inline apply only when Sail's gate rule requires a gate session. Record those routes with `independence: degraded`, every failed strict rule as a reason, and Sail's default gate rule as the authorization. Sail workers supply the `subagent.review` and `subagent.test` capabilities that `capabilities.json` requires when `sail` is true; Sail's gate rule, not that preflight, picks the route. CI triage uses a fresh native subagent when your agent has one. Otherwise, under Sail's default gate rule, run it in this session and record its route with `mechanism: inline` and `independence: not-applicable`.
- **Checkpoint:** Keep the portable checkpoint, claim and evidence records the references require, and mirror them into Sail's task checkpoint. Call `task_checkpoint_read` before resuming and stop on a revision or delivery mismatch, except the merge handoff below. After every phase, blocker, revision, required-gate, question or next-action change, call `task_checkpoint_update` with the sequence and revision from the last read; rebind only after inspecting worktree drift. Replace Sail's initial objective and acceptance criteria with the resolved task contract. Sail's checkpoint has no `cancelled` or `failed` status: mirror a terminal outcome by keeping the last phase before `complete`, with `status: blocked`, the reason as `blocker` and a concrete `nextAction`.
- **Sail gates:** Sail's `requiredGates` lists only gates that report a `ship_progress` verdict: `code-adversary` and `findings-adversary` when `adversarial-review` is selected, and `test-adversary` when `adversarial-test` is selected. Record `local-checks` results with `task_evidence_record`. Keep `ci` and `hosted-review` in the portable checkpoint; Sail reads pull request checks itself.
- **Evidence:** Before each quality command, read Sail's checkpoint revision. Then call `task_evidence_record` with that `expectedRevision`, the exact acceptance criterion strings the result verifies and a bounded output reference. After any source change, rebind and rerun required evidence; never reuse a stale result.
- **Progress:** Call `ship_progress` with `{ stage, status: "running" }` before implementing, reviewing, testing, opening the pull request, waiting on CI and merging, using stages `implementing`, `reviewing`, `testing`, `pull_request`, `ci` and `merging`. When work cannot continue, report `status: "blocked"` with a concrete reason before explaining the blocker. NEEDS_FIXES, FAIL and CI fix rounds stay `running`. A verdict reported from this session includes the checkpoint `revision` read before the pass, the exact acceptance criteria the pass verified and a bounded output reference. `validation_gate` sessions report their own verdicts.
- **Merge owner:** Repository instructions such as `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` or release-policy prose that state who merges take precedence over Sail's "You merge" rule in either direction. The structured release policy has no merge-owner field; like any documented merge mechanism, such as a bot comment, it says how to merge, not who merges. When the repository says nothing about who merges, Sail's prompt decides: with its "You merge" rule the user merges, and without it you merge through the resolved release policy.
- **Merge handoff:** When the user merges, stop at a mergeable pull request: every merge precondition in `pr-loop.md` holds for the current PR head, and `task_checkpoint_read` reports `evidence.readiness.ready` for a revision equal to that head. Do not post a merge comment or run a merge command. Report `awaiting_merge` through `ship_progress`, leave the checkpoint at `phase: pr` with the user's merge as `nextAction`, and end the turn without releasing the claim; it expires. If you resume after the user merges, the delivery mismatch from `task_checkpoint_read` and a source issue closed by this pull request are the expected handoff, not stops: continue with completion verification. When your claim has expired, take it over as a terminal delivery takeover from `claims.md`, then release it with reason `merged`.

## Phase reference index

| Phase          | Read immediately before starting                             |
| :------------- | :----------------------------------------------------------- |
| 1 — Resolve    | [references/inputs.md](references/inputs.md)                 |
| 2 — Explore    | [references/explore.md](references/explore.md)               |
| 3 — Branch     | [references/branch.md](references/branch.md)                 |
| 4 — Implement  | [references/implementation.md](references/implementation.md) |
| 5 — Review     | [references/review.md](references/review.md)                 |
| 6 — Test       | [references/test.md](references/test.md)                     |
| 7–10 — PR loop | [references/pr-loop.md](references/pr-loop.md)               |
| 11 — Complete  | [references/completion.md](references/completion.md)         |

## Phase 1 — Resolve the task

Classify the input, resolve its source and acceptance criteria, and create or resume its durable checkpoint outside the repository. No branch, edit or commit until resolution and checkpoint reconciliation succeed.

If the input is an approved complex plan or an umbrella issue with subissues, read [references/orchestration.md](references/orchestration.md) and follow its parent coordinator workflow. The parent never implements a child issue. An ordinary implementation issue, including a worker's assigned issue, follows the single-change phases below. In Sail mode, an absent worker, or an absent gate session that Sail's gate rule requires, pauses the run; never fall back to inline gates.

## Phase 2 — Explore

Discover repository instructions, affected code and required quality gates. Resolve and checkpoint release policy before editing.

## Phase 3 — Branch

Start from the current default branch in an isolated conventional branch or assigned Sail worktree.

## Phase 4 — Implement

Implement the smallest complete change, add behavior tests, run relevant gates and create signed conventional commits.

## Phase 5 — Review

Run the selected review gates for the current committed revision.

## Phase 6 — Test

Run the selected test gates for the review-clean committed revision.

## Phases 7–10 — PR, wait, fix, merge

Push and open the PR, wait for selected hosted gates, resolve every required thread, revalidate changed revisions, then merge through the repository's documented convention. When Sail's merge-owner rule applies, stop at a mergeable pull request instead.

## Phase 11 — Close, report, clean up

Verify delivery, close only the GitHub issue, report evidence and clean up when safe.

## Hard stops

Stop and name the exact next human action when: a phase capability preflight fails; input is empty, unrecognized or unreachable; the GitHub issue is closed or its claim conflicts; the Jira ticket is finished; branch protection needs approvals or admin action; a hosted requirement remains unsatisfied after ~30 min; a required review thread loops more than 3 times; a test requires disabling a check; a selected test gate returns BLOCKED; the review/test round cap is hit and the user can be asked; or the task needs a product/design decision the repository cannot answer.

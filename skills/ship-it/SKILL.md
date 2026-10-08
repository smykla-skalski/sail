---
name: ship-it
description: End-to-end ship a change — implement, run bounded adversarial review and testing, open a PR, satisfy required CI and human approvals, then merge. Accepts a plain task description (no issue is created unless --issue is passed), a GitHub issue URL (closed on merge), or a Jira ticket URL (read-only; the key goes in the PR). Use when asked to implement and ship a change end to end.
license: MIT
compatibility: Works in Claude Code, Codex, opencode and Copilot CLI. Needs git and an authenticated gh CLI with push and merge rights on the target repository. Uses the adversarial-review and adversarial-test skills when installed. Jira tickets are read through Atlassian MCP tools, acli, or the jira CLI when one is available.
argument-hint: '[--issue] <task description | github-issue-url | jira-url>'
allowed-tools: Agent Bash Edit Glob Grep Read Skill ToolSearch Write
user-invocable: true
metadata:
  short-description: Ship a change, issue, or Jira ticket to merge
---

# Ship It

## Sail execution rule

For an issue opened in a Sail-managed worktree, use that worktree and branch. Skip branch creation and cleanup. When the prompt enables Sail cross-validation with a selected model pool, run the Code Adversary, Findings Adversary, and Test Adversary in three separate fresh `validation_gate` sessions, in order. Otherwise run the gates in this Ship It session with the implementation agent and model; do not call `validation_gate` merely because no pool is configured.

Take one change (task description, GitHub issue, or Jira ticket) to a merged PR, closing the GitHub issue if any.

**Role:** senior engineer owning the full lifecycle of one change.

**Mode:** autonomous. Ask only when the task is ambiguous and the repository cannot resolve it. Never end the turn while required CI or a required human approval is pending: keep polling (background waits are fine) until merged or a hard stop. Never request or wait for Copilot review.

**Other agents:** Codex, opencode and Copilot CLI invoke skills and subagents differently, run one subagent at a time, and may need sandbox escalation. Read [references/fallbacks.md](references/fallbacks.md) at the start when not in Claude Code, or whenever a skill, named agent, or subagent tool is missing.

Invocation: `/ship-it [--issue] <task description | github-issue-url | jira-url>` (`$ship-it` in Codex). Runs only when invoked by name or asked to ship a change. Claude Code appends the arguments; if none are appended, take them from the user's request.

## Phase 1 — Resolve the task

Read [references/inputs.md](references/inputs.md) before Phase 1. Classify the input, create the issue for `--issue`, read the GitHub issue or Jira ticket, and write the task context file outside the repository. No branch, edit or commit until this phase succeeds.

## Phase 2 — Explore

Read root `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` when present, including the merge convention. Identify the stack, the lint, format, type-check, test and build commands, the affected code and its tests.

## Phase 3 — Branch

Fetch origin, resolve the default branch with `gh repo view`, fast-forward it, branch: `<type>/issue-<n>-<slug>` (GitHub issue), `<type>/<jira-key-lowercase>-<slug>` (Jira), `<type>/<slug>` (description). `<type>` is a conventional type; `<slug>` is kebab-case, ~50 chars. Work in another repository happens in a new worktree of it, never in its main checkout.

## Phase 4 — Implement

Small focused commits following repository patterns; add behavior-focused tests. Run focused formatting, linting and tests while implementing and fixing. Run the repository's full quality gate once on the final delivery tip, repeating it only when a later source change makes that evidence stale. Never use suppressions or `--no-verify`; fix the root cause.

In a Sail-managed task, bind the checkpoint to the current revision before recording results. Read its revision before each quality command, then pass that value as `expectedRevision` to `task_evidence_record`, map the exact acceptance criteria it verifies, and reference bounded terminal or log output. After any source change, rebind and rerun required evidence; never reuse a stale result.

Signed conventional commits, scope required, title ≤50 chars, no AI attribution or PR refs. Footer: `Refs #<n>` (`Refs owner/repo#<n>` cross-repo) for a GitHub issue, `Refs <KEY-123>` for Jira, none for a description.

## Phase 5 — Adversarial review

Read [references/convergence.md](references/convergence.md) before Phase 5 and apply its single budget through review, test, CI and merge. The bounded default applies unless the user explicitly requested exhaustive review for this change.

When the prompt enables Sail cross-validation, record every model that implemented this issue and use Sail's `validation_gate` tool for each pass, passing the complete model set; wait for its receipt before the next pass. The tool selects only a configured, available agent/model pair and verifies the actual model. Prefer a model outside the complete implementation set. Under strict different-model routing, pause if none qualifies. Report the actual provider and model for each pass. Never substitute outside the selected pool. Without that policy, run the gates in this session with the implementation agent and model.

Run `adversarial-review:adversarial-review` with `--base origin/<default> --context <task-context-file>`. Reply starts `Review Verdict: CLEAN` or `NEEDS_FIXES`. On NEEDS_FIXES fix every surviving `blocking:` and `issue:` in one fix pass. Re-review only for a security defect, data-loss risk, destructive concurrency behavior or unresolved acceptance-criterion failure. Later non-blocking findings become follow-up issues. Unsettled `question:` findings go in the PR body. Proceed to Phase 6 after CLEAN, or after focused evidence confirms the single fix pass resolved all surviving routine findings.

In Sail, read the checkpoint revision before an inline adversary pass. Every `ship_progress` gate verdict includes that `revision`, the exact acceptance criterion strings verified by the pass, and a bounded output reference. Cross-validation gates use Sail's launch revision.

## Phase 6 — Adversarial test

From the Phase 5 tip run `adversarial-test:adversarial-test` with the same args. Reply starts `Test Verdict: PASS`, `FAIL` or `BLOCKED`. On FAIL each surviving reproduction is an acceptance-criterion failure: fix it within the available fix pass, add a regression test and use the one permitted re-review cycle. BLOCKED is a hard stop. PR only after PASS.

**Convergence cap (Phases 5–10):** stop after two review cycles or 90 minutes from the start of Phase 5 unless the user explicitly requested exhaustive review. Required checks and approvals remain mandatory at the cap; report the concrete blocker instead of bypassing or recursively reviewing.

## Phases 7–10 — PR, wait, fix, merge

Read [references/pr-loop.md](references/pr-loop.md) before Phase 7. In short:

7. Squash repeated version-bump commits, push and open the PR.
8. Poll required CI and human approvals every 5–10 min; fix required CI failures within the convergence budget.
9. Fix or answer required review threads, then resolve them. Never wait for Copilot.
10. Merge when required CI, approvals and threads are satisfied via the repo's documented convention (e.g. a `squash` comment). Never force-push or rebase after the first push; use a signed `git merge origin/<default>`.

## Phase 11 — Close, report, clean up

GitHub issue: confirm `Closes` closed it, else close it with a completion comment. Jira: leave it untouched; say it is ready to transition. Report source (`created` if Phase 1 made the issue; Jira key; or description), PR link, commits, CI and required-approval status, merged/closed status, follow-up issues, and any explicitly authorized exhaustive-review overrun. Then switch to the default branch, fast-forward, and delete the local branch (or worktree) when safe.

## Hard stops

Stop and name the exact next human action when: input is empty, unrecognized or unreachable; the GitHub issue is closed or actively owned; the Jira ticket is finished; branch protection needs approvals or admin action; a required review thread loops more than 3 times; a test requires disabling a check; `adversarial-test` returns BLOCKED; the convergence cap is reached with a required gate or severity exception unresolved; or the task needs a product/design decision the repository cannot answer. Copilot's absence or pending state is never a hard stop.

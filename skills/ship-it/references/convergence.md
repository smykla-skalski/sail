# ship-it convergence contract

Use this contract across review, test, CI and merge. It bounds discretionary iteration without weakening any repository requirement.

## Default budget

- Run one Code Adversary pass and one independent Findings challenge for a routine change.
- Apply at most one fix pass for surviving findings. Run focused tests while implementing and fixing, then run the repository's full quality gate once on the final delivery tip. A later source change makes that result stale and requires one replacement full-gate result for the new delivery tip.
- Do not start another review or test cycle for a routine source change or a non-blocking finding.
- Create follow-up issues for later non-blocking findings instead of extending the active delivery loop.
- Stop the active review, test and CI-fix loop after two review cycles or 90 minutes from the start of review, whichever comes first.

A review cycle is one complete attempt to establish the required review and test verdicts for a revision, including fixes caused by that attempt. The initial Code Adversary and Findings challenge belong to the first cycle. A permitted re-review belongs to the second and final cycle.

## Re-review exceptions

Start the second review cycle only when the first cycle or a later required gate leaves one of these unresolved:

- a security defect;
- a data-loss risk;
- destructive concurrency behavior;
- an acceptance-criterion failure.

If an exception remains unresolved when the cycle or time cap is reached, stop and report the concrete blocker. Never relabel it as non-blocking or defer it merely to finish the pull request.

## Exhaustive review

Exhaustive review is opt-in. Use it only when the user explicitly requests exhaustive review for the current change. Record that choice before exceeding the default budget and report the extra cycles in the final result.

Exhaustive review changes only the discretionary cycle and time limits. It never waives repository-required checks, permissions, commit signatures, required human approvals, acceptance criteria or hard safety stops.

## Hosted gates and merge

- Required CI must pass on the delivered revision. Diagnose and fix required failures within the same budget; at the cap, block with the failed check and required next action.
- Never request or wait for Copilot review. Process an existing actionable Copilot comment like any other feedback, but its absence or pending state is not a gate.
- Preserve repository-required human review and other hosted approvals. A required pending approval is a blocker, not permission to extend adversarial review.
- Once the current revision satisfies acceptance criteria, the full quality gate, required CI and required approvals, proceed to merge. Measure completion by the merged pull request and closed issue, not by the number of review iterations.

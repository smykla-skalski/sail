# ship-it PR loop: open, wait, fix, merge

From a reviewed and tested branch to a merged PR. Apply [convergence.md](convergence.md) throughout this loop. Never end the turn while required CI or a required human approval is pending: keep polling (background waits are fine) until the PR is merged or a hard stop is reached. Never request or wait for Copilot review.

## Before the first push

If a version-bump hook bumped the version on several local commits, squash the local commits so the branch carries a single bump (`git reset --soft "$(git merge-base HEAD origin/<default>)"` then one signed commit, with the hooks enabled). This is the last time history may be rewritten.

## History rules after the first push

- Never force-push and never rebase.
- When the default branch moves or the PR conflicts, `git fetch origin` and `git merge origin/<default>` with a signed merge commit (`git merge -S`). In conflicts keep both sides' entries (changelogs, lists, version tables), then rerun the quality gates.

## Open the PR

Push the branch and create a PR against the default branch. Title: the conventional lead-commit title. Body: `## Motivation`, `## Implementation information`, a changelog line (`> Changelog: type(scope): desc` or `> Changelog: skip`), any unsettled review `question:` findings, plus the source link:

| Source           | PR title or body must contain                                                                                                        |
| :--------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| GitHub issue     | `Closes #<number>` (`Closes owner/repo#<number>` when the issue lives in another repository)                                         |
| Jira ticket      | The Jira key, as a link to the ticket, in the body (and in the title when the repository's convention puts it there). Never `Closes` |
| Task description | No issue reference                                                                                                                   |

Follow the repository's own PR template or conventions when it documents them. Capture the PR number.

## Wait for required hosted gates

Poll every 5–10 minutes; do not busy-loop. On each poll inspect:

- `gh pr checks <n>`.
- Required human reviews and outstanding review requests.
- Unresolved, non-outdated review threads, via GraphQL `repository.pullRequest.reviewThreads` (`isResolved`, `isOutdated`, comments).

If required CI fails, read the failed run logs (`gh run view <id> --log-failed`), fix, push, and keep waiting within the convergence budget. At the cap, report the failed check and required next action. Do not restart adversarial review for an infrastructure failure or a routine CI fix.

Never request or wait for Copilot. If Copilot already left an actionable comment, handle it under the same rules as other feedback, but its absence, pending state or lack of re-review never blocks delivery.

## Address required feedback

For every unresolved thread that repository policy requires:

- Valid, actionable: fix it, commit (signed, conventional), push, reply with what changed, resolve the thread.
- Questionable: use the codebase to decide; ask only when necessary.
- Invalid: reply with a concise rationale and resolve the thread.

Reply and resolve with REST or `gh`; when REST is rate-limited, use GraphQL:

```bash
gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}' -f id=<thread-id> -f body='<reply>'
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>
```

Then return to waiting. Stop for a human decision if the same required thread loops more than three times. Convert later non-blocking findings into follow-up issues instead of extending the delivery loop.

## Merge

Merge only when all of these hold:

- Every repository-required CI check succeeded.
- Every repository-required human approval is present.
- Every required review comment is fixed or answered, and its thread is resolved.
- The convergence contract is satisfied; do not add discretionary review cycles before merging.

How to merge, in order:

1. The repository's documented convention (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`). If it merges through a bot comment, post exactly that comment instead of merging yourself. Example: smykla-skalski repositories merge when a PR comment with the exact body `squash` is posted (`gh pr comment <n> --body squash`); the smyklot bot then merges. If the bot bounces the merge because the default branch moved, merge `origin/<default>` (signed), push, wait for CI again, and post the comment again.
2. Otherwise `gh pr merge <n> --squash --delete-branch`.

Never force-merge or use admin overrides. If branch protection requires extra approvals or admin action, report the state and stop. Confirm the PR shows as merged before reporting. If the remote branch still exists after the merge, delete it with `git push origin --delete <branch>`.

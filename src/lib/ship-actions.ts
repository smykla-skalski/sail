import type { ShipIssue, ShipRun } from './issue-shipping.ts';
import { shipRunArchived } from './ship-archive.ts';
import {
  ciStatus,
  shipClosedBeforeLaunch,
  shipClosedWithoutMerge,
  shipEvidenceReadiness,
  shipPullRequestReady,
} from './ship-progress.ts';

export type ShipActionId = 'merge' | 'retry' | 'reopen' | 'stop' | 'archive' | 'unarchive';

export type ShipActionState = { enabled: boolean; reason: string | null };

const available: ShipActionState = { enabled: true, reason: null };
const unavailable = (reason: string): ShipActionState => ({ enabled: false, reason });
export const shipMergeRetryDelay = 10 * 60 * 1000;

export function shipMergeRetryReason(issue: ShipIssue, now = Date.now()): string | null {
  const request = issue.mergeRequested;
  if (!request) return null;
  if (issue.pullRequestHead && request.head !== issue.pullRequestHead)
    return 'The pull request head changed since the last merge request.';
  if (now - request.at >= shipMergeRetryDelay)
    return 'The last merge request is more than 10 minutes old.';
  return null;
}

/** The first thing keeping a pull request from merging, in the order a user can fix it. */
export function shipMergeBlocker(issue: ShipIssue, now = Date.now()): string | null {
  if (issue.state === 'merged') return 'Already merged.';
  if (!issue.pullRequest) return 'No pull request yet.';
  if (issue.pullRequestState !== 'OPEN') return 'The pull request is not open.';
  if (issue.mergeRequested && !shipMergeRetryReason(issue, now))
    return `Merge already requested with “${issue.mergeRequested.comment}”. Waiting for the repository's bot to merge it.`;
  const evidence = shipEvidenceReadiness(issue);
  if (!evidence.ready) return evidence.reason ?? 'Merge evidence is not ready.';
  if (!issue.pullRequestHead || issue.pullRequestHead !== issue.checkpoint?.revision)
    return 'The pull request head differs from the checkpoint revision. Refresh and review it.';
  if (issue.pullRequestMergeable !== true)
    return 'GitHub reports the pull request is not mergeable.';
  const ci = ciStatus(issue.checks);
  if (ci !== 'Passed' && ci !== 'No checks') return `CI is ${ci.toLowerCase()}.`;
  return shipPullRequestReady(issue) ? null : 'The pull request is not ready to merge.';
}

export function shipMergeAction(issue: ShipIssue, now = Date.now()): ShipActionState {
  const blocker = shipMergeBlocker(issue, now);
  return blocker ? unavailable(blocker) : available;
}

/** Retry restarts a failed worker from its checkpoint; a closed pull request needs a new one instead. */
export function shipRetryAction(issue: ShipIssue): ShipActionState {
  if (issue.state !== 'failed') return unavailable('Only a failed issue can be retried.');
  if (shipClosedBeforeLaunch(issue)) return unavailable('The issue was closed before launch.');
  if (shipClosedWithoutMerge(issue))
    return unavailable('The pull request was closed without merging.');
  if (issue.claim?.status === 'active' && issue.claimFencePending)
    return unavailable('Waiting for the shipping claim to settle.');
  return available;
}

/** Reopen restores a pull request closed without merging, then resumes its worker from the checkpoint. */
export function shipReopenAction(issue: ShipIssue): ShipActionState {
  if (!shipClosedWithoutMerge(issue))
    return unavailable('Only a pull request closed without merging can be reopened.');
  if (!issue.pullRequest) return unavailable('No pull request to reopen.');
  if (issue.state !== 'failed') return unavailable('Waiting for the worker to stop.');
  if (issue.claim?.status === 'active' && issue.claimFencePending)
    return unavailable('Waiting for the shipping claim to settle.');
  return available;
}

const liveStates = new Set<string>(['pending', 'starting', 'working', 'awaiting_merge']);

export function shipStopAction(run: ShipRun): ShipActionState {
  if (shipRunArchived(run)) return unavailable('The run is archived.');
  return run.issues.some((issue) => liveStates.has(issue.state))
    ? available
    : unavailable('Nothing is running.');
}

export function shipArchiveAction(run: ShipRun): ShipActionState {
  if (shipRunArchived(run)) return unavailable('Already archived.');
  if (run.issues.some((issue) => liveStates.has(issue.state)))
    return unavailable('Stop the run before archiving it.');
  if (run.issues.some((issue) => issue.claim?.status === 'active'))
    return unavailable('A shipping claim is still being released.');
  return available;
}

export type ShipConfirmation = {
  title: string;
  message: string;
  confirmLabel: string;
  destructive: boolean;
};

export function shipIssueTarget(issue: ShipIssue): string {
  return issue.title === `Issue #${issue.number}`
    ? `#${issue.number}`
    : `#${issue.number} ${issue.title}`;
}

export function shipRunTarget(run: ShipRun): string {
  return run.umbrella?.title ?? run.issues[0]?.title ?? run.remote;
}

export function shipMergeConfirmation(issue: ShipIssue, remote: string): ShipConfirmation {
  const retryReason = shipMergeRetryReason(issue);
  if (issue.mergeRequested && retryReason)
    return {
      title: `Request merge again for ${shipIssueTarget(issue)}?`,
      message: `${retryReason} Sail will request the merge again for ${shipIssueTarget(issue)} in ${remote} using the repository's current release policy. Sail does not post GitHub comments. Confirm only if the previous request did not merge it.`,
      confirmLabel: 'Request again',
      destructive: false,
    };
  return {
    title: `Merge ${shipIssueTarget(issue)}?`,
    message: `Sail merges the pull request for ${shipIssueTarget(issue)} in ${remote} through GitHub, only while its head still matches the checkpoint revision. Sail does not post bot comments; repositories that require one must be merged outside Sail. A merge cannot be undone from Sail.`,
    confirmLabel: 'Merge',
    destructive: false,
  };
}

export function shipRetryConfirmation(issue: ShipIssue): ShipConfirmation {
  return {
    title: `Retry ${shipIssueTarget(issue)}?`,
    message: `Sail stops any leftover worker for ${shipIssueTarget(issue)}, takes over its shipping claim and starts a fresh worker from the saved checkpoint in the same worktree.`,
    confirmLabel: 'Retry',
    destructive: false,
  };
}

export function shipReopenConfirmation(issue: ShipIssue, remote: string): ShipConfirmation {
  const number = issue.pullRequest?.match(/\/pull\/(\d+)/)?.[1];
  const pullRequest = number ? `pull request #${number}` : 'the pull request';
  return {
    title: `Reopen ${pullRequest} for ${shipIssueTarget(issue)}?`,
    message: `Sail reopens ${pullRequest} in ${remote} and starts a fresh worker from the saved checkpoint to finish ${shipIssueTarget(issue)}. Nothing merges until you confirm Merge.`,
    confirmLabel: 'Reopen',
    destructive: false,
  };
}

export function shipReplacementConfirmation(issue: ShipIssue, remote: string): ShipConfirmation {
  const number = issue.pullRequest?.match(/\/pull\/(\d+)/)?.[1];
  const closed = number ? `pull request #${number}` : 'the closed pull request';
  return {
    title: `Start a replacement for ${closed}?`,
    message: `GitHub refused to reopen ${closed}. Sail keeps it closed and starts a replacement pull request for ${shipIssueTarget(issue)} in ${remote} on a new branch from the saved checkpoint. The replacement does not merge until you confirm Merge.`,
    confirmLabel: 'Start replacement',
    destructive: false,
  };
}

export function shipCheckpointCommit(issue: ShipIssue): string | null {
  const revision = issue.checkpoint?.revision;
  const commit =
    issue.checkpoint?.commit ??
    (revision && issue.evidenceRevision === revision ? issue.evidenceCommit : null);
  return commit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit) ? commit : null;
}

export function shipReopenHeadWarning(
  head: string,
  checkpointCommit: string | null | undefined,
): string {
  if (!checkpointCommit)
    return ` Warning: the saved checkpoint has no Git commit to compare with reopened head ${head.slice(0, 8)}. Review the pull request before continuing.`;
  if (head.toLowerCase() === checkpointCommit.toLowerCase()) return '';
  return ` Warning: reopened head ${head.slice(0, 8)} differs from checkpoint commit ${checkpointCommit.slice(0, 8)}. Review the changed commits before continuing.`;
}

export function shipStopConfirmation(run: ShipRun): ShipConfirmation {
  const live = run.issues.filter((issue) => liveStates.has(issue.state)).length;
  return {
    title: `Stop ${shipRunTarget(run)}?`,
    message: `Sail stops ${live} unfinished ${live === 1 ? 'issue' : 'issues'} in this run and releases their shipping claims as cancelled. Branches, worktrees, pull requests and checkpoints stay. Retry resumes an issue later.`,
    confirmLabel: 'Stop run',
    destructive: true,
  };
}

export function shipArchiveConfirmation(run: ShipRun): ShipConfirmation {
  return {
    title: `Archive ${shipRunTarget(run)}?`,
    message: `Sail hides this run from Ship and the queue. Checkpoints, evidence, branches and worktrees stay, and Unarchive brings the run back.`,
    confirmLabel: 'Archive',
    destructive: false,
  };
}

export const stoppedMessage = 'Stopped by you.';

/** Workers and gates a queue shows against the run limits. */
export type ShipPoolUsage = {
  workers: number;
  limit: number;
  gates: number;
  runs: number;
};

export function shipPoolUsage(runs: ShipRun[]): ShipPoolUsage {
  const live = runs.filter((run) => !shipRunArchived(run));
  const usage: ShipPoolUsage = { workers: 0, limit: 0, gates: 0, runs: 0 };
  for (const run of live) {
    const workers = run.issues.filter(
      (issue) => issue.state === 'starting' || issue.state === 'working',
    ).length;
    if (workers === 0 && !run.issues.some((issue) => issue.state === 'pending')) continue;
    usage.runs += 1;
    usage.workers += workers;
    usage.limit += run.limit;
    usage.gates += run.issues.reduce(
      (total, issue) =>
        total +
        (issue.gates ?? []).filter((gate) => ['queued', 'starting', 'working'].includes(gate.state))
          .length,
      0,
    );
  }
  return usage;
}

export const shipPoolHint =
  'Each run allows 1 to 8 workers. A ship-it coordinator starts at most 3 workers and keeps a slot free for review and test gates.';

export function shipPoolLabel(usage: ShipPoolUsage): string {
  if (usage.runs === 0) return 'No workers running';
  const gates = usage.gates === 1 ? '1 gate' : `${usage.gates} gates`;
  return `${usage.workers} of ${usage.limit} workers · ${gates} running`;
}

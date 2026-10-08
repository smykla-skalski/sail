import type { ShipIssue, ShipRun } from './issue-shipping.ts';
import { shipRunArchived } from './ship-archive.ts';
import {
  ciStatus,
  shipClosedBeforeLaunch,
  shipClosedWithoutMerge,
  shipEvidenceReadiness,
  shipPullRequestReady,
} from './ship-progress.ts';

export type ShipActionId = 'merge' | 'retry' | 'stop' | 'archive' | 'unarchive';

export type ShipActionState = { enabled: boolean; reason: string | null };

const available: ShipActionState = { enabled: true, reason: null };
const unavailable = (reason: string): ShipActionState => ({ enabled: false, reason });

/** The first thing keeping a pull request from merging, in the order a user can fix it. */
export function shipMergeBlocker(issue: ShipIssue): string | null {
  if (issue.state === 'merged') return 'Already merged.';
  if (!issue.pullRequest) return 'No pull request yet.';
  if (issue.pullRequestState !== 'OPEN') return 'The pull request is not open.';
  if (issue.mergeRequested)
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

export function shipMergeAction(issue: ShipIssue): ShipActionState {
  const blocker = shipMergeBlocker(issue);
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
  return {
    title: `Merge ${shipIssueTarget(issue)}?`,
    message: `Sail merges the pull request for ${shipIssueTarget(issue)} in ${remote} the way the repository's release policy says, only while its head still matches the checkpoint revision. A merge cannot be undone from Sail.`,
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

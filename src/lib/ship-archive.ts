import type { ShipIssue, ShipRun } from './issue-shipping.ts';
import { shipClosedBeforeLaunch, shipClosedWithoutMerge } from './ship-progress.ts';

export type ShipArchiveDelay = 'off' | 'immediately' | '1d' | '7d';

export const shipArchiveDelays: { value: ShipArchiveDelay; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'immediately', label: 'Immediately' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
];

export const defaultShipArchiveDelay: ShipArchiveDelay = '1d';

const dayMilliseconds = 24 * 60 * 60 * 1000;
const delayMilliseconds: Record<Exclude<ShipArchiveDelay, 'off'>, number> = {
  immediately: 0,
  '1d': dayMilliseconds,
  '7d': 7 * dayMilliseconds,
};

export function parseShipArchiveDelay(value: string | null | undefined): ShipArchiveDelay {
  return shipArchiveDelays.find((item) => item.value === value)?.value ?? defaultShipArchiveDelay;
}

export function shipRunArchived(run: ShipRun): boolean {
  return run.archivedAt !== undefined;
}

/** An issue is finished when it merged or was closed, with or without a pull request. */
export function shipIssueFinished(issue: ShipIssue): boolean {
  return (
    issue.state === 'merged' ||
    issue.issueState === 'CLOSED' ||
    shipClosedBeforeLaunch(issue) ||
    shipClosedWithoutMerge(issue)
  );
}

function claimReleased(issue: ShipIssue): boolean {
  return !issue.claim || issue.claim.status === 'released';
}

/** A missing checkpoint holds nothing to preserve; an active or blocked one is still in use. */
function checkpointComplete(issue: ShipIssue): boolean {
  const status = issue.checkpoint?.status;
  return (
    status === undefined || status === 'completed' || status === 'cancelled' || status === 'failed'
  );
}

function issueFinishedAt(issue: ShipIssue): number {
  return Math.max(
    0,
    ...(issue.events ?? []).map((event) => event.at),
    issue.checkpoint?.updatedAt ?? 0,
    issue.claim?.releasedAt ? Date.parse(issue.claim.releasedAt) || 0 : 0,
  );
}

/** When the last issue of the run finished; runs without any record fall back to approval time. */
export function shipRunFinishedAt(run: ShipRun): number {
  return Math.max(run.approvedAt, ...run.issues.map(issueFinishedAt));
}

/**
 * Archiving only hides a run. It keeps the checkpoint, evidence, worktrees and
 * branches, so a repository's branch_cleanup policy is untouched.
 */
export function shipRunArchivable(run: ShipRun): boolean {
  return (
    run.issues.length > 0 &&
    run.issues.every(
      (issue) => shipIssueFinished(issue) && claimReleased(issue) && checkpointComplete(issue),
    )
  );
}

export function shipRunDueForArchive(run: ShipRun, delay: ShipArchiveDelay, now: number): boolean {
  if (delay === 'off' || shipRunArchived(run) || !shipRunArchivable(run)) return false;
  if (run.unarchivedAt !== undefined) return false;
  return now - shipRunFinishedAt(run) >= delayMilliseconds[delay];
}

/** Returns the same array when nothing is due, so callers can skip persisting. */
export function autoArchiveShipRuns(
  runs: ShipRun[],
  delay: ShipArchiveDelay,
  now: number,
): { runs: ShipRun[]; archived: number } {
  let archived = 0;
  const next = runs.map((run) => {
    if (!shipRunDueForArchive(run, delay, now)) return run;
    archived += 1;
    return { ...run, archivedAt: now, archivedBy: 'auto' as const };
  });
  return { runs: archived ? next : runs, archived };
}

export function archiveShipRun(run: ShipRun, now: number): ShipRun {
  return { ...run, archivedAt: now, archivedBy: 'user' };
}

/** A run the user brought back stays out of auto-archive; archiving it again is their call. */
export function unarchiveShipRun(run: ShipRun, now: number): ShipRun {
  const restored = { ...run, unarchivedAt: now };
  delete restored.archivedAt;
  delete restored.archivedBy;
  return restored;
}

export const shipArchiveMigrationKey = 'sai-ship-archive-migrated-v1';

/** One-time pass on upgrade: archives qualifying runs under the current delay and deletes nothing. */
export function migrateShipArchive(
  runs: ShipRun[],
  delay: ShipArchiveDelay,
  now: number,
): { runs: ShipRun[]; archived: number } {
  return autoArchiveShipRuns(runs, delay, now);
}

export function shipArchiveNoticeText(count: number): string {
  return `${count} ${count === 1 ? 'run' : 'runs'} archived`;
}

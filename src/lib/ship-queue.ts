import type { MergeOwner, ShipRun } from './issue-shipping.ts';
import { shipRunArchived } from './ship-archive.ts';
import {
  shipGroupIds,
  shipRowLine,
  shipRows,
  type ShipRow,
  type ShipRowLine,
} from './ship-list.ts';

export type ShipQueueRow = ShipRow & {
  run: ShipRun;
  line: ShipRowLine;
};

export type ShipQueueFilter = {
  runId: string | null;
  showDone: boolean;
  archived: boolean;
};

export function shipRunName(run: ShipRun): string {
  return run.umbrella?.title ?? run.issues[0]?.title ?? 'Ship run';
}

/** Runs in scope for the queue, newest first, split by the Archived filter. */
export function shipQueueRuns(
  runs: ShipRun[],
  options: { repository: string | null; archived: boolean },
): ShipRun[] {
  return runs
    .filter(
      (run) =>
        shipRunArchived(run) === options.archived &&
        (!options.repository || run.repository === options.repository),
    )
    .toSorted((left, right) => right.approvedAt - left.approvedAt);
}

/**
 * Every issue of every run in scope as one list. Needs-input rows come first;
 * finished issues stay hidden until asked for, except in the Archived view where
 * all rows are finished by definition.
 */
export function shipQueueRows(
  runs: ShipRun[],
  filter: ShipQueueFilter,
  options: { mergeOwner: MergeOwner },
): ShipQueueRow[] {
  const rows = runs
    .filter((run) => filter.runId === null || run.id === filter.runId)
    .flatMap((run) =>
      shipRows(run, options).map((row) =>
        Object.assign({}, row, { run, line: shipRowLine(run, row.issue) }),
      ),
    );
  const visible = rows.filter((row) => filter.archived || filter.showDone || row.group !== 'done');
  return visible.toSorted(
    (left, right) =>
      shipGroupIds.indexOf(left.group) - shipGroupIds.indexOf(right.group) ||
      left.presentation.priority - right.presentation.priority ||
      right.run.approvedAt - left.run.approvedAt ||
      left.issue.number - right.issue.number,
  );
}

export function shipQueueHiddenDone(runs: ShipRun[], options: { mergeOwner: MergeOwner }): number {
  return runs.reduce(
    (total, run) => total + shipRows(run, options).filter((row) => row.group === 'done').length,
    0,
  );
}

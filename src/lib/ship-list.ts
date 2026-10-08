import type { ShipIssue, ShipRun } from './issue-shipping.ts';
import {
  currentShipGates,
  shipActivity,
  shipFixRounds,
  shipIssuePresentation,
  stages,
  type ShipIssuePresentation,
  type ShipPresentationOptions,
} from './ship-progress.ts';

export const shipGroupIds = ['needs-input', 'active', 'waiting', 'queued', 'done'] as const;
export type ShipGroupId = (typeof shipGroupIds)[number];

export const shipGroupLabels: Record<ShipGroupId, string> = {
  'needs-input': 'Needs input',
  active: 'Fixing & active',
  waiting: 'Waiting',
  queued: 'Queued',
  done: 'Done',
};

/** Pane width below which the detail replaces the list instead of sitting beside it. */
export const shipSplitWidth = 560;

export function shipGroupOf(presentation: ShipIssuePresentation): ShipGroupId {
  const { status, label } = presentation;
  if (status === 'completed') return 'done';
  if (status === 'ready' || status === 'failed' || status === 'offline' || status === 'interrupted')
    return 'needs-input';
  if (status === 'fixing' || status === 'working') return 'active';
  if (status === 'waiting') return label.startsWith('Waiting on') ? 'waiting' : 'needs-input';
  if (label === 'Awaiting merge' || label.startsWith('Waiting on')) return 'waiting';
  return 'queued';
}

const placeholderNextAction = 'Resolve the task source and confirm its acceptance criteria.';

/** A checkpoint the worker never updated only holds Sail's initial placeholders. */
export function checkpointTouched(issue: ShipIssue): boolean {
  return !!issue.checkpoint && issue.checkpoint.sequence > 0;
}

export type ShipRowLine = { text: string; kind: 'blocker' | 'question' | 'next' | 'activity' };

/** The newest of blocker, first open question, next action and live activity. */
export function shipRowLine(run: ShipRun, issue: ShipIssue): ShipRowLine {
  const activity = shipActivity(run, issue);
  const activityLine: ShipRowLine = {
    text: `${activity.title} · ${activity.detail}`,
    kind: 'activity',
  };
  const checkpoint = checkpointTouched(issue) ? issue.checkpoint : undefined;
  if (!checkpoint) return activityLine;
  const candidates: (ShipRowLine & { at: number })[] = [];
  if (checkpoint.status === 'blocked' && checkpoint.blocker)
    candidates.push({ text: checkpoint.blocker, kind: 'blocker', at: checkpoint.updatedAt });
  if (checkpoint.unresolvedQuestions[0])
    candidates.push({
      text: checkpoint.unresolvedQuestions[0],
      kind: 'question',
      at: checkpoint.updatedAt,
    });
  if (checkpoint.nextAction && checkpoint.nextAction !== placeholderNextAction)
    candidates.push({ text: checkpoint.nextAction, kind: 'next', at: checkpoint.updatedAt });
  const newest = candidates[0];
  if (!newest) return activityLine;
  return (activity.at ?? 0) > newest.at ? activityLine : { text: newest.text, kind: newest.kind };
}

export type ShipRow = {
  issue: ShipIssue;
  group: ShipGroupId;
  presentation: ShipIssuePresentation;
};

export type ShipOrderSnapshot = Map<string, { group: ShipGroupId; index: number }>;

export function shipRows(
  run: ShipRun,
  options: ShipPresentationOptions,
  frozen?: ShipOrderSnapshot | null,
): ShipRow[] {
  const rows = run.issues.map((issue) => {
    const presentation = shipIssuePresentation(run, issue, options);
    return { issue, presentation, group: shipGroupOf(presentation) };
  });
  const live = rows.toSorted(
    (left, right) =>
      left.presentation.priority - right.presentation.priority ||
      left.issue.number - right.issue.number,
  );
  if (!frozen) return live;
  const liveIndex = new Map(live.map((row, index) => [row.issue.id, index]));
  return live
    .map((row) => ({
      issue: row.issue,
      presentation: row.presentation,
      group: frozen.get(row.issue.id)?.group ?? row.group,
    }))
    .toSorted((left, right) => {
      const before = frozen.get(left.issue.id)?.index ?? Number.MAX_SAFE_INTEGER;
      const after = frozen.get(right.issue.id)?.index ?? Number.MAX_SAFE_INTEGER;
      if (before !== after) return before - after;
      return (liveIndex.get(left.issue.id) ?? 0) - (liveIndex.get(right.issue.id) ?? 0);
    });
}

export function shipOrderSnapshot(rows: ShipRow[]): ShipOrderSnapshot {
  return new Map(rows.map((row, index) => [row.issue.id, { group: row.group, index }]));
}

export type ShipGroup = { id: ShipGroupId; label: string; rows: ShipRow[]; hidden: number };

/**
 * Done rows stay hidden unless asked for, except the selected or focused one,
 * so a row never vanishes under the user's cursor.
 */
export function shipGroups(
  rows: ShipRow[],
  options: { showDone: boolean; pinned: ReadonlySet<string> },
): ShipGroup[] {
  return shipGroupIds.flatMap((id) => {
    const all = rows.filter((row) => row.group === id);
    const shown =
      id === 'done' && !options.showDone
        ? all.filter((row) => options.pinned.has(row.issue.id))
        : all;
    if (!shown.length) return [];
    return [{ id, label: shipGroupLabels[id], rows: shown, hidden: all.length - shown.length }];
  });
}

export type ShipDetailFallback = { runId: string; issueId: string };

/** The issue a split view shows with nothing selected: the remembered one until it finishes, else the first unfinished row. */
export function shipDetailFallback(
  run: ShipRun | undefined,
  rows: ShipRow[],
  remembered: ShipDetailFallback | null,
): ShipDetailFallback | null {
  if (!run) return null;
  if (
    remembered?.runId === run.id &&
    rows.some((row) => row.issue.id === remembered.issueId && row.group !== 'done')
  )
    return remembered;
  const first = rows.find((row) => row.group !== 'done')?.issue;
  return first ? { runId: run.id, issueId: first.id } : null;
}

export function shipAllMerged(run: ShipRun, options: ShipPresentationOptions): boolean {
  return run.issues.length > 0 && shipRows(run, options).every((row) => row.group === 'done');
}

export function shipRowName(row: ShipRow): string {
  const { issue, presentation } = row;
  const title = issue.title === `Issue #${issue.number}` ? '' : ` ${issue.title}`;
  return `#${issue.number}${title}, ${presentation.label}`;
}

export type ShipStageState = 'done' | 'current' | 'upcoming' | 'not-required';
export type ShipStageStep = { id: string; label: string; state: ShipStageState };
export type ShipStageIndicator = {
  steps: ShipStageStep[];
  round: number;
  label: string;
};

const stageLabels: Record<(typeof stages)[number], string> = {
  implementing: 'Implementing',
  reviewing: 'Reviewing',
  testing: 'Testing',
  pull_request: 'Pull request',
  ci: 'CI',
  merging: 'Merging',
  awaiting_merge: 'Awaiting merge',
};

const gateSelectors: Partial<Record<(typeof stages)[number], string[]>> = {
  reviewing: ['code-adversary', 'findings-adversary'],
  testing: ['test-adversary'],
};

const placeholderGates = ['code-adversary', 'findings-adversary', 'test-adversary'];

function requiredGateNames(issue: ShipIssue): string[] | null {
  if (issue.validationPolicy) return issue.validationPolicy.requiredGates;
  const gates = checkpointTouched(issue) ? issue.checkpoint?.requiredGates : undefined;
  if (!gates || gates.join() === placeholderGates.join()) return null;
  return gates;
}

function stageRequired(stage: (typeof stages)[number], required: string[] | null): boolean {
  const selectors = gateSelectors[stage];
  if (!selectors || !required) return true;
  return required.some((name) => selectors.includes(name));
}

function reachedStage(issue: ShipIssue): number {
  const names = [issue.stage, ...(issue.events ?? []).map((event) => event.stage)];
  const indexes = names.map((name) => stages.findIndex((stage) => stage === name));
  const furthest = Math.max(-1, ...indexes);
  if (issue.state === 'awaiting_merge') return Math.max(furthest, stages.indexOf('awaiting_merge'));
  return furthest;
}

function gateSummary(issue: ShipIssue): string[] {
  const gates = currentShipGates(issue);
  const verdict = (name: string) => gates.find((gate) => gate.gate === name)?.verdict;
  const parts: string[] = [];
  const review = [verdict('code-adversary'), verdict('findings-adversary')].filter(Boolean);
  if (review.length) {
    if (review.includes('NEEDS_FIXES')) parts.push('review needs fixes');
    else if (review.includes('BLOCKED')) parts.push('review blocked');
    else if (review.every((item) => item === 'CLEAN')) parts.push('review passed');
  }
  const test = verdict('test-adversary');
  if (test === 'PASS') parts.push('test passed');
  else if (test === 'FAIL') parts.push('test failed');
  else if (test === 'BLOCKED') parts.push('test blocked');
  return parts;
}

/** Progress never moves backwards: a fix round stays on the furthest stage reached. */
export function shipStageIndicator(issue: ShipIssue): ShipStageIndicator {
  const required = requiredGateNames(issue);
  const merged = issue.state === 'merged';
  const reached = merged ? stages.length : reachedStage(issue);
  const current = merged ? -1 : Math.max(reached, issue.state === 'pending' ? -1 : 0);
  const round = shipFixRounds(issue);
  const steps = stages.map((stage, index): ShipStageStep => {
    const state: ShipStageState = !stageRequired(stage, required)
      ? 'not-required'
      : index < current || merged
        ? 'done'
        : index === current
          ? 'current'
          : 'upcoming';
    return { id: stage, label: stageLabels[stage], state };
  });
  const place = merged ? 'Merged' : current < 0 ? 'Not started' : stageLabels[stages[current]];
  const parts = [round > 0 && !merged ? `${place}, round ${round}` : place];
  const summary = gateSummary(issue);
  return { steps, round, label: [parts[0], ...summary].join('; ') };
}

/** The checkpoint's reconciliation result is the only source of a delivery mismatch. */
export function shipDeliveryMismatch(issue: ShipIssue): string | null {
  const result = issue.checkpointReconciliation;
  if (!result || result.resumable || !result.reason || issue.state === 'merged') return null;
  if (issue.checkpoint?.status === 'blocked' && result.reason === issue.checkpoint.blocker)
    return null;
  return result.reason;
}

export function shipTaskObjective(issue: ShipIssue): string | null {
  const objective = checkpointTouched(issue) ? issue.checkpoint?.objective : undefined;
  return objective && objective !== issue.title ? objective : null;
}

export function shipTaskCriteria(issue: ShipIssue): string[] {
  const placeholder = `Satisfy the acceptance criteria in ${issue.url}.`;
  return checkpointTouched(issue)
    ? (issue.checkpoint?.acceptanceCriteria ?? []).filter((criterion) => criterion !== placeholder)
    : [];
}

export function adjacentRowId(ids: string[], current: string | null, step: 1 | -1): string | null {
  if (!ids.length) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index < 0) return step === 1 ? ids[0] : ids.at(-1)!;
  return ids[Math.min(ids.length - 1, Math.max(0, index + step))];
}

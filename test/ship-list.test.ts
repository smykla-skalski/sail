import assert from 'node:assert/strict';
import test from 'node:test';
import { createShipRun, type ShipIssue, type ShipRun } from '../src/lib/issue-shipping.ts';
import {
  adjacentRowId,
  checkpointTouched,
  shipAllMerged,
  shipDeliveryMismatch,
  shipDetailFallback,
  shipGroupOf,
  shipGroups,
  shipOrderSnapshot,
  shipRowLine,
  shipRowName,
  shipRows,
  shipStageIndicator,
  shipTaskCriteria,
  shipTaskObjective,
} from '../src/lib/ship-list.ts';
import { initialTaskCheckpoint, updateTaskCheckpoint } from '../src/lib/task-checkpoint.ts';

function fixture(count = 4): ShipRun {
  return createShipRun(
    {
      umbrella: {
        id: 'umbrella',
        number: 1,
        url: 'https://github.com/a/b/issues/1',
        title: 'Umbrella',
        body: '',
        dependsOn: [],
        state: 'OPEN',
      },
      issues: Array.from({ length: count }, (_, index) => ({
        id: `i${index}`,
        number: index + 2,
        repository: 'a/b',
        url: `https://github.com/a/b/issues/${index + 2}`,
        title: `Issue ${index + 2}`,
        body: '',
        dependsOn: [],
        state: 'OPEN' as const,
      })),
    },
    '/repo',
    'a/b',
    'plan',
    'codex',
    2,
    'run',
    1,
  );
}

function gate(
  name: 'code-adversary' | 'findings-adversary' | 'test-adversary',
  verdict: 'CLEAN' | 'NEEDS_FIXES' | 'PASS' | 'FAIL' | 'BLOCKED',
  updated: number,
) {
  return {
    id: `${name}-${updated}`,
    gate: name,
    requestedModel: 'm',
    provider: 'codex',
    model: 'm',
    threadId: null,
    directory: '/repo',
    state: 'completed' as const,
    created: updated,
    updated,
    error: null,
    verdict,
  };
}

function working(issue: ShipIssue, stage: string, extra: Partial<ShipIssue> = {}) {
  return Object.assign(
    issue,
    { state: 'working' as const, workerState: 'working' as const, stage },
    extra,
  );
}

function touched(issue: ShipIssue, patch: Record<string, unknown>, now: number) {
  const base = initialTaskCheckpoint({ id: issue.id, url: issue.url, title: issue.title }, 1);
  issue.checkpoint = updateTaskCheckpoint(base, patch, now);
  return issue.checkpoint;
}

void test('issues land in the group that tells the user what to do', () => {
  const run = fixture(6);
  const [fixing, blocked, merged, closed] = run.issues;
  working(fixing, 'reviewing', { gates: [gate('code-adversary', 'NEEDS_FIXES', 5)] });
  working(blocked, 'testing', { reportedStatus: 'blocked', blockedReason: 'Need a decision' });
  Object.assign(merged, { state: 'merged' as const });
  Object.assign(closed, {
    state: 'failed' as const,
    error: 'Issue closed before its worker launched.',
  });
  run.issues[4].dependsOn = ['i0'];
  const groups = shipRows(run, {}).map((row) => [row.issue.id, row.group]);
  assert.deepEqual(Object.fromEntries(groups), {
    i0: 'active',
    i1: 'needs-input',
    i2: 'done',
    i3: 'done',
    i4: 'waiting',
    i5: 'queued',
  });
});

void test('the default detail issue stays put when another row re-sorts above it', () => {
  const run = fixture(3);
  const [first, , later] = run.issues;
  Object.assign(first, { state: 'merged' as const });
  const shown = shipDetailFallback(run, shipRows(run, {}), null);
  assert.deepEqual(shown, { runId: 'run', issueId: 'i1' });

  working(later, 'testing', { reportedStatus: 'blocked', blockedReason: 'Need a decision' });
  const resorted = shipRows(run, {});
  assert.equal(resorted.find((row) => row.group !== 'done')?.issue.id, 'i2');
  assert.deepEqual(shipDetailFallback(run, resorted, shown), shown);

  const other = { ...run, id: 'other' };
  assert.deepEqual(shipDetailFallback(other, shipRows(other, {}), shown), {
    runId: 'other',
    issueId: 'i2',
  });
  const removed = { ...run, issues: run.issues.filter((issue) => issue.id !== 'i1') };
  assert.deepEqual(shipDetailFallback(removed, shipRows(removed, {}), shown), {
    runId: 'run',
    issueId: 'i2',
  });
  Object.assign(run.issues[1], { state: 'merged' as const });
  assert.deepEqual(shipDetailFallback(run, shipRows(run, {}), shown), {
    runId: 'run',
    issueId: 'i2',
  });
  assert.equal(shipDetailFallback(undefined, [], shown), null);
  for (const issue of run.issues) issue.state = 'merged';
  assert.equal(shipDetailFallback(run, shipRows(run, {}), null), null);
});

void test('group mapping covers every presentation status', () => {
  const base = { priority: 0, nextAction: '', updated: null };
  const cases: [string, string, string][] = [
    ['completed', 'Completed', 'done'],
    ['ready', 'Ready to merge', 'needs-input'],
    ['failed', 'Recovery needed', 'needs-input'],
    ['offline', 'Recovery needed', 'needs-input'],
    ['interrupted', 'Closed without merge', 'needs-input'],
    ['waiting', 'Needs input', 'needs-input'],
    ['waiting', 'Waiting on #4 (needs input)', 'waiting'],
    ['fixing', 'Fixing (CI)', 'active'],
    ['working', 'Working', 'active'],
    ['queued', 'Awaiting merge', 'waiting'],
    ['queued', 'Waiting on #4', 'waiting'],
    ['queued', 'Queued', 'queued'],
  ];
  for (const [status, label, group] of cases)
    assert.equal(shipGroupOf({ ...base, status, label }), group, `${status} / ${label}`);
});

void test('done rows stay hidden unless pinned or requested', () => {
  const run = fixture(3);
  for (const issue of run.issues.slice(0, 2)) Object.assign(issue, { state: 'merged' as const });
  const rows = shipRows(run, {});
  const hidden = shipGroups(rows, { showDone: false, pinned: new Set() });
  assert.deepEqual(
    hidden.map((group) => group.id),
    ['queued'],
  );
  const pinned = shipGroups(rows, { showDone: false, pinned: new Set(['i0']) });
  assert.deepEqual(
    pinned.find((group) => group.id === 'done')?.rows.map((row) => row.issue.id),
    ['i0'],
  );
  assert.equal(pinned.find((group) => group.id === 'done')?.hidden, 1);
  const shown = shipGroups(rows, { showDone: true, pinned: new Set() });
  assert.equal(shown.find((group) => group.id === 'done')?.rows.length, 2);
});

void test('all-merged runs report it', () => {
  const run = fixture(2);
  assert.equal(shipAllMerged(run, {}), false);
  for (const issue of run.issues) Object.assign(issue, { state: 'merged' as const });
  assert.equal(shipAllMerged(run, {}), true);
  assert.equal(shipAllMerged({ ...run, issues: [] }, {}), false);
});

void test('a frozen order keeps rows in place while their state changes', () => {
  const run = fixture(3);
  working(run.issues[2], 'implementing');
  const before = shipRows(run, {});
  const snapshot = shipOrderSnapshot(before);
  Object.assign(run.issues[0], { state: 'failed' as const, error: 'boom' });
  const live = shipRows(run, {});
  const frozen = shipRows(run, {}, snapshot);
  assert.notDeepEqual(
    live.map((row) => row.issue.id),
    before.map((row) => row.issue.id),
  );
  assert.deepEqual(
    frozen.map((row) => row.issue.id),
    before.map((row) => row.issue.id),
  );
  assert.deepEqual(
    frozen.map((row) => row.group),
    before.map((row) => row.group),
  );
  assert.equal(frozen.find((row) => row.issue.id === 'i0')?.presentation.label, 'Recovery needed');
});

void test('new rows join a frozen order at the end', () => {
  const run = fixture(2);
  const snapshot = shipOrderSnapshot(shipRows(run, {}));
  run.issues.push({ ...run.issues[0], id: 'late', number: 1, title: 'Late' });
  assert.equal(shipRows(run, {}, snapshot).at(-1)?.issue.id, 'late');
});

void test('the row line prefers the newest checkpoint or activity text', () => {
  const run = fixture(1);
  const issue = working(run.issues[0], 'implementing');
  assert.equal(shipRowLine(run, issue).kind, 'activity');

  issue.checkpoint = initialTaskCheckpoint({ id: 'i0', url: issue.url, title: issue.title }, 1);
  assert.equal(checkpointTouched(issue), false);
  assert.equal(shipRowLine(run, issue).kind, 'activity', 'placeholder next action stays hidden');

  touched(issue, { nextAction: 'Open the pull request' }, 10);
  assert.deepEqual(shipRowLine(run, issue), { text: 'Open the pull request', kind: 'next' });

  touched(
    issue,
    { nextAction: 'Open the pull request', unresolvedQuestions: ['Which API version?'] },
    10,
  );
  assert.deepEqual(shipRowLine(run, issue), { text: 'Which API version?', kind: 'question' });

  touched(
    issue,
    {
      status: 'blocked',
      blocker: 'CI is red',
      nextAction: 'Fix CI',
      unresolvedQuestions: ['Which API version?'],
    },
    10,
  );
  assert.deepEqual(shipRowLine(run, issue), { text: 'CI is red', kind: 'blocker' });

  issue.events = [{ at: 99, stage: 'reviewing' }];
  issue.gates = [{ ...gate('code-adversary', 'CLEAN', 99), state: 'working' as const }];
  const line = shipRowLine(run, issue);
  assert.equal(line.kind, 'activity');
  assert.match(line.text, /Code Adversary/);
});

void test('row names stay short and include the state', () => {
  const run = fixture(1);
  const [row] = shipRows(run, {});
  assert.equal(shipRowName(row), '#2 Issue 2, Queued');
  Object.assign(run.issues[0], { title: 'Issue #2' });
  assert.equal(shipRowName(shipRows(run, {})[0]), '#2, Queued');
});

void test('stage indicator keeps its place across fix rounds and names passed gates', () => {
  const run = fixture(1);
  const issue = working(run.issues[0], 'testing', {
    events: [
      { at: 1, stage: 'implementing' },
      { at: 2, stage: 'reviewing' },
      { at: 3, stage: 'testing' },
      { at: 4, stage: 'implementing' },
    ],
    gates: [
      gate('code-adversary', 'CLEAN', 10),
      gate('findings-adversary', 'CLEAN', 11),
      gate('test-adversary', 'FAIL', 12),
      gate('test-adversary', 'FAIL', 13),
    ],
  });
  const indicator = shipStageIndicator(issue);
  assert.equal(indicator.steps.find((step) => step.state === 'current')?.id, 'testing');
  assert.equal(indicator.round, 2);
  assert.equal(indicator.label, 'Testing, round 2; review passed; test failed');
  assert.deepEqual(
    indicator.steps.slice(0, 3).map((step) => step.state),
    ['done', 'done', 'current'],
  );
});

void test('gates a risk policy did not select show as not required', () => {
  const run = fixture(1);
  const issue = working(run.issues[0], 'implementing', {
    validationPolicy: {
      risk: 'low',
      requiredGates: ['test-adversary'],
      sources: ['default'],
      revision: 'r',
      changedPaths: [],
      selectedAt: 1,
      history: [],
    },
  });
  const states = Object.fromEntries(shipStageIndicator(issue).steps.map((s) => [s.id, s.state]));
  assert.equal(states.reviewing, 'not-required');
  assert.equal(states.ci, 'upcoming', 'CI is not a validation gate');
  assert.equal(states.testing, 'upcoming');
  assert.equal(states.implementing, 'current');
});

void test('requiredGates from a touched checkpoint also select stages', () => {
  const run = fixture(1);
  const issue = working(run.issues[0], 'reviewing');
  touched(issue, { requiredGates: ['code-adversary', 'findings-adversary'] }, 5);
  const states = Object.fromEntries(shipStageIndicator(issue).steps.map((s) => [s.id, s.state]));
  assert.equal(states.reviewing, 'current');
  assert.equal(states.testing, 'not-required');
  assert.equal(states.ci, 'upcoming');
});

void test('merged and unstarted issues have terminal indicators', () => {
  const run = fixture(2);
  Object.assign(run.issues[0], { state: 'merged' as const });
  const merged = shipStageIndicator(run.issues[0]);
  assert.equal(merged.label, 'Merged');
  assert.ok(merged.steps.every((step) => step.state === 'done'));
  const queued = shipStageIndicator(run.issues[1]);
  assert.equal(queued.label, 'Not started');
  assert.ok(queued.steps.every((step) => step.state === 'upcoming'));
});

void test('awaiting merge marks the final stage current', () => {
  const run = fixture(1);
  Object.assign(run.issues[0], { state: 'awaiting_merge' as const });
  assert.equal(shipStageIndicator(run.issues[0]).label, 'Awaiting merge');
});

void test('task contract ignores checkpoint placeholders', () => {
  const run = fixture(1);
  const issue = run.issues[0];
  issue.checkpoint = initialTaskCheckpoint({ id: 'i0', url: issue.url, title: issue.title }, 1);
  assert.equal(shipTaskObjective(issue), null);
  assert.deepEqual(shipTaskCriteria(issue), []);
  touched(issue, { objective: 'Ship it', acceptanceCriteria: ['Works'] }, 5);
  assert.equal(shipTaskObjective(issue), 'Ship it');
  assert.deepEqual(shipTaskCriteria(issue), ['Works']);
});

void test('delivery mismatch comes only from the stored reconciliation result', () => {
  const run = fixture(1);
  const issue = run.issues[0];
  assert.equal(shipDeliveryMismatch(issue), null);
  const result = {
    revisionMatches: true,
    resumable: false,
    deliveryState: 'merged',
    issueState: 'OPEN',
    reason: 'The checkpoint no longer matches GitHub delivery state.',
  };
  issue.checkpointReconciliation = result;
  assert.equal(shipDeliveryMismatch(issue), result.reason);
  issue.checkpointReconciliation = { ...result, resumable: true };
  assert.equal(shipDeliveryMismatch(issue), null);
  touched(issue, { status: 'blocked', blocker: 'Need a call', nextAction: 'Ask' }, 5);
  issue.checkpointReconciliation = { ...result, reason: 'Need a call' };
  assert.equal(shipDeliveryMismatch(issue), null, 'a blocker is not a delivery mismatch');
});

void test('arrow navigation stops at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(adjacentRowId(ids, 'a', 1), 'b');
  assert.equal(adjacentRowId(ids, 'c', 1), 'c');
  assert.equal(adjacentRowId(ids, 'a', -1), 'a');
  assert.equal(adjacentRowId(ids, null, 1), 'a');
  assert.equal(adjacentRowId(ids, null, -1), 'c');
  assert.equal(adjacentRowId([], 'a', 1), null);
});

void test('reconciliation survives a save and load', async () => {
  const { loadShipRuns } = await import('../src/lib/ship-progress.ts');
  const run = fixture(1);
  run.issues[0].checkpointReconciliation = {
    revisionMatches: false,
    resumable: false,
    deliveryState: 'working',
    issueState: 'OPEN',
    reason: 'The worktree revision differs from the checkpoint. Inspect changes before resuming.',
  };
  const restored = loadShipRuns(JSON.stringify([run]))[0];
  assert.deepEqual(
    restored.issues[0].checkpointReconciliation,
    run.issues[0].checkpointReconciliation,
  );
});

void test('placeholder fields stay hidden even after a partial worker update', () => {
  const run = fixture(1);
  const issue = run.issues[0];
  touched(issue, { nextAction: 'Explore the code' }, 5);
  assert.equal(shipTaskObjective(issue), null);
  assert.deepEqual(shipTaskCriteria(issue), []);
  assert.ok(shipStageIndicator(issue).steps.every((step) => step.state !== 'not-required'));
});

void test('duplicate criteria and merged issues are handled', () => {
  const run = fixture(1);
  const issue = run.issues[0];
  touched(issue, { acceptanceCriteria: ['Tests pass', 'Tests pass'] }, 5);
  assert.deepEqual(shipTaskCriteria(issue), ['Tests pass', 'Tests pass']);
  issue.checkpointReconciliation = {
    revisionMatches: true,
    resumable: false,
    deliveryState: 'merged',
    issueState: 'OPEN',
    reason: 'stale',
  };
  Object.assign(issue, { state: 'merged' as const });
  assert.equal(shipDeliveryMismatch(issue), null);
});

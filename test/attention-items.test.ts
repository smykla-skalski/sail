import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAttentionLifecycle,
  attentionGraceMillis,
  attentionRoute,
  attentionSurfaceCounts,
  dismissAttention,
  emptyAttentionLedger,
  isAttentionTarget,
  loadAttentionLedger,
  nextAttentionItem,
  shipAttentionCandidates,
  shipReceiptIds,
  shipStalled,
  snoozeAttention,
  snoozeUntil,
  staleHeartbeatMillis,
  subagentAttentionCandidates,
  sessionRequestCandidates,
  threadRequestKeys,
  type AttentionCandidate,
} from '../src/lib/attention-items.ts';
import type { InboxItem } from '../src/lib/inbox.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import { fixture, withMergeEvidence } from './ship-fixtures.ts';

const now = Date.UTC(2026, 9, 8, 12, 0, 0);

function permission(key: string, receivedAt = 100): InboxItem {
  return {
    key,
    kind: 'acp-permission',
    agent: 'Claude',
    agentId: 'claude',
    directory: '/projects/alpha',
    project: 'alpha',
    worktree: null,
    sessionId: key,
    requestId: key,
    text: `Allow ${key}?`,
    receivedAt,
  };
}

function readyRun() {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    state: 'awaiting_merge',
    pullRequest: 'https://example.test/pull/2',
    pullRequestHead: 'commit-one',
    pullRequestState: 'OPEN',
    pullRequestMergeable: true,
    evidenceCommit: 'commit-one',
    checks: [{ name: 'build', state: 'SUCCESS', url: 'https://example.test/build' }],
  });
  issue.checkpoint = { ...issue.checkpoint!, revision: 'commit-one' };
  Object.assign(issue, withMergeEvidence(issue));
  return run;
}

function kinds(items: AttentionCandidate[]): string[] {
  return items.map((item) => `${item.kind}:${item.target.type}`);
}

void test('session requests become permission and question items that cannot be dismissed', () => {
  const question: InboxItem = { ...permission('q'), kind: 'question', agentId: undefined };
  const items = sessionRequestCandidates([
    permission('a'),
    question,
    { ...permission('done'), kind: 'turn-completed' },
  ]);
  assert.deepEqual(kinds(items), ['permission:thread', 'question:thread']);
  assert.ok(items.every((item) => !item.dismissible && item.severity === 'critical'));
  assert.equal(items[0].repo, 'alpha');
  assert.equal(items[1].target.type === 'thread' && items[1].target.agentId, 'opencode');
});

void test('ship issues map to needs-input, ready-to-merge and closed-unmerged items', () => {
  const run = readyRun();
  const second = run.issues[1];
  Object.assign(second, { state: 'working', workerState: 'working', reportedStatus: 'blocked' });
  second.blockedReason = 'Needs a product decision';
  const ready = shipAttentionCandidates([run], { mergeOwner: 'you', now });
  assert.deepEqual(kinds(ready), ['ship-ready-to-merge:ship-issue', 'ship-needs-input:ship-issue']);
  assert.equal(ready[1].detail, 'Needs a product decision');
  assert.deepEqual(kinds(shipAttentionCandidates([run], { mergeOwner: 'agent', now })), [
    'ship-needs-input:ship-issue',
  ]);

  Object.assign(run.issues[0], { pullRequestState: 'CLOSED' });
  const closed = shipAttentionCandidates([run], { mergeOwner: 'you', now });
  assert.equal(closed[0].kind, 'ship-closed-unmerged');
  assert.equal(closed[0].target.type, 'pr');
});

void test('managed CI failures, running fixes, queued and merged issues raise no items', () => {
  const run = fixture();
  const [first, second] = run.issues;
  Object.assign(first, {
    state: 'working',
    workerState: 'working',
    checks: [{ name: 'build', state: 'FAILURE', url: 'https://example.test/build' }],
  });
  Object.assign(second, { state: 'pending' });
  assert.deepEqual(shipAttentionCandidates([run], { mergeOwner: 'you', now }), []);
  Object.assign(first, { state: 'merged' });
  assert.deepEqual(shipAttentionCandidates([run], { mergeOwner: 'you', now }), []);
});

void test('an expired claim or a missing heartbeat marks a running issue stalled', () => {
  const issue = fixture().issues[0];
  Object.assign(issue, { state: 'working', workerState: 'working' });
  const claim = (heartbeatAgo: number, expiresIn: number) => ({
    id: 'claim',
    holder: 'holder',
    task: 'task',
    acquiredAt: new Date(now - 3_600_000).toISOString(),
    heartbeatAt: new Date(now - heartbeatAgo).toISOString(),
    expiresAt: new Date(now + expiresIn).toISOString(),
    status: 'active' as const,
    commentId: 1,
  });
  assert.equal(shipStalled(issue, now), false, 'no claim data is never stalled');
  issue.claim = claim(60_000, 600_000);
  assert.equal(shipStalled(issue, now), false);
  issue.claim = claim(60_000, -1);
  assert.equal(shipStalled(issue, now), true);
  issue.claim = claim(staleHeartbeatMillis + 1, 600_000);
  assert.equal(shipStalled(issue, now), true);
  issue.state = 'merged';
  assert.equal(shipStalled(issue, now), false);
  issue.state = 'working';
  const run = { ...fixture(), issues: [issue] };
  assert.deepEqual(kinds(shipAttentionCandidates([run], { mergeOwner: 'you', now })), [
    'ship-stalled:ship-issue',
  ]);
});

void test('a worker thread that already shows a request is not counted twice', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    state: 'working',
    workerState: 'waiting',
    path: '/projects/alpha',
    threadId: 'acp:claude:s1',
  });
  const requests = sessionRequestCandidates([{ ...permission('s1'), sessionId: 's1' }]);
  const both = shipAttentionCandidates([run], {
    mergeOwner: 'you',
    now,
    requestThreads: threadRequestKeys(requests),
  });
  assert.deepEqual(both, []);
  assert.deepEqual(kinds(shipAttentionCandidates([run], { mergeOwner: 'you', now })), [
    'ship-needs-input:ship-issue',
  ]);
});

function receipt(overrides: Partial<SpawnReceipt> = {}): SpawnReceipt {
  return {
    receiptId: 'r1',
    accessKey: 'key',
    requestId: 'request',
    project: '/projects/alpha',
    sourceId: 'source',
    sourceDirectory: '/projects/alpha',
    targetId: 'acp:claude:child',
    turnId: null,
    targetDirectory: '/projects/alpha',
    worktreeId: null,
    provider: 'claude',
    prompt: 'Review the diff\nmore',
    state: 'waiting',
    created: 1,
    updated: 5,
    result: null,
    error: null,
    ...overrides,
  };
}

void test('waiting subagents become items unless their thread shows a request', () => {
  const items = subagentAttentionCandidates([
    receipt(),
    receipt({ receiptId: 'r2', state: 'working' }),
  ]);
  assert.deepEqual(kinds(items), ['subagent-waiting:subagent']);
  assert.equal(items[0].title, 'Review the diff');
  const requests = threadRequestKeys(
    sessionRequestCandidates([{ ...permission('child'), sessionId: 'child' }]),
  );
  assert.deepEqual(subagentAttentionCandidates([receipt()], requests), []);
});

void test('Ship workers and validation gates are not counted as subagents', () => {
  const run = fixture();
  run.issues[0].receiptId = 'worker';
  assert.deepEqual(
    kinds(
      subagentAttentionCandidates(
        [receipt({ receiptId: 'worker' }), receipt({ receiptId: 'other' })],
        new Set(),
        shipReceiptIds([run]),
      ),
    ),
    ['subagent-waiting:subagent'],
  );
  const gate = receipt({
    receiptId: 'gate',
    validation: { gate: 'code-adversary', requestedModel: 'model' },
  });
  assert.deepEqual(subagentAttentionCandidates([gate]), []);
});

void test('items dedupe by target plus kind and stamp when their state began', () => {
  const [item] = shipAttentionCandidates([readyRun()], { mergeOwner: 'you', now });
  const first = applyAttentionLifecycle(emptyAttentionLedger, [item, { ...item }], now);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].since, now);
  assert.equal(first.changed, true);
  const later = applyAttentionLifecycle(first.ledger, [item], now + 60_000);
  assert.equal(later.items[0].since, now);
  assert.equal(later.changed, false);
  assert.equal(later.ledger, first.ledger);
});

void test('a dismissed item returns on its next state change', () => {
  const run = readyRun();
  const [ready] = shipAttentionCandidates([run], { mergeOwner: 'you', now });
  let view = applyAttentionLifecycle(emptyAttentionLedger, [ready], now);
  view = applyAttentionLifecycle(dismissAttention(view.ledger, view.items[0]), [ready], now + 1);
  assert.deepEqual(view.items, []);
  view = applyAttentionLifecycle(view.ledger, [ready], now + 99_999_999);
  assert.deepEqual(view.items, [], 'a dismissal does not expire with time');

  const other: AttentionCandidate = {
    ...ready,
    id: 'ship-needs-input:x',
    kind: 'ship-needs-input',
  };
  view = applyAttentionLifecycle(view.ledger, [other], now + 2);
  assert.equal(view.items.length, 1, 'a different kind is a state change');

  view = applyAttentionLifecycle(view.ledger, [], now + 3);
  assert.deepEqual(view.items, []);
  view = applyAttentionLifecycle(view.ledger, [], now + 3 + attentionGraceMillis + 1);
  assert.deepEqual(view.ledger, emptyAttentionLedger, 'a resolved item is forgotten');
  const back = now + 4 + attentionGraceMillis;
  view = applyAttentionLifecycle(view.ledger, [ready], back);
  assert.equal(view.items.length, 1, 'the same state coming back is a new state');
  assert.equal(view.items[0].since, back);
});

void test('an item that is missing for a moment keeps its dismissal and start time', () => {
  const [ready] = shipAttentionCandidates([readyRun()], { mergeOwner: 'you', now });
  let view = applyAttentionLifecycle(emptyAttentionLedger, [ready], now);
  const since = view.items[0].since;
  view = applyAttentionLifecycle(dismissAttention(view.ledger, view.items[0]), [ready], now);
  view = applyAttentionLifecycle(view.ledger, [], now + 1_000);
  assert.deepEqual(view.items, []);
  view = applyAttentionLifecycle(view.ledger, [ready], now + 30_000);
  assert.deepEqual(view.items, [], 'a source that loads late does not undo a dismissal');
  assert.deepEqual(view.ledger.gone ?? {}, {});
  assert.equal(view.ledger.seen[ready.id], since);
});

void test('an expired snooze of a missing item is forgotten', () => {
  const [ready] = shipAttentionCandidates([readyRun()], { mergeOwner: 'you', now });
  let view = applyAttentionLifecycle(emptyAttentionLedger, [ready], now);
  view = applyAttentionLifecycle(
    snoozeAttention(view.ledger, view.items[0], now + 5_000),
    [ready],
    now,
  );
  view = applyAttentionLifecycle(view.ledger, [], now + 6_000);
  assert.deepEqual(view.ledger, emptyAttentionLedger);
});

void test('a snoozed item returns when the snooze ends', () => {
  const [ready] = shipAttentionCandidates([readyRun()], { mergeOwner: 'you', now });
  let view = applyAttentionLifecycle(emptyAttentionLedger, [ready], now);
  const until = snoozeUntil('hour', now);
  assert.equal(until, now + 3_600_000);
  view = applyAttentionLifecycle(
    snoozeAttention(view.ledger, view.items[0], until),
    [ready],
    now + 1,
  );
  assert.deepEqual(view.items, []);
  view = applyAttentionLifecycle(view.ledger, [ready], until - 1);
  assert.deepEqual(view.items, []);
  view = applyAttentionLifecycle(view.ledger, [ready], until);
  assert.equal(view.items.length, 1);
  assert.deepEqual(view.ledger.hidden, {});
});

void test('snoozing until tomorrow lands at 08:00 local time on the next day', () => {
  const evening = new Date(2026, 9, 8, 23, 30).getTime();
  const morning = new Date(2026, 9, 9, 8, 0).getTime();
  assert.equal(snoozeUntil('tomorrow', evening), morning);
  assert.equal(snoozeUntil('tomorrow', new Date(2026, 9, 8, 6, 0).getTime()), morning);
});

void test('session requests cannot be dismissed or snoozed', () => {
  const [request] = sessionRequestCandidates([permission('a')]);
  let view = applyAttentionLifecycle(emptyAttentionLedger, [request], now);
  const item = view.items[0];
  assert.equal(dismissAttention(view.ledger, item), view.ledger);
  assert.equal(snoozeAttention(view.ledger, item, now + 1), view.ledger);
  view = applyAttentionLifecycle(
    { seen: {}, hidden: { [item.id]: { mode: 'dismissed', since: item.since } } },
    [request],
    now,
  );
  assert.equal(view.items.length, 1);
});

void test('items sort by severity, then age, and the next item wraps around', () => {
  const run = readyRun();
  Object.assign(run.issues[1], { state: 'working', workerState: 'waiting' });
  const candidates = [
    ...shipAttentionCandidates([run], { mergeOwner: 'you', now }),
    ...sessionRequestCandidates([permission('a', 50), permission('b', 40)]),
  ];
  const { items } = applyAttentionLifecycle(emptyAttentionLedger, candidates, now);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['permission', 'permission', 'ship-needs-input', 'ship-ready-to-merge'],
  );
  assert.deepEqual(
    items.slice(0, 2).map((item) => item.since),
    [40, 50],
  );
  assert.equal(nextAttentionItem(items, null)?.id, items[0].id);
  assert.equal(nextAttentionItem(items, items[0].id)?.id, items[1].id);
  assert.equal(nextAttentionItem(items, items[3].id)?.id, items[0].id);
  assert.equal(nextAttentionItem(items, 'gone')?.id, items[0].id);
  assert.equal(nextAttentionItem([], null), null);
});

void test('Dock, Inbox, Ship tab and status bar count the same list', () => {
  const run = readyRun();
  Object.assign(run.issues[1], { state: 'working', workerState: 'waiting' });
  const candidates = [
    ...shipAttentionCandidates([run], { mergeOwner: 'you', now }),
    ...sessionRequestCandidates([permission('a')]),
  ];
  const { items } = applyAttentionLifecycle(emptyAttentionLedger, candidates, now);
  assert.deepEqual(attentionSurfaceCounts(items), { dock: 3, inbox: 3, shipTab: 1, statusBar: 3 });
  const onlyShip = items.filter((item) => item.kind === 'ship-needs-input');
  assert.deepEqual(attentionSurfaceCounts(onlyShip), {
    dock: 1,
    inbox: 1,
    shipTab: 1,
    statusBar: 1,
  });
  assert.deepEqual(attentionSurfaceCounts([]), { dock: 0, inbox: 0, shipTab: 0, statusBar: 0 });
});

void test('each target opens its own view', () => {
  assert.deepEqual(
    attentionRoute({
      type: 'thread',
      agentId: 'claude',
      directory: '/d',
      sessionId: 's',
      requestId: 7,
    }),
    { view: 'thread', agentId: 'claude', directory: '/d', sessionId: 's', requestId: 7 },
  );
  assert.deepEqual(
    attentionRoute({ type: 'ship-issue', runId: 'r', issueId: 'i', repository: '/repo' }),
    { view: 'ship', repository: '/repo', runId: 'r', issueId: 'i', focus: 'issue' },
  );
  assert.deepEqual(
    attentionRoute({ type: 'pr', url: 'u', runId: 'r', issueId: 'i', repository: '/repo' }),
    { view: 'ship', repository: '/repo', runId: 'r', issueId: 'i', focus: 'pull-request' },
  );
  assert.deepEqual(
    attentionRoute({ type: 'subagent', receiptId: 'x', directory: '/d', targetId: null }),
    { view: 'subagent', receiptId: 'x', directory: '/d', targetId: null },
  );
});

void test('stored ledgers and notification targets are validated', () => {
  assert.deepEqual(loadAttentionLedger('nope'), emptyAttentionLedger);
  assert.deepEqual(
    loadAttentionLedger(
      JSON.stringify({
        seen: { a: 1, b: 'x' },
        hidden: {
          a: { mode: 'dismissed', since: 1 },
          b: { mode: 'snoozed', since: 1, until: 2 },
          c: { mode: 'snoozed', since: 1 },
          d: { mode: 'other', since: 1 },
        },
      }),
    ),
    {
      seen: { a: 1 },
      hidden: { a: { mode: 'dismissed', since: 1 }, b: { mode: 'snoozed', since: 1, until: 2 } },
    },
  );
  assert.equal(
    isAttentionTarget({ type: 'ship-issue', runId: 'r', issueId: 'i', repository: '/r' }),
    true,
  );
  assert.equal(isAttentionTarget({ type: 'ship-issue', runId: 'r' }), false);
  assert.equal(isAttentionTarget('thread-key'), false);
  assert.equal(isAttentionTarget({ type: 'other' }), false);
});

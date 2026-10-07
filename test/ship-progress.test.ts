import assert from 'node:assert/strict';
import test from 'node:test';
import { createShipRun, readyShipIssues } from '../src/lib/issue-shipping.ts';
import {
  appendShipEvent,
  ciStatus,
  dependencyUrl,
  shipGatesSettled,
  shipActivity,
  reconciledShipGates,
  refreshedPullRequest,
  persistShipRefresh,
  gateSnapshot,
  loadShipRuns,
  parseShipReport,
  refreshedIssueState,
  shipOwner,
  shipIssuePresentation,
  shipStatus,
  sortShipIssues,
  validateGateVerdict,
} from '../src/lib/ship-progress.ts';
import {
  loadSpawnReceipts,
  saveBoundedReceipt,
  type SpawnReceipt,
} from '../src/lib/agent-results.ts';

void test('reopened queued issues recover across restart without retrying worker failures', () => {
  const run = fixture();
  Object.assign(run.issues[0], refreshedIssueState(run.issues[0], true));
  assert.equal(run.issues[0].state, 'failed');
  assert.deepEqual(readyShipIssues(run), []);
  const restored = loadShipRuns(JSON.stringify([run]))[0];
  Object.assign(restored.issues[0], refreshedIssueState(restored.issues[0], false));
  assert.equal(restored.issues[0].error, null);
  assert.deepEqual(
    readyShipIssues(restored).map((issue) => issue.id),
    ['first'],
  );
  for (const change of [
    { error: 'Worker failed.' },
    { receiptId: 'receipt' },
    { threadId: 'thread' },
    { path: '/worktree' },
    { pullRequest: 'https://github.com/a/b/pull/1' },
  ]) {
    const failed = { ...run.issues[0], ...change };
    Object.assign(failed, refreshedIssueState(failed, false));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.issueState, 'OPEN');
  }
});

function fixture() {
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
      issues: [
        {
          id: 'first',
          number: 2,
          repository: 'a/b',
          url: 'https://github.com/a/b/issues/2',
          title: 'First',
          body: '',
          dependsOn: [],
          state: 'OPEN',
        },
        {
          id: 'second',
          number: 3,
          repository: 'a/b',
          url: 'https://github.com/a/b/issues/3',
          title: 'Second',
          body: '',
          dependsOn: ['first'],
          state: 'OPEN',
        },
      ],
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

void test('restores umbrella, gate verdict and model after receipts are pruned', () => {
  const run = fixture();
  const receipt: SpawnReceipt = {
    receiptId: 'gate',
    accessKey: 'secret',
    requestId: 'request',
    project: '/repo',
    sourceId: 'worker',
    sourceDirectory: '/worktree',
    targetId: 'gate-thread',
    turnId: 'turn',
    targetDirectory: '/worktree',
    worktreeId: '/worktree',
    provider: 'claude',
    prompt: '',
    state: 'completed',
    created: 1,
    updated: 2,
    result: 'Unstructured text',
    error: null,
    model: 'concrete-model',
    validation: { gate: 'code-adversary', requestedModel: 'concrete-model', verdict: 'CLEAN' },
  };
  run.issues[0].gates = [gateSnapshot(receipt)!];
  const receipts = saveBoundedReceipt([], receipt);
  const restoredReceipts = loadSpawnReceipts(JSON.stringify(receipts));
  const pruned = Array.from({ length: 201 }, (_, index) => ({
    ...receipt,
    receiptId: `unrelated-${index}`,
  })).reduce((saved, next) => saveBoundedReceipt(saved, next), receipts);
  const restored = loadShipRuns(JSON.stringify([run]));

  assert.equal(
    pruned.some((item) => item.receiptId === 'gate'),
    false,
  );
  assert.equal(restoredReceipts[0].validation?.verdict, 'CLEAN');
  assert.equal(restored[0].umbrella?.number, 1);
  assert.equal(restored[0].issues[0].gates?.[0].model, 'concrete-model');
  assert.equal(restored[0].issues[0].gates?.[0].verdict, 'CLEAN');
});

void test('loads legacy runs and discards malformed records without losing valid runs', () => {
  const run = fixture();
  delete run.umbrella;
  run.issues[0].worktreeUnavailable = true;
  const restored = loadShipRuns(JSON.stringify([{ id: 'broken', issues: [null] }, run]));

  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'run');
  assert.equal(restored[0].issues[0].gates, undefined);
  assert.equal(restored[0].issues[0].worktreeUnavailable, true);
  assert.deepEqual(loadShipRuns('{'), []);
});

void test('dependency failure blocks only dependents and merged dependencies become queued', () => {
  const run = fixture();
  assert.equal(shipStatus(run, run.issues[0]), 'Queued');
  assert.equal(shipStatus(run, run.issues[1]), 'Waiting');
  run.issues[0].state = 'failed';
  assert.equal(shipStatus(run, run.issues[1]), 'Blocked');
  run.issues[0].state = 'merged';
  assert.equal(shipStatus(run, run.issues[1]), 'Queued');
});

void test('Ship issues put required action before work, queue, and completion', () => {
  const run = fixture();
  const source = run.issues[0];
  run.issues = [
    {
      ...source,
      id: 'merged',
      number: 6,
      state: 'merged',
      gates: [
        {
          id: 'retained-failure',
          gate: 'test-adversary',
          requestedModel: 'test',
          provider: 'codex',
          model: 'test',
          threadId: 'old',
          directory: '/repo',
          state: 'completed',
          created: 1,
          updated: 1,
          error: null,
          verdict: 'FAIL',
        },
      ],
    },
    { ...source, id: 'queued', number: 5, state: 'pending' },
    { ...source, id: 'working', number: 4, state: 'working', workerState: 'working' },
    { ...source, id: 'waiting', number: 3, state: 'working', workerState: 'waiting' },
    { ...source, id: 'failed', number: 2, state: 'failed', error: 'Worker failed' },
    {
      ...source,
      id: 'ready',
      number: 7,
      state: 'awaiting_merge',
      pullRequest: 'https://example.test/pull/7',
      checks: [{ name: 'build', state: 'SUCCESS', url: 'https://example.test/build' }],
    },
  ];

  assert.deepEqual(
    sortShipIssues(run).map((issue) => issue.id),
    ['failed', 'waiting', 'ready', 'working', 'queued', 'merged'],
  );
  assert.deepEqual(
    run.issues.map((issue) => shipIssuePresentation(run, issue).label),
    ['Completed', 'Queued', 'Working', 'Needs input', 'Recovery needed', 'Awaiting merge'],
  );
  assert.match(shipIssuePresentation(run, run.issues[3]).nextAction, /Respond/);
  assert.equal(shipIssuePresentation(run, run.issues[0]).priority, 4);
  assert.equal(shipIssuePresentation(run, run.issues[5]).nextAction, 'Merge the pull request');
});

void test('worker receipt updates drive presentation freshness', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, { state: 'working', workerState: 'waiting', workerUpdatedAt: 42 });

  assert.equal(shipIssuePresentation(run, issue).updated, 42);
  assert.equal(loadShipRuns(JSON.stringify([run]))[0].issues[0].workerUpdatedAt, 42);
});

void test('latest gate state controls attention without stale failed rounds', () => {
  const run = fixture();
  const issue = run.issues[0];
  issue.state = 'working';
  issue.gates = [
    {
      id: 'failed-old',
      gate: 'code-adversary',
      requestedModel: 'test',
      provider: 'codex',
      model: 'test',
      threadId: 'old',
      directory: '/repo',
      state: 'completed',
      created: 1,
      updated: 1,
      error: null,
      verdict: 'NEEDS_FIXES',
    },
    {
      id: 'clean-new',
      gate: 'code-adversary',
      requestedModel: 'test',
      provider: 'codex',
      model: 'test',
      threadId: 'new',
      directory: '/repo',
      state: 'completed',
      created: 2,
      updated: 2,
      error: null,
      verdict: 'CLEAN',
    },
    {
      id: 'waiting',
      gate: 'findings-adversary',
      requestedModel: 'test',
      provider: 'codex',
      model: 'test',
      threadId: 'waiting',
      directory: '/repo',
      state: 'waiting',
      created: 3,
      updated: 3,
      error: null,
    },
  ];

  assert.deepEqual(shipIssuePresentation(run, issue), {
    status: 'waiting',
    label: 'Needs input',
    priority: 0,
    nextAction: 'Respond to Findings Adversary',
    updated: 3,
  });
  issue.gates[2].state = 'unavailable';
  assert.equal(shipIssuePresentation(run, issue).nextAction, 'Reconnect Findings Adversary');
});

void test('shows the active validation gate before the worker stage', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    state: 'working',
    stage: 'testing',
    gates: [
      {
        id: 'test-gate',
        gate: 'test-adversary',
        requestedModel: 'gpt-5.6-luna',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        threadId: 'gate-thread',
        directory: '/worktree',
        state: 'working',
        created: 10,
        updated: 20,
        error: null,
      },
    ],
  });

  assert.deepEqual(shipActivity(run, issue), {
    state: 'active',
    title: 'Test Adversary — Working',
    detail: 'Validation gate · codex / gpt-5.6-luna',
    at: 20,
  });
});

void test('shows the implementation stage and model while the worker is running', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    state: 'working',
    stage: 'reviewing',
    workerModel: 'gpt-5.6-luna',
    workerState: 'working',
    events: [{ at: 30, stage: 'reviewing' }],
  });

  assert.deepEqual(shipActivity(run, issue), {
    state: 'active',
    title: 'Reviewing',
    detail: 'Worker running · gpt-5.6-luna',
    at: 30,
  });
});

void test('shows the blocking reason instead of a generic stage', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    state: 'working',
    stage: 'testing',
    blockedReason: 'Regression reproduced in the gateway test.',
    events: [{ at: 40, stage: 'testing', reason: 'Regression reproduced in the gateway test.' }],
  });

  assert.deepEqual(shipActivity(run, issue), {
    state: 'blocked',
    title: 'Blocked during Testing',
    detail: 'Regression reproduced in the gateway test.',
    at: 40,
  });
});

void test('shows merge and CI as the current wait state', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    state: 'awaiting_merge',
    checks: [{ name: 'build', state: 'PENDING', url: 'https://example.test/build' }],
  });

  assert.deepEqual(shipActivity(run, issue), {
    state: 'waiting',
    title: 'Awaiting merge',
    detail: 'Pull request open · CI Pending',
    at: undefined,
  });
});

void test('reports require both the assigned worker and its worktree identity', () => {
  const run = fixture();
  run.issues[0].path = '/worktree';
  run.issues[0].threadId = 'worker';

  assert.equal(shipOwner([run], '/worktree', 'worker')?.issue.number, 2);
  assert.equal(shipOwner([run], '/other', 'worker'), undefined);
  assert.equal(shipOwner([run], '/worktree', 'unrelated'), undefined);
});

for (const [name, report] of [
  ['missing reason', { stage: 'ci', status: 'blocked' }],
  ['invalid stage', { stage: 'merged', status: 'running' }],
  ['mixed report', { stage: 'testing', status: 'running', verdict: 'PASS' }],
  ['failing without evidence', { verdict: 'FAIL', reason: '  ' }],
  ['unknown verdict', { verdict: 'SUCCESS' }],
] as const) {
  void test(`rejects ${name}`, () => assert.throws(() => parseShipReport(report)));
}

void test('accepts typed stage and verdict reports, with gate-specific verdicts', () => {
  assert.deepEqual(parseShipReport({ stage: 'ci', status: 'blocked', reason: 'Check failed' }), {
    stage: 'ci',
    status: 'blocked',
    reason: 'Check failed',
  });
  assert.deepEqual(parseShipReport({ verdict: 'CLEAN' }), { verdict: 'CLEAN' });
  assert.deepEqual(parseShipReport({ gate: 'code-adversary', verdict: 'CLEAN' }), {
    gate: 'code-adversary',
    verdict: 'CLEAN',
  });
  assert.throws(() => validateGateVerdict('code-adversary', 'PASS'));
  assert.throws(() => validateGateVerdict('test-adversary', 'CLEAN'));
  assert.doesNotThrow(() => validateGateVerdict('test-adversary', 'PASS'));
});

for (const [states, expected] of [
  [undefined, 'Unknown'],
  [[], 'No checks'],
  [['SUCCESS', 'SKIPPED'], 'Passed'],
  [['SUCCESS', 'PENDING'], 'Pending'],
  [['FAILURE', 'PENDING'], 'Failed'],
  [['CANCELLED'], 'Failed'],
  [['TIMED_OUT'], 'Failed'],
  [['STARTUP_FAILURE'], 'Failed'],
  [['EXPECTED', 'NEUTRAL'], 'Pending'],
  [['NEW_STATE'], 'Pending'],
] as const) {
  void test(`CI ${states?.join(',') ?? 'unknown'} displays ${expected}`, () => {
    assert.equal(ciStatus(states?.map((state) => ({ name: 'check', state, url: '' }))), expected);
  });
}

void test('repeated updates preserve history without duplicate events', () => {
  const events = appendShipEvent([], 'ci', 'Waiting for checks');
  assert.equal(appendShipEvent(events, 'ci', 'Waiting for checks').length, 1);
  assert.equal(appendShipEvent(events, 'ci', 'Check failed').length, 2);
});

void test('external dependencies link only recognized issue references', () => {
  for (const [reference, expected] of [
    ['123', 'https://github.com/a/b/issues/123'],
    ['#123', 'https://github.com/a/b/issues/123'],
    ['owner/repo#123', 'https://github.com/owner/repo/issues/123'],
    ['other.node/repo-name#456', 'https://github.com/other.node/repo-name/issues/456'],
    ['unknown-node', undefined],
    ['javascript:alert(1)', undefined],
    ['../../evil#3', undefined],
    ['owner/repo#0', undefined],
  ])
    assert.equal(dependencyUrl('a/b', reference!), expected);
});

void test('merged cleanup waits for every gate, including unavailable or receipt-pruned gates', () => {
  const issue = fixture().issues[0];
  issue.state = 'merged';
  issue.workerSettled = true;
  const gate = {
    id: 'gate',
    gate: 'test-adversary' as const,
    provider: 'claude',
    model: 'test',
    requestedModel: 'test',
    threadId: 'thread',
    directory: '/worktree',
    created: 1,
    updated: 1,
    error: null,
    state: 'completed' as const,
  };
  for (const state of ['queued', 'starting', 'working', 'waiting', 'unavailable'] as const) {
    issue.gates = [gate, { ...gate, id: 'active', state }];
    assert.equal(shipGatesSettled(issue), false);
  }
  issue.gates = [gate, { ...gate, id: 'failed', state: 'failed' }];
  assert.equal(shipGatesSettled(issue), true);
});

void test('null PR lookup keeps durable PR and CI across restart until a real record arrives', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    state: 'awaiting_merge',
    pullRequest: 'https://github.com/a/b/pull/4',
    checks: [{ name: 'build', state: 'FAILURE', url: 'https://github.com/a/b/actions/runs/1' }],
  });
  Object.assign(issue, refreshedPullRequest(issue, null));
  const restored = loadShipRuns(JSON.stringify([run]))[0].issues[0];
  assert.equal(restored.pullRequest, issue.pullRequest);
  assert.deepEqual(restored.checks, issue.checks);
  assert.equal(restored.state, 'awaiting_merge');
  assert.match(restored.refreshError!, /not returned/);
  Object.assign(
    restored,
    refreshedPullRequest(restored, {
      url: issue.pullRequest!,
      state: 'OPEN',
      mergedAt: null,
      checks: [{ name: 'build', state: 'SUCCESS', url: issue.checks![0].url }],
    }),
  );
  assert.equal(ciStatus(restored.checks), 'Passed');
  assert.equal(restored.refreshError, null);
});

void test('polling commits all parallel issue updates once, after slow refreshes settle', async () => {
  const slow = Promise.withResolvers<void>();
  const updates: string[] = [];
  const snapshots: string[][] = [];
  const tick = persistShipRefresh(
    [
      Promise.resolve().then(() => {
        updates.push('fast');
        return undefined;
      }),
      slow.promise.then(() => {
        updates.push('slow');
        return undefined;
      }),
    ],
    async () => {
      snapshots.push([...updates]);
    },
  );
  await Promise.resolve();
  assert.deepEqual(snapshots, []);
  slow.resolve();
  await tick;
  assert.deepEqual(snapshots, [['fast', 'slow']]);
});

void test('a rejected refresh drains remaining updates and flushes before reporting failure', async () => {
  const slow = Promise.withResolvers<void>();
  const updates: string[] = [];
  let writes = 0;
  const tick = persistShipRefresh(
    [
      Promise.reject(new Error('refresh failed')),
      slow.promise.then(() => {
        updates.push('last');
        return undefined;
      }),
    ],
    async () => {
      assert.deepEqual(updates, ['last']);
      writes += 1;
    },
  );
  const failure = assert.rejects(tick, /refresh failed/);
  assert.equal(writes, 0);
  slow.resolve();
  await failure;
  assert.equal(writes, 1);
});

void test('restart reconciles settled and newly recorded receipts before deciding cleanup', () => {
  const issue = fixture().issues[0];
  issue.path = '/worktree';
  issue.threadId = 'worker';
  const receipt: SpawnReceipt = {
    receiptId: 'gate',
    accessKey: 'secret',
    requestId: 'request',
    project: '/repo',
    sourceId: 'worker',
    sourceDirectory: '/worktree',
    targetId: 'gate-thread',
    turnId: 'turn',
    targetDirectory: '/worktree',
    worktreeId: '/worktree',
    provider: 'claude',
    prompt: '',
    state: 'working',
    created: 1,
    updated: 1,
    result: null,
    error: null,
    model: 'test',
    validation: { gate: 'code-adversary', requestedModel: 'test' },
  };
  issue.gates = reconciledShipGates(issue, [receipt]);
  assert.equal(issue.gates.length, 1);
  assert.equal(shipGatesSettled(issue), false);
  const completed = {
    ...receipt,
    state: 'completed' as const,
    updated: 2,
    validation: { ...receipt.validation!, verdict: 'CLEAN' as const },
  };
  issue.gates = reconciledShipGates(issue, [completed]);
  assert.equal(shipGatesSettled(issue), true);
  assert.equal(issue.gates[0].verdict, 'CLEAN');
  issue.gates = reconciledShipGates(issue, []);
  assert.equal(issue.gates[0].verdict, 'CLEAN');
  issue.gates = reconciledShipGates(issue, [
    { ...receipt, receiptId: 'foreign', sourceId: 'other' },
  ]);
  assert.equal(issue.gates.length, 1);
});

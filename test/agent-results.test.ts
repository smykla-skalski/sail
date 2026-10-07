import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acpReceiptState,
  activeSubagentsForSource,
  boundedSpawnOutput,
  isSubagentThread,
  loadSpawnReceipts,
  receiptForSource,
  receiptNeedsRefresh,
  receiptIsSettled,
  receiptNeedsLiveActivity,
  receiptSourceId,
  runningSubagentsForSource,
  saveBoundedReceipt,
  spawnReceiptsForSource,
  withSpawnResponses,
  type SpawnReceipt,
} from '../src/lib/agent-results.ts';

const receipt: SpawnReceipt = {
  receiptId: 'request-one',
  accessKey: 'secret-one',
  requestId: 'bridge-one',
  project: '/repo',
  sourceId: 'acp:claude:source',
  sourceDirectory: '/repo',
  targetId: 'acp:codex:target',
  turnId: 'turn-one',
  targetDirectory: '/repo/task',
  worktreeId: '/repo/task',
  provider: 'codex',
  prompt: 'Do the task',
  state: 'completed',
  created: 1,
  updated: 2,
  result: 'Done',
  error: null,
};

await test('spawn receipts stay scoped to the launching source and project', () => {
  assert.deepEqual(
    receiptForSource(
      [receipt],
      'request-one',
      receipt.accessKey,
      '/repo',
      receipt.sourceId,
      '/repo',
    ),
    receipt,
  );
  assert.equal(
    receiptForSource(
      [receipt],
      'request-one',
      receipt.accessKey,
      '/other',
      receipt.sourceId,
      '/repo',
    ),
    null,
  );
  assert.equal(
    receiptForSource(
      [receipt],
      'request-one',
      receipt.accessKey,
      '/repo',
      'acp:claude:other',
      '/repo',
    ),
    null,
  );
  assert.equal(
    receiptForSource(
      [receipt],
      'request-one',
      receipt.accessKey,
      '/repo',
      receipt.sourceId,
      '/other',
    ),
    null,
  );
  assert.equal(
    receiptForSource(
      [receipt],
      'request-two',
      receipt.accessKey,
      '/repo',
      receipt.sourceId,
      '/repo',
    ),
    null,
  );
  assert.equal(
    receiptForSource([receipt], 'request-one', 'wrong-key', '/repo', receipt.sourceId, '/repo'),
    null,
  );
});

await test('receipts survive restart with bounded results and honest states', () => {
  const saved = saveBoundedReceipt([], {
    ...receipt,
    result: 'x'.repeat(20_000),
    activity: 'y'.repeat(300),
  });
  const restored = loadSpawnReceipts(JSON.stringify(saved));
  assert.equal(restored[0].result?.length, 16_000);
  assert.equal(restored[0].activity?.length, 200);
  assert.equal(receiptIsSettled(restored[0].state), true);
  assert.equal(receiptIsSettled('waiting'), false);
  assert.equal(
    loadSpawnReceipts(JSON.stringify([{ ...receipt, state: 'working' }]))[0].state,
    'working',
  );
  assert.deepEqual(loadSpawnReceipts('{invalid'), []);
  assert.deepEqual(loadSpawnReceipts(JSON.stringify([{ ...receipt, targetId: 1 }])), []);
});

await test('live activity stays until a settled result is preserved', () => {
  assert.equal(receiptNeedsLiveActivity({ ...receipt, state: 'working', result: null }), true);
  assert.equal(receiptNeedsLiveActivity({ ...receipt, state: 'completed', result: null }), true);
  assert.equal(receiptNeedsLiveActivity(receipt), false);
  assert.equal(
    receiptNeedsLiveActivity({ ...receipt, state: 'failed', result: null, error: 'failed' }),
    false,
  );
});

await test('expanded activity output keeps a bounded meaningful tail', () => {
  assert.equal(boundedSpawnOutput(receipt), 'Done');
  assert.equal(boundedSpawnOutput({ ...receipt, result: null, error: 'failed' }), 'failed');
  assert.equal(boundedSpawnOutput({ ...receipt, result: 'abcdef' }, 4), '…cdef');
});

await test('shipping receipts survive unrelated spawn traffic', () => {
  const protectedIds = new Set(['shipping']);
  let saved = saveBoundedReceipt(
    [],
    { ...receipt, receiptId: 'shipping', state: 'working' },
    protectedIds,
  );
  for (let index = 0; index < 250; index++)
    saved = saveBoundedReceipt(saved, { ...receipt, receiptId: `ordinary-${index}` }, protectedIds);
  assert.equal(saved.length, 201);
  assert.equal(saved.at(-1)?.receiptId, 'shipping');
  assert.equal(loadSpawnReceipts(JSON.stringify(saved)).at(-1)?.state, 'working');
});

await test('conversation activity belongs only to its launching thread', () => {
  const otherSession = { ...receipt, receiptId: 'other-session', sourceId: 'acp:claude:other' };
  const otherDirectory = { ...receipt, receiptId: 'other-directory', sourceDirectory: '/other' };
  const native = { ...receipt, receiptId: 'native', sourceId: 'opencode:source' };
  assert.deepEqual(
    spawnReceiptsForSource(
      [receipt, otherSession, otherDirectory, native],
      receipt.sourceId,
      '/repo',
    ),
    [receipt],
  );
  assert.deepEqual(spawnReceiptsForSource([receipt], null, '/repo'), []);
});

await test('active child activity and thread identity use both session and directory', () => {
  const working = { ...receipt, state: 'working' as const };
  assert.equal(receiptSourceId('codex', 'target'), receipt.targetId);
  assert.equal(receiptSourceId('opencode', 'target'), 'opencode:target');
  assert.deepEqual(activeSubagentsForSource([receipt, working], receipt.sourceId, '/repo'), [
    working,
  ]);
  assert.deepEqual(
    runningSubagentsForSource(
      [
        { ...working, turnId: null },
        { ...working, receiptId: 'queued', state: 'queued', targetId: null },
      ],
      receipt.sourceId,
      '/repo',
    ),
    [{ ...working, turnId: null }],
  );
  assert.deepEqual(activeSubagentsForSource([working], receipt.sourceId, '/other'), []);
  assert.equal(isSubagentThread([receipt], receipt.targetId!, '/repo/task'), true);
  assert.equal(isSubagentThread([receipt], receipt.targetId!, '/other'), false);
});

await test('subagent replies keep their place before later parent messages', () => {
  const entries = [
    { id: 'before', type: 'assistant', created: 1 },
    { id: 'after', type: 'assistant', created: 5 },
  ];
  const timeline = withSpawnResponses(
    entries,
    [{ ...receipt, updated: 3 }],
    (entry) => entry.created,
  );
  assert.deepEqual(
    timeline.map((entry) => entry.id),
    ['before', 'spawn:request-one', 'after'],
  );
  assert.deepEqual(
    withSpawnResponses(entries, [{ ...receipt, state: 'working' }], (entry) => entry.created),
    entries,
  );
});

await test('ACP reconnect requires the same turn to prove state', () => {
  const working = { ...receipt, state: 'working' as const };
  const activity = {
    alive: true,
    active: ['target'],
    activeTurns: { target: 'turn-one' },
    waiting: ['target'],
    sessions: ['target'],
    finished: {},
  };
  assert.equal(acpReceiptState(working, activity), 'waiting');
  assert.equal(acpReceiptState(working, { ...activity, waiting: [] }), 'working');
  assert.equal(
    acpReceiptState(working, { ...activity, activeTurns: { target: 'other-turn' } }),
    'unavailable',
  );
  assert.equal(
    acpReceiptState(working, {
      ...activity,
      activeTurns: {},
      finished: { target: { turnId: 'turn-one', status: 'done', notify: true } },
    }),
    'completed',
  );
  assert.equal(
    acpReceiptState(working, {
      ...activity,
      activeTurns: {},
      finished: { target: { turnId: 'turn-one', status: 'interrupted', notify: false } },
    }),
    'interrupted',
  );
});

for (const [state, refresh] of [
  ['working', true],
  ['waiting', true],
  ['unavailable', true],
  ['completed', false],
  ['failed', false],
  ['interrupted', false],
] as const) {
  void test(`validation receipt ${state} refreshes: ${refresh}`, () => {
    const gate: SpawnReceipt = {
      ...receipt,
      state,
      provider: 'opencode',
      validation: { gate: 'code-adversary', requestedModel: 'concrete' },
    };
    const restored = loadSpawnReceipts(JSON.stringify([gate]));

    assert.equal(receiptNeedsRefresh(restored[0]), refresh);
  });
}

void test('unavailable ordinary receipts remain settled while Ship workers recover', () => {
  assert.equal(receiptNeedsRefresh({ ...receipt, state: 'unavailable' }), false);
  assert.equal(
    receiptNeedsRefresh({ ...receipt, state: 'unavailable', requestId: 'ship:run:issue' }),
    true,
  );
});

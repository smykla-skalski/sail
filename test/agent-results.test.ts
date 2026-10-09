import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acpReceiptState,
  acpPromptHasBackendEvidence,
  acpReplacementDispatchAction,
  acpTurnDispatchProven,
  acpTurnEvidenceState,
  acpTurnNeedsProviderInspection,
  acpTurnPromptCanRetry,
  activeSpawnReceiptForThread,
  activeSubagentsForSource,
  boundedSpawnOutput,
  handoffReceiptForInterruptedTurn,
  handoffReceiptNeedsResolution,
  handoffPromptNeedsRecovery,
  isSubagentThread,
  loadSpawnReceipts,
  receiptForSource,
  receiptMatchesTurn,
  receiptNeedsRefresh,
  promptConflictTurnId,
  failedPromptDispatch,
  failedUnsubmittedDispatch,
  receiptIsSettled,
  receiptNeedsLiveActivity,
  receiptSourceId,
  pendingHandoffReplacement,
  replacementReceiptForInspection,
  resolvedHandoffRecoveryError,
  runningSubagentsForSource,
  saveBoundedReceipt,
  spawnPromptDispatchAllowed,
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

void test('receipt settlement is correlated to its current turn', () => {
  assert.equal(receiptMatchesTurn(receipt, 'turn-one'), true);
  assert.equal(receiptMatchesTurn({ ...receipt, turnId: 'turn-two' }, 'turn-one'), false);
  assert.equal(receiptMatchesTurn(undefined, 'turn-one'), false);
});

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

await test('spawn receipts persist requested and actual route identity', () => {
  const routed: SpawnReceipt = {
    ...receipt,
    routing: {
      role: 'implementation',
      risk: 'high',
      independentReviewRequired: true,
      requested: { provider: 'codex', model: 'gpt-6.1-sol', variant: 'xhigh' },
      actual: { provider: 'codex', model: 'gpt-6.1-sol', variant: 'xhigh' },
    },
  };
  assert.deepEqual(loadSpawnReceipts(JSON.stringify([routed]))[0].routing, routed.routing);
  const defaultModel: SpawnReceipt = {
    ...routed,
    routing: {
      ...routed.routing!,
      independentReviewRequired: false,
      requested: { provider: 'codex', model: null, variant: null },
      actual: { provider: 'codex', model: null, variant: null },
    },
  };
  assert.deepEqual(
    loadSpawnReceipts(JSON.stringify([defaultModel]))[0].routing,
    defaultModel.routing,
  );
  const invalid = {
    ...routed,
    routing: { ...routed.routing!, requested: { ...routed.routing!.requested, model: 1 } },
  };
  assert.equal(loadSpawnReceipts(JSON.stringify([invalid]))[0].routing, undefined);
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
  assert.equal(
    loadSpawnReceipts(JSON.stringify([{ ...receipt, dispatchPending: true }]))[0].dispatchPending,
    true,
  );
});

await test('known pre-dispatch failures clear the durable admission fence', () => {
  assert.deepEqual(failedUnsubmittedDispatch('authorization expired'), {
    state: 'failed',
    error: 'authorization expired',
    dispatchPending: false,
  });
  assert.deepEqual(failedPromptDispatch({ _tag: 'SessionNotFoundError' }, 'missing session'), {
    state: 'failed',
    error: 'missing session',
    dispatchPending: false,
  });
  assert.deepEqual(failedPromptDispatch({ name: 'TypeError' }, 'network failed'), {
    state: 'failed',
    error: 'network failed',
  });
});

await test('durable prompt ID conflicts retain the admission fence for reconciliation', () => {
  const conflict = {
    _tag: 'ConflictError',
    resource: 'turn-one',
  };

  assert.equal(promptConflictTurnId(conflict), 'turn-one');
  assert.deepEqual(failedPromptDispatch(conflict, 'already admitted'), {
    state: 'failed',
    error: 'already admitted',
  });
  assert.equal(promptConflictTurnId({ _tag: 'ConflictError' }), null);
});

await test('an active launch transaction fences an idle created session', () => {
  const starting = { ...receipt, state: 'starting' as const };
  const active = new Set([starting.receiptId]);

  assert.equal(
    activeSpawnReceiptForThread([starting], active, starting.targetId!, starting.targetDirectory!),
    starting,
  );
  assert.equal(
    activeSpawnReceiptForThread([starting], new Set(), starting.targetId!, '/repo/task'),
    null,
  );
  assert.equal(spawnPromptDispatchAllowed(starting), true);
  assert.equal(spawnPromptDispatchAllowed({ ...starting, state: 'unavailable' }), true);
  assert.equal(spawnPromptDispatchAllowed({ ...starting, state: 'interrupted' }), false);
});

await test('durable ACP evidence distinguishes completion from uncertain dispatch', () => {
  const evidence = {
    agent: 'codex',
    sessionId: 'target',
    turnId: 'turn-one',
    status: 'done' as const,
    error: null,
    updatedAt: 1,
  };

  assert.equal(acpTurnEvidenceState(evidence), 'completed');
  assert.equal(acpTurnEvidenceState({ ...evidence, status: 'failed' }), 'failed');
  assert.equal(acpTurnEvidenceState({ ...evidence, status: 'interrupted' }), 'interrupted');
  assert.equal(acpTurnEvidenceState({ ...evidence, status: 'dispatched' }), 'unavailable');
  assert.equal(acpTurnEvidenceState({ ...evidence, status: 'prepared' }), 'unavailable');
  assert.equal(acpTurnDispatchProven({ ...evidence, status: 'prepared' }), false);
  assert.equal(acpTurnPromptCanRetry({ ...evidence, status: 'prepared' }), true);
  assert.equal(acpTurnNeedsProviderInspection({ ...evidence, status: 'dispatch_uncertain' }), true);
  assert.equal(acpTurnDispatchProven({ ...evidence, status: 'dispatch_uncertain' }), false);
  assert.equal(acpTurnPromptCanRetry({ ...evidence, status: 'dispatch_uncertain' }), false);
  assert.equal(acpTurnDispatchProven({ ...evidence, status: 'dispatched' }), true);
  assert.equal(acpTurnNeedsProviderInspection({ ...evidence, status: 'dispatched' }), true);
  assert.equal(acpTurnDispatchProven(evidence), true);
  assert.equal(acpTurnDispatchProven(null), false);
  assert.equal(acpTurnEvidenceState(null), null);
});

await test('uncertain ACP replacement dispatch requires inspection instead of source restoration', () => {
  const evidence = {
    agent: 'codex',
    sessionId: 'replacement',
    turnId: 'handoff-turn',
    status: 'dispatch_uncertain' as const,
    error: 'transport write failed',
    updatedAt: 1,
  };

  const action = acpReplacementDispatchAction(evidence);

  assert.equal(action, 'inspect');
});

await test('uncertain replacement remains owned even after its prompt promise reports failure', () => {
  const failed = {
    ...receipt,
    receiptId: 'handoff-replacement',
    requestId: 'handoff:handoff-one',
    state: 'failed' as const,
    error: 'transport write failed',
  };

  const preserved = replacementReceiptForInspection(
    failed,
    'Prompt dispatch may have completed before restart; inspect the restored provider session before cancelling and retrying.',
    3,
  );

  assert.deepEqual(preserved, {
    ...failed,
    state: 'unavailable',
    error:
      'Prompt dispatch may have completed before restart; inspect the restored provider session before cancelling and retrying.',
    updated: 3,
  });
  assert.equal(handoffReceiptNeedsResolution(preserved), true);
});

await test('restart routes a dispatched ACP handoff away from generic continuation recovery', () => {
  const handoff = {
    ...receipt,
    requestId: 'handoff:handoff-one',
    state: 'working' as const,
  };
  const interrupted = {
    agent: 'codex',
    sessionId: 'target',
    directory: '/repo/task',
    turnId: 'turn-one',
    text: 'Continue from the canonical checkpoint',
  };

  const recovered = handoffReceiptForInterruptedTurn(interrupted, [handoff]);

  assert.equal(recovered, handoff);
});

await test('uncertain handoff receipts require explicit provider resolution', () => {
  const uncertain = {
    ...receipt,
    requestId: 'handoff:handoff-one',
    state: 'unavailable' as const,
    error:
      'Prompt dispatch may have completed before restart; inspect the restored provider session before cancelling and retrying.',
  };

  assert.equal(handoffReceiptNeedsResolution(uncertain), true);
  assert.equal(handoffReceiptNeedsResolution({ ...uncertain, state: 'working' }), false);
  assert.equal(handoffReceiptNeedsResolution({ ...uncertain, requestId: 'ship:one' }), false);
});

await test('resolved handoff recovery clears only its inspection error', () => {
  const inspection =
    'Prompt dispatch may have completed before restart; inspect the restored provider session.';

  assert.equal(resolvedHandoffRecoveryError(false, inspection), null);
  assert.equal(
    resolvedHandoffRecoveryError(false, 'Different worker failure.'),
    'Different worker failure.',
  );
  assert.equal(resolvedHandoffRecoveryError(true, inspection), inspection);
});

await test('a settled child renders once, with or without output', () => {
  const entries = [{ id: 'after', type: 'assistant', created: 5 }];
  for (const settled of [
    { ...receipt, state: 'completed' as const, result: null },
    { ...receipt, state: 'completed' as const },
    { ...receipt, state: 'failed' as const, result: null, error: 'failed' },
    { ...receipt, state: 'interrupted' as const, result: null },
    { ...receipt, state: 'unavailable' as const, result: null },
  ]) {
    assert.equal(receiptNeedsLiveActivity(settled), false, `${settled.state} has no live card`);
    assert.deepEqual(
      withSpawnResponses(entries, [{ ...settled, updated: 3 }], (entry) => entry.created).map(
        (entry) => entry.id,
      ),
      [`spawn:${settled.receiptId}`, 'after'],
      `${settled.state} has one response`,
    );
  }
  for (const live of ['queued', 'starting', 'working', 'waiting'] as const)
    assert.equal(receiptNeedsLiveActivity({ ...receipt, state: live, result: null }), true);
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
  const native = { ...receipt, receiptId: 'native', sourceId: 'acp:opencode:source' };
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
  assert.equal(receiptSourceId('opencode', 'target'), 'acp:opencode:target');
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

await test('ACP recovery requires live backend evidence instead of a persisted interruption', () => {
  const working = { ...receipt, state: 'working' as const };
  const activity = {
    alive: true,
    active: ['target'],
    activeTurns: { target: 'turn-one' },
    waiting: [],
    sessions: ['target'],
    finished: {},
  };

  assert.equal(acpPromptHasBackendEvidence(working, activity), true);
  assert.equal(acpPromptHasBackendEvidence(working, { ...activity, activeTurns: {} }), false);
  assert.equal(
    acpPromptHasBackendEvidence(working, {
      ...activity,
      activeTurns: {},
      finished: { target: { turnId: 'turn-one', status: 'done', notify: true } },
    }),
    true,
  );
});

await test('ACP handoff ownership published before prompt startup recovers after restart', () => {
  const recoverable = {
    ...receipt,
    receiptId: 'handoff-receipt',
    requestId: 'handoff:handoff-one',
    state: 'starting' as const,
  };
  const issue = {
    state: 'working',
    receiptId: recoverable.receiptId,
    threadId: recoverable.targetId,
    contextHandoffs: [
      {
        id: 'handoff-one',
        fromThreadId: 'acp:claude:source',
        toThreadId: recoverable.targetId,
        outcome: 'pending',
      },
    ],
  };

  assert.equal(handoffPromptNeedsRecovery(issue, recoverable), true);
});

await test('handoff replacement created before ownership transfer is adopted after restart', () => {
  const replacement = {
    ...receipt,
    receiptId: 'handoff-receipt',
    requestId: 'handoff:handoff-one',
    sourceDirectory: '/repo/task',
    state: 'starting' as const,
  };
  const issue = {
    state: 'working',
    path: '/repo/task',
    receiptId: 'old-receipt',
    threadId: receipt.sourceId,
    contextHandoffs: [
      {
        id: 'handoff-one',
        fromThreadId: receipt.sourceId,
        toThreadId: null,
        outcome: 'pending',
      },
    ],
  };

  assert.equal(pendingHandoffReplacement(issue, [replacement]), replacement);
  assert.equal(
    pendingHandoffReplacement(issue, [{ ...replacement, state: 'failed' }])?.state,
    'failed',
  );
  assert.equal(pendingHandoffReplacement(issue, [{ ...replacement, turnId: null }]), null);
});

await test('OpenCode handoff prompt recovery requires replacement ownership', () => {
  const recoverable = {
    ...receipt,
    provider: 'opencode' as const,
    targetId: 'acp:opencode:replacement',
    receiptId: 'handoff-receipt',
    requestId: 'handoff:handoff-one',
    state: 'starting' as const,
  };
  const issue = {
    state: 'working',
    receiptId: recoverable.receiptId,
    threadId: recoverable.targetId,
    contextHandoffs: [
      {
        id: 'handoff-one',
        fromThreadId: receipt.sourceId,
        toThreadId: recoverable.targetId,
        outcome: 'pending',
      },
    ],
  };

  assert.equal(handoffPromptNeedsRecovery(issue, recoverable), true);
  assert.equal(
    handoffPromptNeedsRecovery({ ...issue, receiptId: 'old-receipt' }, recoverable),
    false,
  );
});

await test('owned handoff prompts recover across every unsettled restart window', () => {
  const recoverable = {
    ...receipt,
    receiptId: 'handoff-receipt',
    requestId: 'handoff:handoff-one',
    targetId: 'acp:opencode:replacement',
    provider: 'opencode' as const,
    state: 'starting' as const,
  };
  const issue = {
    state: 'working',
    receiptId: recoverable.receiptId,
    threadId: recoverable.targetId,
    contextHandoffs: [
      {
        id: 'handoff-one',
        fromThreadId: receipt.sourceId,
        toThreadId: recoverable.targetId,
        outcome: 'pending',
      },
    ],
  };

  for (const state of ['starting', 'working', 'unavailable'] as const) {
    const crashed = { ...recoverable, state };
    assert.equal(handoffPromptNeedsRecovery(issue, crashed), true, state);
    assert.equal(receiptNeedsRefresh(crashed), true, state);
  }
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

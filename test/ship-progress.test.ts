import assert from 'node:assert/strict';
import test from 'node:test';
import { readyShipIssues } from '../src/lib/issue-shipping.ts';
import { migrateShipArchive } from '../src/lib/ship-archive.ts';
import {
  appendShipEvent,
  beginLatestRefresh,
  ciStatus,
  completedInlineShipGate,
  dependencyUrl,
  nextValidationReservation,
  reserveInlineValidation,
  shipGatesSettled,
  shipCleanupRequest,
  shipEvidenceReadiness,
  shipTaskThreadsSettled,
  shipTaskReceiptIdsToProtect,
  shipActivity,
  reconciledShipGates,
  recoverValidationEvidence,
  rollbackValidationIssue,
  rollbackValidationReceipt,
  refreshedPullRequest,
  persistShipRefresh,
  gateSnapshot,
  loadShipRuns,
  loadShipRunStore,
  serializeShipRuns,
  parseShipReport,
  requireValidatorEconomics,
  refreshedIssueState,
  shipOwner,
  shipCheckpointOwner,
  currentShipBlockedReason,
  repositoryForRemote,
  unrecoverableGraceExpired,
  unrecoverableIssuePlan,
  shippingWorkerGone,
  authorizeShipCheckpointThread,
  commitRevisionBoundValidation,
  shipIssuePresentation,
  shipMergeClaim,
  shipOwnedThreadIds,
  shipOwnershipQuietGeneration,
  shipOwnershipQuietPass,
  shipStatus,
  sortShipIssues,
  validateGateVerdict,
  validationRevisionDrifted,
} from '../src/lib/ship-progress.ts';
import {
  loadSpawnReceipts,
  saveBoundedReceipt,
  type SpawnReceipt,
} from '../src/lib/agent-results.ts';
import { evidenceReadiness, recordTaskEvidence } from '../src/lib/task-evidence.ts';
import { emptyTaskEconomics, summarizeTaskEconomics } from '../src/lib/task-economics.ts';
import { fixture, withMergeEvidence } from './ship-fixtures.ts';
import { nativeSubagentReceipts, type NativeSubagentStore } from '../src/lib/native-subagents.ts';

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

void test('status context identity survives Ship run persistence', () => {
  const run = fixture();
  run.issues[0].checks = [
    {
      name: 'external/build',
      state: 'SUCCESS',
      url: 'https://ci.test/build/1',
      statusContextId: 'SC_kwDOStatusContext1',
      identityUncertain: false,
    },
  ];

  const restored = loadShipRuns(JSON.stringify([run]))[0];

  assert.equal(restored.issues[0].checks?.[0].statusContextId, 'SC_kwDOStatusContext1');
  assert.equal(restored.issues[0].checks?.[0].identityUncertain, false);
});

void test('validation drift leaves verdict and evidence uncommitted', async () => {
  await Promise.all(
    (['revision', 'generation', 'base'] as const).map(async (drift) => {
      let revision = 'revision-one';
      let generation = 'generation-one';
      let baseRevision = 'base-one';
      const durable = { verdict: undefined as string | undefined, evidence: [] as string[] };

      await assert.rejects(
        commitRevisionBoundValidation({
          expectedRevision: 'revision-one',
          expectedMutationGeneration: 'generation-one',
          expectedBaseRevision: 'base-one',
          readRevision: async () => revision,
          readMutationGeneration: async () => generation,
          readBaseRevision: async () => baseRevision,
          prepare: async () => {
            if (drift === 'revision') revision = 'revision-two';
            else if (drift === 'generation') generation = 'generation-two';
            else baseRevision = 'base-two';
            return { verdict: 'PASS', evidence: ['gate passed'] };
          },
          commit: async (prepared) => {
            durable.verdict = prepared.verdict;
            durable.evidence = prepared.evidence;
          },
        }),
        /(worktree (changed|was modified)|shipping base changed) during validation/,
      );
      assert.deepEqual(durable, { verdict: undefined, evidence: [] });
    }),
  );
});

void test('validation drift during durable commit rolls the verdict back', async () => {
  let generation = 'generation-one';
  let durableVerdict: string | undefined;

  await assert.rejects(
    commitRevisionBoundValidation({
      expectedRevision: 'revision-one',
      expectedMutationGeneration: 'generation-one',
      readRevision: async () => 'revision-one',
      readMutationGeneration: async () => generation,
      prepare: async () => 'PASS',
      commit: async (verdict, registerRollback) => {
        registerRollback(async () => {
          durableVerdict = undefined;
        });
        durableVerdict = verdict;
        generation = 'edited-during-storage';
      },
    }),
    /worktree was modified during validation/,
  );
  assert.equal(durableVerdict, undefined);
});

void test('a failed durable commit compensates its receipt without erasing concurrent state', async () => {
  const previous = validationReceipt();
  let durable = structuredClone(previous);

  await assert.rejects(
    commitRevisionBoundValidation({
      expectedRevision: 'revision-one',
      expectedMutationGeneration: 'generation-one',
      readRevision: async () => 'revision-one',
      readMutationGeneration: async () => 'generation-one',
      prepare: async () => 'CLEAN',
      commit: async (verdict, registerRollback) => {
        const committed = {
          ...durable,
          validation: { ...durable.validation!, verdict },
        };
        registerRollback(async () => {
          durable = rollbackValidationReceipt(durable, previous, committed);
        });
        durable = {
          ...committed,
          validation: { ...committed.validation, revisionDrifted: true },
        };
        throw new Error('Ship run storage failed.');
      },
    }),
    /Ship run storage failed/,
  );

  assert.equal(durable.validation?.verdict, undefined);
  assert.equal(durable.validation?.revisionDrifted, true);
});

function validationReceipt(): SpawnReceipt {
  return {
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
    provider: 'codex',
    model: 'test',
    prompt: '',
    validation: {
      gate: 'code-adversary',
      requestedModel: 'test',
      sequence: 0,
      evidenceSequence: 1,
      revision: 'revision-one',
      mutationGeneration: 'generation-one',
      baseRevision: 'base-one',
    },
    state: 'working',
    created: 1,
    updated: 1,
    result: null,
    error: null,
  };
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
    validation: {
      gate: 'code-adversary',
      requestedModel: 'concrete-model',
      sequence: 7,
      revision: 'revision-one',
      verdict: 'CLEAN',
    },
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
  assert.equal(restoredReceipts[0].validation?.revision, 'revision-one');
  assert.equal(restoredReceipts[0].validation?.sequence, 7);
  assert.equal(restored[0].umbrella?.number, 1);
  assert.equal(restored[0].issues[0].gates?.[0].model, 'concrete-model');
  assert.equal(restored[0].issues[0].gates?.[0].verdict, 'CLEAN');
  assert.equal(restored[0].issues[0].gates?.[0].sequence, 7);
});

void test('loads legacy runs and discards malformed records without losing valid runs', () => {
  const run = fixture();
  delete run.umbrella;
  run.issues[0].worktreeUnavailable = true;
  delete run.issues[0].validationPolicyRequired;
  const restored = loadShipRuns(JSON.stringify([{ id: 'broken', issues: [null] }, run]));

  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'run');
  assert.equal(restored[0].issues[0].gates, undefined);
  assert.equal(restored[0].issues[0].worktreeUnavailable, true);
  assert.equal(restored[0].issues[0].validationPolicyRequired, true);
  assert.deepEqual(loadShipRuns('{'), []);
});

void test('saving keeps stored runs that cannot be parsed', () => {
  const broken = { id: 'broken', issues: [null], futureField: { kept: true } };
  const store = loadShipRunStore(JSON.stringify([broken, fixture()]));
  assert.deepEqual(
    store.runs.map((run) => run.id),
    ['run'],
  );
  assert.deepEqual(store.unparsed, [broken]);

  const archived = migrateShipArchive(store.runs, '1d', Date.now()).runs;
  const saved = serializeShipRuns(archived, store.unparsed);
  assert.deepEqual(JSON.parse(saved)[1], broken);
  const reloaded = loadShipRunStore(saved);
  assert.deepEqual(reloaded.unparsed, [broken]);
  assert.equal(reloaded.runs.length, 1);

  for (const raw of ['{', '{"not":"a list"}']) {
    const corrupt = loadShipRunStore(raw);
    assert.deepEqual(corrupt.runs, []);
    assert.equal(corrupt.unparsed.length, 1, raw);
    assert.equal(loadShipRunStore(serializeShipRuns([], corrupt.unparsed)).unparsed.length, 1);
  }
  assert.deepEqual(loadShipRunStore(null), { runs: [], unparsed: [] });
});

void test('legacy persisted work cannot opt out of validation by omitting the policy flag', () => {
  const run = fixture();
  delete run.issues[0].validationPolicyRequired;
  Object.assign(run.issues[1], { state: 'merged', path: null });
  delete run.issues[1].validationPolicyRequired;

  const restored = loadShipRuns(JSON.stringify([run]));

  assert.equal(restored[0].issues[0].validationPolicyRequired, true);
  assert.equal(restored[0].issues[1].validationPolicyRequired, true);
  assert.equal(shipEvidenceReadiness(restored[0].issues[0]).ready, false);
});

void test('Ship cleanup binds deletion to the selected validation revision', () => {
  const issue = withMergeEvidence(fixture().issues[0]);
  issue.path = '/worktree';
  issue.branch = 'validated-branch';

  assert.deepEqual(shipCleanupRequest('a/b', issue, 'newer-unchecked-revision'), {
    repository: 'a/b',
    worktree: '/worktree',
    force: false,
    archiveIgnored: true,
    expectedRevision: 'revision-one',
    expectedBranch: 'validated-branch',
  });
});

void test('Ship cleanup rejects a merged task before evidence recovery', () => {
  const issue = fixture().issues[0];
  issue.path = '/worktree';
  issue.branch = 'validated-branch';

  assert.throws(
    () => shipCleanupRequest('a/b', issue, 'revision-one'),
    /complete revision-bound evidence/,
  );
});

void test('durable gate receipts recover manifest evidence after restart', () => {
  const issue = fixture().issues[0];
  issue.checkpoint!.revision = 'revision-one';
  issue.checkpoint!.requiredGates = ['test-adversary'];
  issue.validationPolicy = {
    risk: 'low',
    requiredGates: ['test-adversary'],
    sources: ['test'],
    revision: 'revision-one',
    changedPaths: [],
    selectedAt: 1,
    history: [],
  };
  const economics = { ...emptyTaskEconomics('validator', 'test'), checks: 1 };
  const receipt = validationReceipt();
  Object.assign(receipt, {
    receiptId: 'durable-receipt',
    targetId: 'validator',
    state: 'completed',
    created: 10,
    updated: 11,
    validation: {
      ...receipt.validation,
      gate: 'test-adversary',
      verdict: 'PASS (partial)',
      revision: 'revision-one',
      baseRevision: undefined,
      evidenceCriteria: issue.checkpoint!.acceptanceCriteria,
      evidenceOutputReference: 'thread:validator',
      evidenceTimestamp: 11,
      evidenceEconomics: economics,
    },
  });
  const restoredReceipt = loadSpawnReceipts(JSON.stringify(saveBoundedReceipt([], receipt)))[0];
  issue.gates = [gateSnapshot(restoredReceipt)!];

  const recovered = recoverValidationEvidence(issue, undefined);
  assert.ok(recovered);
  Object.assign(issue, recovered);
  const summary = summarizeTaskEconomics(
    issue.evidenceManifests ?? [],
    shipEvidenceReadiness(issue),
    issue.evidenceRevision,
  );
  assert.equal(issue.evidenceManifests?.[0]?.evidence[0]?.id, 'gate:durable-receipt');
  assert.deepEqual(issue.evidenceManifests?.[0]?.evidence[0]?.economics, economics);
  assert.equal(shipEvidenceReadiness(issue).ready, true);
  assert.equal(summary.economicsComplete, true);
  assert.equal(summary.totals.checks, 1);
  assert.equal(recoverValidationEvidence(issue, undefined), null);
});

void test('receipt recovery preserves attempt order when an older receipt is missing', () => {
  const issue = fixture().issues[0];
  issue.checkpoint!.revision = 'revision-one';
  issue.checkpoint!.requiredGates = ['test-adversary'];
  issue.validationPolicy = {
    risk: 'low',
    requiredGates: ['test-adversary'],
    sources: ['test'],
    revision: 'revision-one',
    changedPaths: [],
    selectedAt: 1,
    history: [],
  };
  const gateAttempt = (id: string, sequence: number, verdict: 'PASS' | 'FAIL') => ({
    id,
    gate: 'test-adversary' as const,
    requestedModel: 'test',
    provider: 'codex',
    model: 'test',
    threadId: id,
    directory: '/worktree',
    state: 'completed' as const,
    created: 10 + sequence,
    updated: 10 + sequence,
    error: null,
    verdict,
    revision: 'revision-one',
    sequence,
    evidenceCriteria: issue.checkpoint!.acceptanceCriteria,
    evidenceOutputReference: `thread:${id}`,
    evidenceTimestamp: 10 + sequence,
  });
  issue.gates = [gateAttempt('older', 1, 'FAIL'), gateAttempt('newer', 2, 'PASS')];
  Object.assign(issue, recoverValidationEvidence(issue, undefined));
  issue.evidenceManifests![0].evidence = issue.evidenceManifests![0].evidence.filter(
    (entry) => entry.id !== 'gate:older',
  );

  Object.assign(issue, recoverValidationEvidence(issue, undefined));

  assert.equal(shipEvidenceReadiness(issue).ready, true);
  assert.deepEqual(
    issue.evidenceManifests![0].evidence.map((entry) => [entry.id, entry.sequence]),
    [
      ['gate:older', 1],
      ['gate:newer', 2],
    ],
  );
  assert.equal(recoverValidationEvidence(issue, undefined), null);
});

void test('receipt recovery cannot reactivate evidence from an obsolete shipping base', () => {
  const issue = fixture().issues[0];
  issue.checkpoint!.revision = 'revision-one';
  issue.validationPolicy = {
    risk: 'low',
    requiredGates: ['code-adversary'],
    sources: ['test'],
    revision: 'revision-one',
    baseRevision: 'base-one',
    changedPaths: [],
    selectedAt: 1,
    history: [],
  };
  issue.evidenceRevision = 'revision-one';
  issue.evidenceManifests = recordTaskEvidence(
    [],
    'revision-one',
    issue.checkpoint!.acceptanceCriteria,
    {
      id: 'current-command',
      kind: 'command',
      name: 'npm test',
      provider: 'codex',
      model: 'test',
      result: 'passed',
      timestamp: 20,
      outputReference: 'terminal:test',
      criteria: [],
    },
    'base-two',
  );
  issue.gates = [
    {
      ...gateSnapshot(validationReceipt())!,
      state: 'completed',
      verdict: 'CLEAN',
      evidenceTimestamp: 10,
      evidenceOutputReference: 'thread:gate',
    },
  ];

  const recovered = recoverValidationEvidence(issue, 'base-two');

  assert.equal(recovered, null);
  assert.equal(issue.evidenceManifests[0].baseRevision, 'base-two');
  assert.equal(issue.evidenceManifests[0].stale, false);
  assert.equal(
    issue.evidenceManifests.some((manifest) => manifest.baseRevision === 'base-one'),
    false,
  );
});

void test('sequential reservations remain unique before validation launch awaits', () => {
  const first = nextValidationReservation([], []);
  const firstReceipt = validationReceipt();
  firstReceipt.validation = { ...firstReceipt.validation!, ...first };

  const second = nextValidationReservation([gateSnapshot(firstReceipt)!], []);

  assert.deepEqual(first, { sequence: 0, evidenceSequence: 1 });
  assert.deepEqual(second, { sequence: 1, evidenceSequence: 2 });
});

void test('concurrent inline FAIL then PASS keeps PASS latest at the same millisecond', () => {
  const reservations = new Map<string, { sequence: number; evidenceSequence: number }>();
  const first = reserveInlineValidation(reservations, 'run:issue', [], []);
  const second = reserveInlineValidation(reservations, 'run:issue', [], []);
  assert.deepEqual(first, { sequence: 0, evidenceSequence: 1 });
  assert.deepEqual(second, { sequence: 1, evidenceSequence: 2 });

  const criterion = 'The result is verified.';
  const attempt = (id: string, result: 'passed' | 'failed', sequence: number) => ({
    id,
    kind: 'gate' as const,
    name: 'test-adversary',
    provider: 'codex',
    model: 'test',
    result,
    timestamp: 100,
    sequence,
    outputReference: `thread:${id}`,
    criteria: [criterion],
  });
  let manifests = recordTaskEvidence(
    [],
    'revision',
    [criterion],
    attempt('pass', 'passed', second.evidenceSequence),
    'base',
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    [criterion],
    attempt('fail', 'failed', first.evidenceSequence),
    'base',
  );
  const readiness = evidenceReadiness(
    manifests,
    'revision',
    ['test-adversary'],
    [criterion],
    'base',
  );
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.failedGates, []);
});

void test('validation rollback preserves concurrently recorded command and CI evidence', () => {
  const issue = fixture().issues[0];
  issue.checkpoint!.revision = 'revision-one';
  issue.evidenceRevision = 'revision-one';
  issue.evidenceManifests = recordTaskEvidence(
    [],
    'revision-one',
    issue.checkpoint!.acceptanceCriteria,
    {
      id: 'ci-before',
      kind: 'command',
      name: 'ci:build',
      provider: 'github',
      model: null,
      result: 'passed',
      timestamp: 10,
      outputReference: 'https://example.test/build',
      criteria: [],
    },
    'base-one',
  );
  issue.events = [{ at: 1, stage: 'testing' }];
  const previous = structuredClone({
    evidenceRevision: issue.evidenceRevision,
    evidenceManifests: issue.evidenceManifests,
    stage: issue.stage,
    blockedReason: issue.blockedReason,
    gates: issue.gates,
    events: issue.events,
  });
  issue.evidenceManifests = recordTaskEvidence(
    issue.evidenceManifests,
    'revision-one',
    issue.checkpoint!.acceptanceCriteria,
    {
      id: 'gate:receipt',
      kind: 'gate',
      name: 'code-adversary',
      provider: 'codex',
      model: 'test',
      result: 'failed',
      timestamp: 20,
      sequence: 2,
      outputReference: 'thread:gate',
      criteria: [],
    },
    'base-one',
  );
  issue.blockedReason = 'Gate failed.';
  issue.events = [...issue.events, { at: 2, stage: 'code-adversary', reason: 'Gate failed.' }];
  const committed = structuredClone({
    evidenceRevision: issue.evidenceRevision,
    evidenceManifests: issue.evidenceManifests,
    stage: issue.stage,
    blockedReason: issue.blockedReason,
    gates: issue.gates,
    events: issue.events,
  });
  issue.evidenceManifests = recordTaskEvidence(
    issue.evidenceManifests,
    'revision-one',
    issue.checkpoint!.acceptanceCriteria,
    {
      id: 'command-during-store',
      kind: 'command',
      name: 'npm test',
      provider: 'codex',
      model: 'test',
      result: 'passed',
      timestamp: 30,
      outputReference: 'terminal:test',
      criteria: [],
    },
    'base-one',
  );
  issue.events = [...issue.events, { at: 3, stage: 'ci' }];

  const rolledBack = rollbackValidationIssue(issue, previous, committed, 'gate:receipt');

  assert.deepEqual(
    rolledBack.evidenceManifests?.[0].evidence.map((entry) => entry.id),
    ['ci-before', 'command-during-store'],
  );
  assert.equal(rolledBack.blockedReason, undefined);
  assert.deepEqual(
    rolledBack.events?.map((event) => event.stage),
    ['testing', 'ci'],
  );
});

void test('receipt recovery retains every required gate after one hundred commands', () => {
  const issue = fixture().issues[0];
  issue.checkpoint!.revision = 'revision-one';
  issue.checkpoint!.requiredGates = ['code-adversary', 'findings-adversary', 'test-adversary'];
  issue.validationPolicy = {
    risk: 'medium',
    requiredGates: issue.checkpoint!.requiredGates,
    sources: ['test'],
    revision: 'revision-one',
    baseRevision: 'base-one',
    changedPaths: [],
    selectedAt: 1,
    history: [],
  };
  let manifests = issue.evidenceManifests ?? [];
  for (let index = 1; index <= 100; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision-one',
      issue.checkpoint!.acceptanceCriteria,
      {
        id: `command-${index}`,
        kind: 'command',
        name: `command-${index}`,
        provider: 'codex',
        model: 'test',
        result: 'passed',
        timestamp: index,
        outputReference: `command:${index}`,
        criteria: [],
      },
      'base-one',
    );
  issue.evidenceRevision = 'revision-one';
  issue.evidenceManifests = manifests;
  issue.gates = issue.checkpoint.requiredGates.map((gate, index) => ({
    id: `gate-${index}`,
    gate,
    requestedModel: 'test',
    sequence: index + 1,
    revision: 'revision-one',
    baseRevision: 'base-one',
    provider: 'codex',
    model: 'test',
    threadId: `validator-${index}`,
    directory: '/worktree',
    state: 'completed',
    created: 200 + index,
    updated: 200 + index,
    error: null,
    verdict: gate === 'test-adversary' ? 'PASS' : 'CLEAN',
    evidenceCriteria: issue.checkpoint!.acceptanceCriteria,
    evidenceOutputReference: `thread:validator-${index}`,
    evidenceTimestamp: 200 + index,
  }));

  Object.assign(issue, recoverValidationEvidence(issue, 'base-one'));

  const gateEvidence = issue.evidenceManifests[0].evidence.filter((entry) => entry.kind === 'gate');
  assert.equal(gateEvidence.length, 3);
  assert.deepEqual(
    gateEvidence.map((entry) => entry.sequence),
    [101, 102, 103],
  );
  assert.equal(shipEvidenceReadiness(issue).ready, true);
  assert.equal(recoverValidationEvidence(issue, 'base-one'), null);
});

void test('validation generation fence detects edit restore ABA', async () => {
  const generations = ['clean', 'clean', 'edited-and-restored'];
  let committed = false;
  await assert.rejects(
    commitRevisionBoundValidation({
      expectedRevision: 'revision-one',
      expectedMutationGeneration: generations.shift(),
      readRevision: async () => 'revision-one',
      readMutationGeneration: async () => generations.shift()!,
      prepare: async () => 'PASS',
      commit: async () => {
        committed = true;
      },
    }),
    /worktree was modified during validation/,
  );
  assert.equal(committed, false);
});

void test('restores durable coordination claims', () => {
  const run = fixture();
  run.issues[0].claimFencePending = true;
  run.issues[0].claimRevalidationPending = true;
  run.issues[0].claimHandoffPending = true;
  run.issues[0].claim = {
    id: 'claim-1',
    instanceId: 'instance-a',
    holder: 'Sail codex (run)',
    task: 'ship:run:first',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active',
    takeoverOf: 'expired-claim',
    commentId: 99,
    commentUpdatedAtMillis: 1_780_827_660_000,
  };

  assert.equal(loadShipRuns(JSON.stringify([run]))[0].issues[0].claimFencePending, true);
  assert.equal(loadShipRuns(JSON.stringify([run]))[0].issues[0].claimRevalidationPending, true);
  assert.equal(loadShipRuns(JSON.stringify([run]))[0].issues[0].claimHandoffPending, true);
  assert.deepEqual(loadShipRuns(JSON.stringify([run]))[0].issues[0].claim, run.issues[0].claim);
  delete run.issues[0].claim.commentUpdatedAtMillis;
  assert.equal(
    loadShipRuns(JSON.stringify([run]))[0].issues[0].claim?.commentUpdatedAtMillis,
    undefined,
  );
});

void test('persists canonical task checkpoints with Ship runs', () => {
  const run = fixture();
  run.issues[0].checkpoint!.objective = 'Concrete objective';
  run.issues[0].checkpoint!.acceptanceCriteria = ['One observable result'];

  const restored = loadShipRuns(JSON.stringify([run]));

  assert.deepEqual(restored[0].issues[0].checkpoint, run.issues[0].checkpoint);
});

void test('persists bounded context handoff evidence with Ship runs', () => {
  const run = fixture();
  Object.assign(run.issues[0], {
    contextCompactions: { codex: 2 },
    contextEventIds: ['compaction-1'],
    contextPercent: 86,
    contextPercentByThread: { old: 86, child: 90 },
    handoffRecoveryRequired: true,
    retryCount: 1,
    lostStateFailures: 0,
    contextHandoffs: [
      {
        id: 'handoff-1',
        provider: 'codex',
        fromThreadId: 'old',
        toThreadId: 'new',
        context: 86,
        compactions: 2,
        checkpointSequence: 4,
        revision: 'abc',
        offeredAt: 10,
        startedAt: 11,
        retriesBefore: 1,
        lostStateFailuresBefore: 0,
        retriesAfter: null,
        lostStateFailuresAfter: null,
        outcome: 'pending',
        error: null,
      },
    ],
  });

  const restored = loadShipRuns(JSON.stringify([run]))[0].issues[0];

  assert.deepEqual(restored.contextCompactions, { codex: 2 });
  assert.equal(restored.contextHandoffs?.[0].toThreadId, 'new');
  assert.deepEqual(restored.contextPercentByThread, { old: 86, child: 90 });
  assert.equal(restored.handoffRecoveryRequired, true);
  assert.equal(restored.retryCount, 1);
});

void test('retires stale pending handoff offers during recovery', () => {
  const run = fixture();
  run.issues[0].threadId = 'current';
  run.issues[0].contextHandoffs = [
    {
      id: 'stale',
      provider: 'codex',
      fromThreadId: 'old',
      toThreadId: null,
      context: 90,
      compactions: 1,
      checkpointSequence: 2,
      revision: 'abc',
      offeredAt: 10,
      startedAt: null,
      retriesBefore: 0,
      lostStateFailuresBefore: 0,
      retriesAfter: null,
      lostStateFailuresAfter: null,
      outcome: 'pending',
      error: null,
    },
  ];

  const restored = loadShipRuns(JSON.stringify([run]))[0].issues[0].contextHandoffs?.[0];

  assert.equal(restored?.outcome, 'failed');
  assert.equal(restored?.error, 'Retired stale handoff offer during recovery.');
});

void test('normalizes legacy handoff reduction claims to no regression', () => {
  const run = fixture();
  const legacy = JSON.parse(JSON.stringify(run));
  legacy.issues[0].contextHandoffs = [
    {
      id: 'settled',
      provider: 'codex',
      fromThreadId: 'old',
      toThreadId: 'new',
      context: 90,
      compactions: 1,
      checkpointSequence: 2,
      revision: 'abc',
      offeredAt: 10,
      startedAt: 11,
      retriesBefore: 1,
      lostStateFailuresBefore: 0,
      retriesAfter: 1,
      lostStateFailuresAfter: 0,
      outcome: 'reduced',
      error: null,
    },
  ];

  const restored = loadShipRuns(JSON.stringify([legacy]));

  assert.equal(restored[0].issues[0].contextHandoffs?.[0].outcome, 'no_regression');
});

void test('checkpoint ownership follows same-worktree handoff ancestry', () => {
  const run = fixture();
  run.issues[0].path = '/worktree';
  run.issues[0].threadId = 'owner';
  assert.equal(
    authorizeShipCheckpointThread([run], '/worktree', 'owner', '/worktree', 'handoff'),
    true,
  );
  assert.equal(
    authorizeShipCheckpointThread([run], '/worktree', 'handoff', '/worktree', 'successor'),
    true,
  );

  assert.equal(shipCheckpointOwner([run], '/worktree', 'successor')?.issue.id, 'first');
  assert.equal(shipCheckpointOwner([run], '/worktree', 'unrelated'), undefined);
  assert.equal(shipCheckpointOwner([run], '/other', 'successor'), undefined);
  assert.equal(
    authorizeShipCheckpointThread([run], '/worktree', 'owner', '/other', 'foreign'),
    false,
  );
});

void test('worktree cleanup waits for every authorized checkpoint thread', () => {
  const issue = fixture().issues[0];
  issue.checkpointThreadIds = ['handoff'];
  issue.threadId = 'owner';
  issue.receiptId = 'owner-receipt';
  const receipts = [
    { receiptId: 'owner-receipt', targetId: 'owner', state: 'completed' as const },
    { receiptId: 'handoff-receipt', targetId: 'handoff', state: 'completed' as const },
  ];
  assert.equal(shipTaskThreadsSettled(issue, {}, []), false);
  assert.equal(
    shipTaskThreadsSettled(issue, { owner: 'working', handoff: 'completed' }, receipts),
    false,
  );
  assert.equal(
    shipTaskThreadsSettled(issue, { owner: 'completed', handoff: 'working' }, receipts),
    false,
  );
  assert.equal(
    shipTaskThreadsSettled(issue, { owner: 'completed', handoff: 'completed' }, [
      receipts[0],
      { ...receipts[1], state: 'starting' },
    ]),
    false,
  );
  assert.equal(shipTaskThreadsSettled(issue, {}, receipts), true);
});

void test('persists the selected revision-bound validation policy', () => {
  const run = fixture();
  run.issues[0].shippingTarget = {
    repository: 'a/b',
    remote: 'upstream',
    baseBranch: 'main',
    baseRef: 'refs/remotes/upstream/main',
    baseRevision: 'base-one',
  };
  run.issues[0].validationPolicy = {
    risk: 'high',
    requiredGates: ['code-adversary', 'findings-adversary', 'test-adversary'],
    sources: ['path rule src-tauri/**: high (src-tauri/src/lib.rs)'],
    revision: 'revision-one',
    changedPaths: ['src-tauri/src/lib.rs'],
    selectedAt: 10,
    history: [
      {
        requestedRisk: 'medium',
        selectedRisk: 'high',
        sources: ['path rule src-tauri/**: high (src-tauri/src/lib.rs)'],
        at: 10,
      },
    ],
  };

  const restored = loadShipRuns(JSON.stringify([run]));

  assert.deepEqual(restored[0].issues[0].validationPolicy, run.issues[0].validationPolicy);
  assert.deepEqual(restored[0].issues[0].shippingTarget, run.issues[0].shippingTarget);
});

void test('late retired-worker children block cleanup without restoring retired checkpoint authority', () => {
  const run = fixture();
  const issue = run.issues[0];
  issue.path = '/worktree';
  issue.threadId = 'new';
  issue.receiptId = 'new-receipt';
  issue.contextHandoffs = [
    {
      id: 'handoff-1',
      provider: 'codex',
      fromThreadId: 'old',
      toThreadId: 'new',
      context: 86,
      compactions: 0,
      checkpointSequence: 2,
      revision: 'abc',
      offeredAt: 10,
      startedAt: 11,
      retriesBefore: 0,
      lostStateFailuresBefore: 0,
      retriesAfter: null,
      lostStateFailuresAfter: null,
      outcome: 'pending',
      error: null,
    },
  ];
  const receipts = [
    { receiptId: 'old-receipt', targetId: 'old', state: 'completed' as const },
    { receiptId: 'new-receipt', targetId: 'new', state: 'completed' as const },
  ];
  const lateChild = {
    receiptId: 'native:codex:late-child',
    sourceId: 'old',
    sourceDirectory: '/worktree',
    targetId: 'late-child',
    targetDirectory: '/worktree',
    state: 'working' as const,
  };

  assert.equal(shipCheckpointOwner([run], '/worktree', 'old'), undefined);
  assert.equal(
    authorizeShipCheckpointThread([run], '/worktree', 'old', '/worktree', 'late-child'),
    false,
  );
  assert.equal(shipCheckpointOwner([run], '/worktree', 'late-child'), undefined);
  assert.equal(
    shipTaskThreadsSettled(issue, { old: 'completed', new: 'completed', 'late-child': 'working' }, [
      ...receipts,
      lateChild,
    ]),
    false,
  );
  assert.equal(
    shipTaskThreadsSettled(
      issue,
      { old: 'completed', new: 'completed', 'late-child': 'completed' },
      [...receipts, { ...lateChild, state: 'completed' }],
    ),
    true,
  );
});

void test('post-handoff OpenCode descendants invalidate cleanup and block deletion while active', () => {
  const issue = fixture().issues[0];
  issue.path = '/worktree';
  issue.threadId = 'opencode:new';
  issue.receiptId = 'new-receipt';
  issue.contextHandoffs = [
    {
      id: 'handoff-1',
      provider: 'opencode',
      fromThreadId: 'opencode:old',
      toThreadId: 'opencode:new',
      context: 86,
      compactions: 0,
      checkpointSequence: 2,
      revision: 'abc',
      offeredAt: 10,
      startedAt: 11,
      retriesBefore: 0,
      lostStateFailuresBefore: 0,
      retriesAfter: null,
      lostStateFailuresAfter: null,
      outcome: 'pending',
      error: null,
    },
  ];
  const receipts = [
    {
      receiptId: 'old-receipt',
      targetId: 'opencode:old',
      state: 'completed' as const,
    },
    {
      receiptId: 'new-receipt',
      targetId: 'opencode:new',
      state: 'completed' as const,
    },
  ];
  const lateChild = 'opencode:late-child';

  assert.notEqual(
    shipOwnershipQuietGeneration(3, 5, []),
    shipOwnershipQuietGeneration(3, 5, [lateChild]),
  );
  assert.equal(
    shipTaskThreadsSettled(
      issue,
      {
        'opencode:old': 'completed',
        'opencode:new': 'completed',
        [lateChild]: 'working',
      },
      receipts,
      [lateChild],
    ),
    false,
  );
  assert.equal(
    shipTaskThreadsSettled(
      issue,
      {
        'opencode:old': 'completed',
        'opencode:new': 'completed',
        [lateChild]: 'completed',
      },
      receipts,
      [lateChild],
    ),
    true,
  );
});

void test('handoff ownership includes every authorized descendant exactly once', () => {
  const issue = fixture().issues[0];
  issue.path = '/worktree';
  issue.threadId = 'owner';
  issue.checkpointThreadIds = ['authorized', 'authorized'];
  const receipts = [
    {
      sourceId: 'owner',
      sourceDirectory: '/worktree',
      targetId: 'child',
      targetDirectory: '/worktree',
    },
    {
      sourceId: 'child',
      sourceDirectory: '/worktree',
      targetId: 'grandchild',
      targetDirectory: '/worktree',
    },
  ];

  assert.deepEqual(shipOwnedThreadIds(issue, receipts), [
    'owner',
    'authorized',
    'child',
    'grandchild',
  ]);
});

void test('handoff ownership includes provider-native descendants', () => {
  const issue = fixture().issues[0];
  issue.path = '/worktree';
  issue.threadId = 'acp:codex:owner';
  const native: NativeSubagentStore = {
    'codex:child': {
      id: 'codex:child',
      agent: 'codex',
      directory: '/worktree',
      sessionId: 'child',
      parentSessionId: 'owner',
      rootSessionId: 'owner',
      name: 'Child',
      task: 'Continue delegated work',
      outcome: 'working',
      activity: 'Working…',
      transcript: [],
      created: 1,
      updated: 2,
      restored: false,
    },
  };

  const owned = shipOwnedThreadIds(issue, nativeSubagentReceipts(native));

  assert.deepEqual(owned, ['acp:codex:owner', 'acp:codex:child']);
});

void test('provider-native descendants inherit checkpoint authorization', () => {
  const run = fixture();
  const issue = run.issues[0];
  issue.path = '/worktree';
  issue.threadId = 'acp:codex:owner';
  const native: NativeSubagentStore = {
    'codex:child': {
      id: 'codex:child',
      agent: 'codex',
      directory: '/worktree',
      sessionId: 'child',
      parentSessionId: 'owner',
      rootSessionId: 'owner',
      name: 'Child',
      task: 'Continue delegated work',
      outcome: 'working',
      activity: 'Working…',
      transcript: [],
      created: 1,
      updated: 2,
      restored: false,
    },
  };
  const receipt = nativeSubagentReceipts(native)[0];

  assert.equal(
    authorizeShipCheckpointThread(
      [run],
      receipt.sourceDirectory,
      receipt.sourceId,
      receipt.targetDirectory,
      receipt.targetId,
    ),
    true,
  );
  assert.equal(shipCheckpointOwner([run], '/worktree', 'acp:codex:child')?.issue, issue);
});

void test('handoff ownership expands descendants of retired handoff sources', () => {
  const issue = fixture().issues[0];
  issue.path = '/worktree';
  issue.threadId = 'replacement';
  issue.contextHandoffs = [
    {
      id: 'handoff-one',
      provider: 'codex',
      fromThreadId: 'retired-owner',
      toThreadId: 'replacement',
      context: 90,
      compactions: 0,
      checkpointSequence: 1,
      revision: 'revision',
      offeredAt: 1,
      startedAt: 2,
      retriesBefore: 0,
      lostStateFailuresBefore: 0,
      retriesAfter: null,
      lostStateFailuresAfter: null,
      outcome: 'pending',
      error: null,
    },
  ];
  const receipts = [
    {
      sourceId: 'retired-owner',
      sourceDirectory: '/worktree',
      targetId: 'late-child',
      targetDirectory: '/worktree',
    },
  ];

  assert.deepEqual(shipOwnedThreadIds(issue, receipts), [
    'replacement',
    'retired-owner',
    'late-child',
  ]);
});

void test('worktree cleanup waits for provider-native descendants', () => {
  const issue = fixture().issues[0];
  issue.path = '/worktree';
  issue.threadId = 'acp:codex:owner';
  issue.receiptId = 'owner-receipt';
  const receipts = [
    {
      receiptId: 'owner-receipt',
      sourceId: 'source',
      sourceDirectory: '/worktree',
      targetId: 'acp:codex:owner',
      targetDirectory: '/worktree',
      state: 'completed' as const,
    },
    {
      receiptId: 'native:codex:child',
      sourceId: 'acp:codex:owner',
      sourceDirectory: '/worktree',
      targetId: 'acp:codex:child',
      targetDirectory: '/worktree',
      state: 'working' as const,
    },
  ];

  assert.equal(
    shipTaskThreadsSettled(
      issue,
      { 'acp:codex:owner': 'completed', 'acp:codex:child': 'working' },
      receipts,
    ),
    false,
  );
  assert.equal(
    shipTaskThreadsSettled(
      issue,
      { 'acp:codex:owner': 'completed', 'acp:codex:child': 'completed' },
      [{ ...receipts[0] }, { ...receipts[1], state: 'completed' }],
    ),
    true,
  );
});

void test('ownership needs a generation-stable quiet pass', () => {
  assert.deepEqual(shipOwnershipQuietPass(null, 1, false), {
    settled: false,
    nextGeneration: 1,
  });
  assert.deepEqual(shipOwnershipQuietPass(1, 2, true), {
    settled: false,
    nextGeneration: null,
  });
  assert.deepEqual(shipOwnershipQuietPass(null, 2, false), {
    settled: false,
    nextGeneration: 2,
  });
  assert.deepEqual(shipOwnershipQuietPass(2, 2, false), {
    settled: true,
    nextGeneration: 2,
  });
  assert.deepEqual(shipOwnershipQuietPass(2, 3, false), {
    settled: false,
    nextGeneration: 3,
  });
});

void test('task settlement waits for every durable coordination dispatch', () => {
  const issue = fixture().issues[0];
  issue.path = '/repo/task';
  issue.threadId = 'opencode:owner';
  issue.receiptId = 'owner';

  assert.equal(
    shipTaskThreadsSettled(issue, { 'opencode:owner': 'unavailable' }, [
      {
        receiptId: 'owner',
        targetId: 'opencode:owner',
        targetDirectory: '/repo/task',
        state: 'completed',
      },
      {
        receiptId: 'coordination',
        targetId: 'opencode:owner',
        targetDirectory: '/repo/task',
        state: 'working',
        dispatchPending: true,
      },
    ]),
    false,
  );
});

void test('active task receipts and claims bypass the receipt bound', () => {
  const issue = fixture().issues[0];
  issue.path = '/repo/task';
  issue.threadId = 'opencode:owner';
  const terminal = Array.from({ length: 250 }, (_, index) => ({
    receiptId: `terminal-${index}`,
    targetId: 'opencode:owner',
    targetDirectory: '/repo/task',
    state: 'completed' as const,
  }));
  assert.deepEqual(
    shipTaskReceiptIdsToProtect(issue, [
      ...terminal,
      {
        receiptId: 'working',
        targetId: 'opencode:owner',
        targetDirectory: '/repo/task',
        state: 'working',
      },
      {
        receiptId: 'pending',
        targetId: 'opencode:owner',
        targetDirectory: '/repo/task',
        state: 'failed',
        dispatchPending: true,
      },
    ]),
    ['working', 'pending'],
  );
  assert.deepEqual(
    shipTaskReceiptIdsToProtect(
      { ...issue, receiptId: 'settled-owner', state: 'failed', workerSettled: true },
      [
        {
          receiptId: 'settled-owner',
          targetId: 'opencode:owner',
          targetDirectory: '/repo/task',
          state: 'failed',
        },
      ],
    ),
    [],
  );
  const activeClaim = {
    id: 'active-claim',
    instanceId: 'sail-a',
    holder: 'Sail',
    task: 'ship:run:first',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active' as const,
    commentId: 99,
  };
  assert.deepEqual(
    shipTaskReceiptIdsToProtect(
      {
        ...issue,
        receiptId: 'settled-owner',
        state: 'failed',
        workerSettled: true,
        claim: activeClaim,
      },
      [
        {
          receiptId: 'settled-owner',
          targetId: 'opencode:owner',
          targetDirectory: '/repo/task',
          state: 'failed',
        },
      ],
    ),
    ['settled-owner'],
  );
  assert.deepEqual(
    shipTaskReceiptIdsToProtect(
      {
        ...issue,
        path: null,
        receiptId: 'settled-owner',
        state: 'merged',
        workerSettled: true,
        claim: activeClaim,
      },
      [
        {
          receiptId: 'settled-owner',
          targetId: 'opencode:owner',
          targetDirectory: '/repo/task',
          state: 'completed',
        },
      ],
    ),
    ['settled-owner'],
  );
  assert.deepEqual(
    shipTaskReceiptIdsToProtect(
      { ...issue, receiptId: 'unsettled-owner', state: 'failed', workerSettled: false },
      [
        {
          receiptId: 'unsettled-owner',
          targetId: 'opencode:owner',
          targetDirectory: '/repo/task',
          state: 'failed',
        },
      ],
    ),
    ['unsettled-owner'],
  );
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
      ...withMergeEvidence(source),
      id: 'ready',
      number: 7,
      state: 'awaiting_merge',
      pullRequest: 'https://example.test/pull/7',
      pullRequestHead: 'commit-one',
      evidenceCommit: 'commit-one',
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

void test('merge readiness rejects missing, failed, and stale revision evidence', () => {
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
  assert.match(shipIssuePresentation(run, issue).nextAction, /Revision unknown/);
  assert.equal(shipMergeClaim(issue), 'PR open');

  const mergeEvidence = withMergeEvidence(issue);
  const manifest = mergeEvidence.evidenceManifests.at(-1)!;
  Object.assign(issue, {
    ...mergeEvidence,
    evidenceManifests: [
      { ...manifest, evidence: manifest.evidence.filter((entry) => entry.name !== 'ci:build') },
    ],
  });
  assert.equal(shipEvidenceReadiness(issue).ready, false);
  assert.match(shipEvidenceReadiness(issue).reason!, /Revision-bound CI evidence missing/);
  assert.equal(shipMergeClaim(issue), 'PR open');

  Object.assign(issue, mergeEvidence);
  assert.equal(shipEvidenceReadiness(issue).ready, true);
  const economics = summarizeTaskEconomics(
    issue.evidenceManifests ?? [],
    shipEvidenceReadiness(issue),
    issue.evidenceRevision,
  );
  assert.equal(economics.accepted, true);
  assert.equal(economics.economicsComplete, true);
  assert.equal(economics.totals.checks, issue.checkpoint.requiredGates.length + 1);
  assert.equal(shipIssuePresentation(run, issue).nextAction, 'Merge #2 to unblock 1 issue');
  assert.equal(shipIssuePresentation(run, issue).label, 'Ready to merge');
  assert.equal(shipMergeClaim(issue), 'Ready for merge');

  issue.refreshError = 'GitHub unavailable';
  assert.equal(shipEvidenceReadiness(issue).ready, false);
  assert.match(shipEvidenceReadiness(issue).reason!, /refresh failed/);
  assert.equal(shipMergeClaim(issue), 'PR open');
  issue.refreshError = null;

  issue.pullRequestHead = 'commit-two';
  assert.equal(shipEvidenceReadiness(issue).ready, false);
  assert.match(shipEvidenceReadiness(issue).reason!, /does not match/);
  assert.equal(shipMergeClaim(issue), 'PR open');
  issue.pullRequestHead = 'commit-one';

  issue.evidenceRevision = 'revision-two';
  assert.equal(shipEvidenceReadiness(issue).stale, true);
  assert.match(shipIssuePresentation(run, issue).nextAction, /missing or stale/);
  assert.equal(shipMergeClaim(issue), 'PR open');
});

void test('inline validation gates retain their current worktree revision', () => {
  const gate = completedInlineShipGate(
    {
      id: 'inline-gate',
      gate: 'test-adversary',
      requestedModel: 'implementation session',
      provider: 'codex',
      model: 'test',
      threadId: 'worker',
      directory: '/repo',
      error: null,
      verdict: 'PASS',
      revision: 'revision-current',
    },
    42,
  );

  assert.equal(gate.revision, 'revision-current');
  assert.equal(gate.state, 'completed');
});

void test('passing evidence cannot authorize merge after its validator fails', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, {
    ...withMergeEvidence(issue),
    state: 'awaiting_merge',
    pullRequest: 'https://example.test/pull/2',
    pullRequestHead: 'commit-one',
    evidenceCommit: 'commit-one',
    checks: [{ name: 'build', state: 'SUCCESS', url: 'https://example.test/build' }],
    validationPolicyRequired: true,
    validationPolicy: {
      risk: 'low',
      requiredGates: ['test-adversary'],
      sources: ['test'],
      revision: 'revision-one',
      changedPaths: [],
      selectedAt: 1,
      history: [],
    },
    gates: [
      {
        id: 'failed-validator',
        gate: 'test-adversary',
        requestedModel: 'test',
        provider: 'codex',
        model: 'test',
        threadId: 'validator',
        directory: '/repo',
        state: 'failed',
        created: 1,
        updated: 2,
        error: 'validator failed after reporting',
        verdict: 'PASS',
        revision: 'revision-one',
      },
    ],
  });

  assert.equal(shipEvidenceReadiness(issue).ready, false);
  assert.match(shipEvidenceReadiness(issue).reason!, /not completed/);
  assert.equal(shipMergeClaim(issue), 'PR open');
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
  const reviewEconomics = {
    ...emptyTaskEconomics('validator', 'review'),
    checks: 1,
  };
  const testEconomics = {
    ...emptyTaskEconomics('validator', 'test'),
    checks: 1,
  };
  assert.deepEqual(parseShipReport({ stage: 'ci', status: 'blocked', reason: 'Check failed' }), {
    stage: 'ci',
    status: 'blocked',
    reason: 'Check failed',
  });
  assert.deepEqual(parseShipReport({ verdict: 'CLEAN', economics: reviewEconomics }), {
    verdict: 'CLEAN',
    economics: reviewEconomics,
  });
  assert.deepEqual(
    parseShipReport({ gate: 'code-adversary', verdict: 'CLEAN', economics: reviewEconomics }),
    {
      gate: 'code-adversary',
      verdict: 'CLEAN',
      economics: reviewEconomics,
    },
  );
  const legacy = parseShipReport({ verdict: 'CLEAN' });
  assert.doesNotThrow(() => requireValidatorEconomics(legacy, true));
  assert.throws(() => requireValidatorEconomics(legacy, false));
  assert.throws(() =>
    parseShipReport({
      verdict: 'CLEAN',
      economics: { ...emptyTaskEconomics('primary', 'review'), checks: 1 },
    }),
  );
  assert.throws(() => validateGateVerdict('code-adversary', 'PASS'));
  assert.throws(() => validateGateVerdict('test-adversary', 'CLEAN'));
  assert.doesNotThrow(() => validateGateVerdict('test-adversary', 'PASS'));
  assert.doesNotThrow(() => validateGateVerdict('test-adversary', 'PASS (partial)'));
  assert.deepEqual(
    parseShipReport({
      gate: 'test-adversary',
      verdict: 'PASS (partial)',
      economics: testEconomics,
    }),
    {
      gate: 'test-adversary',
      verdict: 'PASS (partial)',
      economics: testEconomics,
    },
  );
});

void test('validation revision drift remains sticky after the tree returns', () => {
  const validation = {
    gate: 'code-adversary' as const,
    requestedModel: 'test',
    revision: 'revision-a',
  };
  assert.equal(validationRevisionDrifted(validation, 'revision-a'), false);
  assert.equal(validationRevisionDrifted(validation, 'revision-b'), true);
  assert.equal(
    validationRevisionDrifted({ ...validation, revisionDrifted: true }, 'revision-a'),
    true,
  );
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
      headRefOid: 'head',
      checks: [{ name: 'build', state: 'SUCCESS', url: issue.checks![0].url }],
    }),
  );
  assert.equal(ciStatus(restored.checks), 'Passed');
  assert.equal(restored.pullRequestHead, 'head');
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

void test('only the latest overlapping pull request refresh can commit', () => {
  const generations = new Map<string, number>();
  const first = beginLatestRefresh(generations, 'run:issue');
  const second = beginLatestRefresh(generations, 'run:issue');

  assert.equal(first(), false);
  assert.equal(second(), true);
  assert.equal(beginLatestRefresh(generations, 'other:issue')(), true);
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

type FixtureIssue = ReturnType<typeof fixture>['issues'][number];

function stateGate(
  gate: 'code-adversary' | 'findings-adversary' | 'test-adversary',
  verdict: 'CLEAN' | 'NEEDS_FIXES' | 'PASS' | 'FAIL' | 'BLOCKED',
  updated: number,
  reason?: string,
) {
  return {
    id: `${gate}-${updated}`,
    gate,
    requestedModel: 'test',
    provider: 'codex',
    model: 'test',
    threadId: `thread-${updated}`,
    directory: '/repo',
    state: 'completed' as const,
    created: updated,
    updated,
    error: null,
    verdict,
    ...(reason ? { reason } : {}),
  };
}

function runningIssue(overrides: Partial<FixtureIssue> = {}) {
  const run = fixture();
  const issue = Object.assign(run.issues[0], {
    state: 'working' as const,
    workerState: 'working' as const,
    stage: 'reviewing',
    ...overrides,
  });
  return { run, issue };
}

function readyIssue(overrides: Partial<FixtureIssue> = {}) {
  const run = fixture();
  const evidence = withMergeEvidence(run.issues[0]);
  const issue = Object.assign(run.issues[0], evidence, {
    state: 'awaiting_merge' as const,
    pullRequest: 'https://example.test/pull/2',
    pullRequestHead: 'commit-one',
    pullRequestState: 'OPEN',
    pullRequestMergeable: true,
    evidenceCommit: 'commit-one',
    checks: [{ name: 'build', state: 'SUCCESS', url: 'https://example.test/build' }],
    ...overrides,
  });
  issue.checkpoint = { ...issue.checkpoint!, revision: 'commit-one' };
  run.issues[1].dependsOn = [];
  return { run, issue };
}

void test('NEEDS_FIXES and FAIL verdicts show the running worker as fixing', () => {
  const { run, issue } = runningIssue({
    gates: [stateGate('code-adversary', 'NEEDS_FIXES', 10, 'Handle the empty list')],
  });
  const presentation = shipIssuePresentation(run, issue);
  assert.equal(presentation.label, 'Fixing · round 1');
  assert.equal(presentation.status, 'fixing');
  assert.equal(presentation.priority, 1);
  assert.equal(shipStatus(run, issue), 'Fixing');
  assert.equal(shipActivity(run, issue).title, 'Fixing · round 1');
  assert.equal(shipActivity(run, issue).state, 'active');

  issue.gates = [
    stateGate('code-adversary', 'NEEDS_FIXES', 10, 'First'),
    stateGate('code-adversary', 'CLEAN', 20),
    stateGate('test-adversary', 'FAIL', 30, 'Second'),
  ];
  assert.equal(shipIssuePresentation(run, issue).label, 'Fixing · round 2');

  issue.gates = [
    stateGate('code-adversary', 'NEEDS_FIXES', 10, 'First'),
    stateGate('code-adversary', 'CLEAN', 20),
  ];
  assert.equal(shipIssuePresentation(run, issue).label, 'Working');
});

void test('a failed gate does not show fixing once the worker stopped running', () => {
  const { run, issue } = runningIssue({
    gates: [stateGate('code-adversary', 'NEEDS_FIXES', 10, 'Handle the empty list')],
    workerState: 'waiting',
  });
  assert.equal(shipIssuePresentation(run, issue).label, 'Needs input');
});

void test('a worker blocked report shows needs input with the checkpoint blocker', () => {
  const { run, issue } = runningIssue({
    reportedStatus: 'blocked',
    blockedReason: 'Progress message',
  });
  assert.deepEqual(
    {
      label: shipIssuePresentation(run, issue).label,
      reason: shipIssuePresentation(run, issue).reason,
      priority: shipIssuePresentation(run, issue).priority,
    },
    { label: 'Needs input', reason: 'Progress message', priority: 0 },
  );
  issue.checkpoint = {
    ...issue.checkpoint!,
    status: 'blocked',
    blocker: 'Convergence budget exhausted',
    nextAction: 'Decide how to continue',
  };
  const presentation = shipIssuePresentation(run, issue);
  assert.equal(presentation.reason, 'Convergence budget exhausted');
  assert.equal(presentation.nextAction, 'Convergence budget exhausted');
  assert.equal(shipStatus(run, issue), 'Blocked');
  assert.equal(shipActivity(run, issue).detail, 'Convergence budget exhausted');

  issue.reportedStatus = 'running';
  issue.blockedReason = null;
  issue.checkpoint = { ...issue.checkpoint, status: 'active', blocker: null };
  assert.equal(shipIssuePresentation(run, issue).label, 'Working');
});

void test('a BLOCKED gate verdict needs input even while the worker runs', () => {
  const { run, issue } = runningIssue({
    gates: [stateGate('test-adversary', 'BLOCKED', 10, 'No sandbox available')],
  });
  const presentation = shipIssuePresentation(run, issue);
  assert.equal(presentation.label, 'Needs input');
  assert.equal(presentation.reason, 'No sandbox available');
});

void test('a persisted legacy blockedReason with a NEEDS_FIXES verdict shows fixing', () => {
  const { run, issue } = runningIssue({
    blockedReason: 'Handle the empty list',
    gates: [stateGate('code-adversary', 'NEEDS_FIXES', 10, 'Handle the empty list')],
  });
  assert.equal(shipIssuePresentation(run, issue).label, 'Fixing · round 1');
  assert.equal(shipStatus(run, issue), 'Fixing');
  assert.equal(shipActivity(run, issue).state, 'active');

  issue.gates = [stateGate('test-adversary', 'FAIL', 10, 'Handle the empty list')];
  assert.equal(shipIssuePresentation(run, issue).label, 'Fixing · round 1');

  issue.gates = [];
  assert.equal(shipIssuePresentation(run, issue).label, 'Needs input');
});

void test('a real Sail block stays a block next to a failing verdict', () => {
  const { run, issue } = runningIssue({
    blockedReason: 'Shipping claim lost: heartbeat verification failed',
    gates: [stateGate('code-adversary', 'NEEDS_FIXES', 10, 'Handle the empty list')],
  });
  const presentation = shipIssuePresentation(run, issue);
  assert.equal(presentation.label, 'Needs input');
  assert.equal(presentation.reason, 'Shipping claim lost: heartbeat verification failed');
  assert.equal(shipStatus(run, issue), 'Blocked');
});

void test('status, activity and presentation agree on fixing CI after awaiting merge was reported', () => {
  const { run, issue } = readyIssue({
    state: 'working',
    workerState: 'working',
    stage: 'awaiting_merge',
    checks: [{ name: 'build', state: 'FAILURE', url: 'https://example.test/build' }],
  });
  assert.equal(shipIssuePresentation(run, issue).label, 'Fixing (CI)');
  assert.equal(shipStatus(run, issue), 'Fixing');
  assert.equal(shipActivity(run, issue).title, 'Fixing (CI)');
});

void test('a worker block stays a block next to a failing verdict', () => {
  const { run, issue } = runningIssue({
    reportedStatus: 'blocked',
    blockedReason: 'Needs a decision',
    gates: [stateGate('code-adversary', 'NEEDS_FIXES', 10, 'Handle the empty list')],
  });
  assert.equal(shipIssuePresentation(run, issue).label, 'Needs input');
  assert.equal(shipIssuePresentation(run, issue).reason, 'Needs a decision');
});

void test('failing CI shows fixing only while the worker runs', () => {
  const failing = [{ name: 'build', state: 'FAILURE', url: 'https://example.test/build' }];
  const { run, issue } = runningIssue({ checks: failing, stage: 'ci' });
  assert.equal(shipIssuePresentation(run, issue).label, 'Fixing (CI)');
  assert.equal(shipStatus(run, issue), 'Fixing');

  const finished = readyIssue({ checks: failing });
  assert.equal(shipIssuePresentation(finished.run, finished.issue).label, 'Recovery needed');
});

void test('a pull request without required checks reaches ready to merge', () => {
  const { run, issue } = readyIssue({ checks: [] });
  assert.equal(ciStatus(issue.checks), 'No checks');
  const presentation = shipIssuePresentation(run, issue);
  assert.deepEqual(
    [presentation.status, presentation.label, presentation.priority, presentation.nextAction],
    ['ready', 'Ready to merge', 0, 'Merge the pull request'],
  );
  assert.equal(shipMergeClaim(issue), 'Ready for merge');
});

void test('ready to merge needs an open mergeable pull request at the checkpoint revision', () => {
  const cases: Array<[string, Partial<FixtureIssue>]> = [
    ['closed', { pullRequestState: 'CLOSED' }],
    ['not mergeable', { pullRequestMergeable: false }],
    ['mergeability unknown', { pullRequestMergeable: null }],
    ['pending checks', { checks: [{ name: 'build', state: 'PENDING', url: 'https://x.test' }] }],
    ['head moved', { pullRequestHead: 'commit-two' }],
  ];
  for (const [name, overrides] of cases) {
    const { run, issue } = readyIssue(overrides);
    assert.notEqual(shipIssuePresentation(run, issue).label, 'Ready to merge', name);
  }
  const { run, issue } = readyIssue();
  issue.checkpoint = { ...issue.checkpoint!, revision: 'commit-two' };
  assert.notEqual(shipIssuePresentation(run, issue).label, 'Ready to merge');
});

void test('ready to merge is a user item only when the user merges', () => {
  const { run, issue } = readyIssue();
  assert.equal(shipIssuePresentation(run, issue, { mergeOwner: 'you' }).label, 'Ready to merge');
  assert.equal(shipIssuePresentation(run, issue).label, 'Ready to merge');
  const agent = shipIssuePresentation(run, issue, { mergeOwner: 'agent' });
  assert.equal(agent.label, 'Awaiting merge');
});

void test('a reported awaiting_merge stage is accepted and presented before the worker exits', () => {
  assert.deepEqual(parseShipReport({ stage: 'awaiting_merge', status: 'running' }), {
    stage: 'awaiting_merge',
    status: 'running',
  });
  const { run, issue } = readyIssue({ state: 'working', stage: 'awaiting_merge' });
  assert.equal(shipIssuePresentation(run, issue).label, 'Ready to merge');
});

void test('a ready dependency names the issues its merge unblocks', () => {
  const { run, issue } = readyIssue();
  assert.equal(shipIssuePresentation(run, issue).nextAction, 'Merge the pull request');
  run.issues[1].dependsOn = ['first'];
  assert.equal(
    shipIssuePresentation(run, issue).nextAction,
    `Merge #${issue.number} to unblock 1 issue`,
  );
  run.issues.push({ ...run.issues[1], id: 'third', number: 4 });
  assert.equal(
    shipIssuePresentation(run, issue).nextAction,
    `Merge #${issue.number} to unblock 2 issues`,
  );
});

void test('a pull request closed without merging is its own state', () => {
  const { run, issue } = readyIssue();
  Object.assign(
    issue,
    refreshedPullRequest(issue, {
      url: 'https://example.test/pull/2',
      state: 'CLOSED',
      mergedAt: null,
      headRefOid: 'commit-one',
      mergeable: null,
      checks: [],
    }),
  );
  assert.equal(issue.pullRequestState, 'CLOSED');
  const presentation = shipIssuePresentation(run, issue);
  assert.deepEqual(
    [presentation.status, presentation.label, presentation.priority],
    ['interrupted', 'Closed without merge', 0],
  );
  assert.match(presentation.nextAction, /Archive/);
  assert.match(presentation.nextAction, /reopen/i);
  assert.equal(shipStatus(run, issue), 'Closed without merge');

  Object.assign(issue, { state: 'failed', error: 'Pull request closed without merging.' });
  assert.equal(shipIssuePresentation(run, issue).label, 'Closed without merge');
  assert.equal(shipActivity(run, issue).title, 'Closed without merge');
});

void test('a merged pull request is never shown as closed without merge', () => {
  const { run, issue } = readyIssue();
  Object.assign(
    issue,
    refreshedPullRequest(issue, {
      url: 'https://example.test/pull/2',
      state: 'MERGED',
      mergedAt: '2026-01-01T00:00:00Z',
      headRefOid: 'commit-one',
      checks: [],
    }),
  );
  assert.equal(shipIssuePresentation(run, issue).label, 'Completed');
});

void test('refreshing a pull request records its state and mergeability', () => {
  const { issue } = readyIssue();
  const changes = refreshedPullRequest(issue, {
    url: 'https://example.test/pull/2',
    state: 'OPEN',
    mergedAt: null,
    headRefOid: 'commit-one',
    mergeable: true,
    checks: [],
  });
  assert.equal(changes.pullRequestState, 'OPEN');
  assert.equal(changes.pullRequestMergeable, true);
  assert.equal(
    refreshedPullRequest(issue, {
      url: 'https://example.test/pull/2',
      state: 'OPEN',
      mergedAt: null,
      headRefOid: 'commit-one',
      checks: [],
    }).pullRequestMergeable,
    null,
  );
});

void test('a merge request marker lasts until a refresh sees the pull request closed', () => {
  const { issue } = readyIssue();
  const open = {
    url: 'https://example.test/pull/2',
    state: 'OPEN',
    mergedAt: null,
    headRefOid: 'commit-one',
    checks: [],
  };
  issue.mergeRequested = { at: 1, head: 'commit-one', comment: 'squash' };
  Object.assign(issue, refreshedPullRequest(issue, open));
  assert.equal(issue.mergeRequested?.comment, 'squash');
  Object.assign(issue, refreshedPullRequest(issue, null));
  assert.equal(issue.mergeRequested?.comment, 'squash');
  const [restored] = loadShipRuns(JSON.stringify([{ ...fixture(), issues: [issue] }]))[0].issues;
  assert.deepEqual(restored.mergeRequested, { at: 1, head: 'commit-one', comment: 'squash' });
  for (const state of ['CLOSED', 'MERGED']) {
    const closed = { ...issue };
    Object.assign(
      closed,
      refreshedPullRequest(closed, {
        ...open,
        state,
        mergedAt: state === 'MERGED' ? '2026-01-01T00:00:00Z' : null,
      }),
    );
    assert.equal(closed.mergeRequested, undefined, state);
  }
});

void test('an issue closed before launch is closed, not failed', () => {
  const run = fixture();
  const issue = run.issues[0];
  Object.assign(issue, refreshedIssueState(issue, true));
  const presentation = shipIssuePresentation(run, issue);
  assert.deepEqual(
    [presentation.status, presentation.label, presentation.priority],
    ['completed', 'Closed', 4],
  );
  assert.equal(shipStatus(run, issue), 'Closed');
  assert.equal(shipActivity(run, issue).state, 'complete');

  issue.error = 'Worker failed';
  assert.equal(shipIssuePresentation(run, issue).label, 'Recovery needed');
});

void test('waiting and failed dependencies show different labels', () => {
  const run = fixture();
  const [first, second] = run.issues;
  const waiting = shipIssuePresentation(run, second);
  assert.deepEqual(
    [waiting.status, waiting.label, waiting.priority, waiting.link],
    ['queued', 'Waiting on #2', 3, { label: '#2', url: 'https://github.com/a/b/issues/2' }],
  );

  first.state = 'failed';
  first.error = 'Worker failed';
  const failed = shipIssuePresentation(run, second);
  assert.deepEqual(
    [failed.status, failed.label, failed.priority, failed.link],
    [
      'waiting',
      'Waiting on #2 (needs input)',
      0,
      { label: '#2', url: 'https://github.com/a/b/issues/2' },
    ],
  );
  assert.equal(shipStatus(run, second), 'Blocked');

  first.state = 'merged';
  assert.equal(shipIssuePresentation(run, second).label, 'Queued');
});

void test('a failed dependency wins over an unmerged one', () => {
  const run = fixture();
  const [first, second] = run.issues;
  run.issues.push({
    ...second,
    id: 'third',
    number: 4,
    dependsOn: ['first', 'second'],
  });
  first.state = 'working';
  second.state = 'failed';
  second.error = 'Worker failed';
  assert.equal(shipIssuePresentation(run, run.issues[2]).label, 'Waiting on #3 (needs input)');
});

void test('repairs a dead run repository from the catalog checkout with the same remote', () => {
  const candidates = [
    { path: '/other', remote: 'kumahq/other' },
    { path: '/broken', remote: null },
    { path: '/kuma', remote: 'Kumahq/Kuma' },
  ];
  assert.equal(repositoryForRemote(candidates, 'kumahq/kuma'), '/kuma');
  assert.equal(repositoryForRemote(candidates, 'kong/kong-mesh'), null);
  assert.equal(repositoryForRemote([], 'kumahq/kuma'), null);
  const clones = [
    { path: '/a/kuma', remote: 'kumahq/kuma' },
    { path: '/b/kuma', remote: 'kumahq/kuma' },
  ];
  assert.equal(repositoryForRemote(clones, 'kumahq/kuma', '/b/kuma'), '/b/kuma');
  assert.equal(repositoryForRemote(clones, 'kumahq/kuma', '/c/other'), '/a/kuma');
});

void test('treats a vanished agent session or deleted worktree as a gone worker', () => {
  assert.equal(shippingWorkerGone(new Error('Agent session is not connected.')), true);
  assert.equal(shippingWorkerGone('Location not found: /sail/worktrees/gone'), true);
  assert.equal(shippingWorkerGone(new Error('permission denied')), false);
});

void test('replaces the persisted missing-repository block reason', () => {
  assert.equal(
    currentShipBlockedReason(
      'Shipping claim recovery failed: Repository path does not exist. Choose an existing directory.',
    ),
    'Shipping worktree no longer exists. Start a new run from the project.',
  );
  assert.equal(currentShipBlockedReason('Worker paused.'), 'Worker paused.');
  assert.equal(currentShipBlockedReason(null), 'Shipping claim recovery requires worker fencing.');
});

void test('plans how to settle issues of a run whose repository is gone', () => {
  const settled = { state: 'failed' as const, workerSettled: true, worktreeUnavailable: true };
  assert.equal(unrecoverableIssuePlan(settled), 'none');
  assert.equal(unrecoverableIssuePlan({ ...settled, refreshError: 'Claim: boom' }), 'clear');
  assert.equal(unrecoverableIssuePlan({ ...settled, worktreeUnavailable: false }), 'clear');
  assert.equal(
    unrecoverableIssuePlan({ ...settled, state: 'merged', claimFencePending: true }),
    'clear',
  );
  assert.equal(unrecoverableIssuePlan({ state: 'merged' }), 'none');
  assert.equal(unrecoverableIssuePlan({ state: 'awaiting_merge', workerSettled: true }), 'none');
  assert.equal(unrecoverableIssuePlan({ state: 'awaiting_merge', workerSettled: false }), 'none');
  assert.equal(unrecoverableIssuePlan({ state: 'working', workerSettled: false }), 'fail');
  assert.equal(unrecoverableIssuePlan({ state: 'failed', workerSettled: false }), 'fail');
});

void test('reads the message of error-like objects when matching a gone worker', () => {
  assert.equal(shippingWorkerGone({ message: 'Agent session is not connected.' }), true);
  assert.equal(shippingWorkerGone({ message: 'denied' }), false);
  assert.equal(shippingWorkerGone(null), false);
});

void test('waits ten minutes before failing work in a vanished repository', () => {
  assert.equal(unrecoverableGraceExpired(1_000, 1_000 + 9 * 60_000), false);
  assert.equal(unrecoverableGraceExpired(1_000, 1_000 + 10 * 60_000), true);
});

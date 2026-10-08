import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitRevisionBoundEvidence,
  ciEvidenceIdentity,
  evidenceReadiness,
  evidenceManifestsSchema,
  mergeEvidenceManifests,
  nextTaskEvidenceSequence,
  readStableEvidenceBoundary,
  requireEvidenceBaseRevision,
  requireEvidenceExecutionBoundary,
  requireEvidenceRevision,
  reconcileCiEvidenceSnapshot,
  recordTaskEvidence,
  rollbackTaskEvidenceRecord,
  recordCiEvidenceObservation,
  syncEvidenceManifest,
  type EvidenceManifest,
  type TaskEvidence,
} from '../src/lib/task-evidence.ts';
import {
  emptyTaskEconomics,
  emptyEconomicsRollup,
  evidenceIdentityDigest,
  rekeyArchivedEconomicsEvidence,
  rollUpEconomics,
  summarizeTaskEconomics,
  syntheticCiEconomics,
} from '../src/lib/task-economics.ts';

const criteria = ['The result is revision-bound.', 'Unverified criteria stay visible.'];

function evidence(overrides: Partial<TaskEvidence> = {}): TaskEvidence {
  return {
    id: 'evidence-1',
    kind: 'gate',
    name: 'code-adversary',
    provider: 'codex',
    model: 'gpt-test',
    result: 'passed',
    timestamp: 20,
    outputReference: 'thread:review',
    criteria: [criteria[0]],
    ...overrides,
  };
}

function measuredEvidence(id: string, timestamp: number): TaskEvidence {
  return evidence({
    id,
    kind: 'command',
    name: id,
    timestamp,
    criteria: [],
    economics: { ...emptyTaskEconomics('primary', 'implement'), turns: 1 },
  });
}

function ciEvidence(
  check: Parameters<typeof ciEvidenceIdentity>[1],
  result: TaskEvidence['result'],
  timestamp: number,
): TaskEvidence {
  const identity = ciEvidenceIdentity('revision', check);
  return {
    id: identity.id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result,
    timestamp,
    outputReference: check.url || 'https://github.test/pull/1',
    criteria: [],
    economics: {
      ...syntheticCiEconomics(),
      failedCommands: result === 'failed' ? 1 : 0,
    },
    identityUncertain: identity.uncertain,
    reconciliationKey: identity.reconciliationKey,
    executionOrder: identity.executionOrder,
  };
}

void test('creates one current manifest and invalidates earlier revisions', () => {
  const first = recordTaskEvidence([], 'revision-one', criteria, evidence());
  const second = syncEvidenceManifest(first, 'revision-two', criteria, 30);

  assert.equal(second.length, 2);
  assert.equal(second[0].revision, 'revision-one');
  assert.equal(second[0].stale, true);
  assert.equal(second[1].revision, 'revision-two');
  assert.equal(second[1].stale, false);
  assert.deepEqual(second[1].evidence, []);
});

void test('a base move stales every kind of evidence without changing the worktree revision', () => {
  let manifests = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence({ id: 'command', kind: 'command', name: 'npm test', criteria }),
    'base-one',
  );
  manifests = syncEvidenceManifest(manifests, 'revision', criteria, 30, 'base-two');
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({ id: 'new-gate', criteria: [] }),
    'base-two',
  );

  assert.equal(manifests.find((manifest) => manifest.baseRevision === 'base-one')?.stale, true);
  assert.deepEqual(
    evidenceReadiness(manifests, 'revision', ['code-adversary'], criteria, 'base-two'),
    {
      ready: false,
      stale: false,
      missingGates: [],
      failedGates: [],
      pendingGates: [],
      failedCommands: [],
      pendingCommands: [],
      unverifiedCriteria: criteria,
      reason: '2 acceptance criteria remain unverified.',
    },
  );
});

void test('blocks readiness for stale, missing, failed, and unverified evidence', () => {
  let manifests = recordTaskEvidence([], 'revision-one', criteria, evidence());
  let readiness = evidenceReadiness(
    manifests,
    'revision-one',
    ['code-adversary', 'test-adversary'],
    criteria,
  );
  assert.deepEqual(readiness.missingGates, ['test-adversary']);
  assert.deepEqual(readiness.unverifiedCriteria, [criteria[1]]);
  assert.equal(readiness.ready, false);

  manifests = recordTaskEvidence(
    manifests,
    'revision-one',
    criteria,
    evidence({
      id: 'test-fail',
      name: 'test-adversary',
      result: 'failed',
      criteria: [criteria[1]],
    }),
  );
  readiness = evidenceReadiness(
    manifests,
    'revision-one',
    ['code-adversary', 'test-adversary'],
    criteria,
  );
  assert.deepEqual(readiness.failedGates, ['test-adversary']);
  assert.deepEqual(readiness.unverifiedCriteria, [criteria[1]]);

  manifests = syncEvidenceManifest(manifests, 'revision-two', criteria, 40);
  readiness = evidenceReadiness(manifests, 'revision-two', ['code-adversary'], criteria);
  assert.deepEqual(readiness.missingGates, ['code-adversary']);
  assert.deepEqual(readiness.unverifiedCriteria, criteria);
});

void test('rejects failed command evidence without a failed-command count', () => {
  assert.throws(
    () =>
      recordTaskEvidence(
        [],
        'revision',
        criteria,
        evidence({
          kind: 'command',
          name: 'npm test',
          result: 'failed',
          economics: {
            ...emptyTaskEconomics('primary', 'test'),
            toolCalls: 1,
          },
        }),
      ),
    /at least one failed command/,
  );
});

void test('preserves a CI execution failure cost after a passing observation', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/1',
    databaseId: 50,
    runId: 10,
  };
  let manifests = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence(check, 'failed', 10),
  );
  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(check, 'passed', 20),
  );

  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].result, 'passed');
  assert.equal(manifests[0].evidence[0].economics?.failedCommands, 1);
  assert.equal(
    summarizeTaskEconomics(manifests, { ready: true }, 'revision').totals.failedCommands,
    1,
  );
});

void test('latest result for each command or gate controls readiness', () => {
  let manifests = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence({ result: 'failed', criteria }),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({ id: 'evidence-2', result: 'passed', timestamp: 30, criteria }),
  );

  assert.deepEqual(evidenceReadiness(manifests, 'revision', ['code-adversary'], criteria), {
    ready: true,
    stale: false,
    missingGates: [],
    failedGates: [],
    pendingGates: [],
    failedCommands: [],
    pendingCommands: [],
    unverifiedCriteria: [],
    reason: null,
  });
});

void test('keeps repeated executions distinct and deduplicates only the same identity', () => {
  const first = evidence({ kind: 'command', name: 'npm test', criteria: [] });
  let manifests = recordTaskEvidence([], 'revision', criteria, first);
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({ id: 'second-execution', kind: 'command', name: 'npm test', criteria: [] }),
  );
  assert.equal(manifests[0].evidence.length, 2);

  manifests = recordTaskEvidence(manifests, 'revision', criteria, first);
  assert.equal(manifests[0].evidence.length, 2);
  assert.throws(
    () =>
      recordTaskEvidence(manifests, 'revision', criteria, evidence({ ...first, result: 'failed' })),
    /identity .* reused/,
  );
});

void test('allocates new sequences above archived rollup ranges', () => {
  const manifests = recordTaskEvidence([], 'revision', criteria, evidence());
  manifests[0].economicsRollup = {
    ...emptyEconomicsRollup(),
    archivedSequenceRanges: [[200, 200]],
    archivedEntries: 1,
    missingSamples: 1,
    stateVersion: 0,
    stateDigest: null,
  };

  const updated = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({ id: 'after-archive' }),
  );
  assert.equal(updated[0].evidence.at(-1)?.sequence, 201);
});

void test('latest failed or pending command blocks readiness until it passes', () => {
  let manifests = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence({
      id: 'command-fail',
      kind: 'command',
      name: 'npm test',
      result: 'failed',
      criteria: [],
    }),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({ id: 'gate-pass', criteria, timestamp: 30 }),
  );

  let readiness = evidenceReadiness(manifests, 'revision', ['code-adversary'], criteria);
  assert.deepEqual(readiness.failedCommands, ['npm test']);
  assert.equal(readiness.ready, false);

  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({
      id: 'command-pass',
      kind: 'command',
      name: 'npm test',
      result: 'passed',
      timestamp: 40,
      criteria: [],
    }),
  );
  readiness = evidenceReadiness(manifests, 'revision', ['code-adversary'], criteria);
  assert.deepEqual(readiness.failedCommands, []);
  assert.equal(readiness.ready, true);
});

void test('bounded history preserves failed and pending commands until they pass', () => {
  let manifests = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence({
      id: 'failed-command',
      kind: 'command',
      name: 'npm test',
      result: 'failed',
      criteria: [],
    }),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({
      id: 'pending-command',
      kind: 'command',
      name: 'npm audit',
      result: 'pending',
      timestamp: 25,
      criteria: [],
    }),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({ id: 'required-gate', criteria, timestamp: 30 }),
  );
  for (let index = 0; index < 100; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      criteria,
      evidence({
        id: `unrelated-${index}`,
        kind: 'command',
        name: `unrelated-${index}`,
        timestamp: 40 + index,
        criteria: [],
      }),
    );

  const readiness = evidenceReadiness(manifests, 'revision', ['code-adversary'], criteria);

  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === 'failed-command'),
    true,
  );
  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === 'pending-command'),
    true,
  );
  assert.deepEqual(readiness.failedCommands, ['npm test']);
  assert.deepEqual(readiness.pendingCommands, ['npm audit']);
  assert.equal(readiness.ready, false);
});

void test('rejects unknown criteria and bounds manifests and entries', () => {
  assert.throws(
    () => recordTaskEvidence([], 'revision', criteria, evidence({ criteria: ['invented'] })),
    /unknown acceptance criteria/,
  );

  let manifests: EvidenceManifest[] = [];
  for (let index = 0; index < 25; index += 1)
    manifests = syncEvidenceManifest(manifests, `revision-${index}`, criteria, index);
  assert.equal(manifests.length, 20);

  for (let index = 0; index < 105; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision-24',
      criteria,
      evidence({
        id: `command-${index}`,
        kind: 'command',
        name: `command-${index}`,
        timestamp: 30 + index,
        criteria: [],
      }),
    );
  assert.equal(manifests.at(-1)?.evidence.length, 100);
});

void test('archives CI when gates and criterion proofs fill the evidence bound', () => {
  const boundedCriteria = Array.from({ length: 97 }, (_, index) => `criterion-${index}`);
  let manifests = boundedCriteria.reduce(
    (current, criterion, index) =>
      recordTaskEvidence(
        current,
        'revision',
        boundedCriteria,
        evidence({
          id: `criterion-proof-${index}`,
          kind: 'command',
          name: `criterion-proof-${index}`,
          timestamp: index + 1,
          criteria: [criterion],
        }),
      ),
    [] as EvidenceManifest[],
  );
  manifests = ['code-adversary', 'findings-adversary', 'test-adversary'].reduce(
    (current, name, index) =>
      recordTaskEvidence(
        current,
        'revision',
        boundedCriteria,
        evidence({ id: `required-gate-${index}`, name, timestamp: 98 + index, criteria: [] }),
      ),
    manifests,
  );
  const currentCi = ciEvidence(
    {
      name: 'build',
      url: 'https://github.test/actions/runs/bounded',
      databaseId: 50,
      runId: 10,
    },
    'passed',
    101,
  );

  manifests = recordCiEvidenceObservation(manifests, 'revision', boundedCriteria, currentCi);

  assert.equal(manifests[0].evidence.length, 100);
  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === currentCi.id),
    false,
  );
  assert.equal(manifests[0].economicsRollup?.archivedEntries, 1);
  assert.equal(summarizeTaskEconomics(manifests, { ready: true }, 'revision').totals.checks, 1);
});

void test('reserves gate and criterion proof capacity ahead of 100 live CI executions', () => {
  const requiredCriteria = ['The accepted outcome is verified.'];
  const executions = Array.from({ length: 100 }, (_, index) =>
    ciEvidence(
      {
        name: `build-${index + 1}`,
        url: `https://github.test/actions/runs/${index + 1}`,
        databaseId: index + 1,
        runId: index + 1,
      },
      'passed',
      index + 1,
    ),
  );
  let manifests = executions.reduce(
    (current, execution) =>
      recordCiEvidenceObservation(current, 'revision', requiredCriteria, execution),
    [] as EvidenceManifest[],
  );

  assert.equal(manifests[0].evidence.length, 100);
  assert.equal(
    manifests[0].evidence.every((entry) => entry.id.startsWith('ci:')),
    true,
  );

  manifests = recordTaskEvidence(
    manifests,
    'revision',
    requiredCriteria,
    evidence({ id: 'required-gate', timestamp: 101, criteria: [] }),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    requiredCriteria,
    evidence({
      id: 'criterion-proof',
      kind: 'command',
      name: 'task contract',
      timestamp: 102,
      criteria: requiredCriteria,
    }),
  );

  const readiness = evidenceReadiness(manifests, 'revision', ['code-adversary'], requiredCriteria);
  assert.equal(manifests[0].evidence.length, 100);
  assert.equal(manifests[0].evidence.filter((entry) => entry.id.startsWith('ci:')).length, 98);
  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === 'required-gate'),
    true,
  );
  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === 'criterion-proof'),
    true,
  );
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missingGates, []);
  assert.deepEqual(readiness.unverifiedCriteria, []);
  assert.equal(manifests[0].economicsRollup?.archivedEntries, 2);
  assert.equal(summarizeTaskEconomics(manifests, readiness, 'revision').totals.checks, 100);

  manifests = recordCiEvidenceObservation(manifests, 'revision', requiredCriteria, {
    ...executions[0],
    timestamp: 200,
  });
  const repolledReadiness = evidenceReadiness(
    manifests,
    'revision',
    ['code-adversary'],
    requiredCriteria,
  );
  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === 'required-gate'),
    true,
  );
  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === 'criterion-proof'),
    true,
  );
  assert.equal(repolledReadiness.ready, true);
  assert.equal(summarizeTaskEconomics(manifests, repolledReadiness, 'revision').totals.checks, 100);
  assert.equal(manifests[0].economicsRollup?.archivedEntries, 3);
});

void test('the evidence bound retains each latest gate above a full command history', () => {
  let manifests: EvidenceManifest[] = [];
  for (let index = 1; index <= 100; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      criteria,
      evidence({
        id: `command-${index}`,
        kind: 'command',
        name: `command-${index}`,
        timestamp: index,
        criteria: [],
      }),
    );
  const gateNames = ['code-adversary', 'findings-adversary', 'test-adversary'];
  const gateSequences = gateNames.map((_, index) => nextTaskEvidenceSequence(manifests, index));
  for (const [index, name] of gateNames.entries())
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      criteria,
      evidence({
        id: `gate-${index}`,
        name,
        timestamp: 200 + index,
        sequence: gateSequences[index],
        criteria,
      }),
    );

  const gateEvidence = manifests[0].evidence.filter((entry) => entry.kind === 'gate');
  assert.deepEqual(
    gateEvidence.map((entry) => [entry.name, entry.sequence]),
    [
      ['code-adversary', 101],
      ['findings-adversary', 102],
      ['test-adversary', 103],
    ],
  );
  assert.equal(
    evidenceReadiness(
      manifests,
      'revision',
      ['code-adversary', 'findings-adversary', 'test-adversary'],
      criteria,
    ).ready,
    true,
  );
});

void test('keeps 98 single-criterion proofs and three required gates merge-ready', () => {
  const requiredCriteria = Array.from({ length: 98 }, (_, index) => `criterion-${index}`);
  const requiredGates = ['code-adversary', 'findings-adversary', 'test-adversary'];
  let manifests = requiredGates.reduce<EvidenceManifest[]>(
    (current, name, index) =>
      recordTaskEvidence(
        current,
        'revision',
        requiredCriteria,
        evidence({ id: `gate-${index}`, name, timestamp: index + 1, criteria: [] }),
      ),
    [],
  );

  manifests = requiredCriteria.reduce(
    (current, criterion, index) =>
      recordTaskEvidence(
        current,
        'revision',
        requiredCriteria,
        evidence({
          id: `proof-${index}`,
          kind: 'command',
          name: `proof-${index}`,
          timestamp: index + 4,
          criteria: [criterion],
        }),
      ),
    manifests,
  );

  const readiness = evidenceReadiness(manifests, 'revision', requiredGates, requiredCriteria);
  assert.equal(manifests[0].evidence.length, 101);
  assert.equal(manifests[0].evidence.filter((entry) => entry.kind === 'gate').length, 3);
  assert.equal(manifests[0].evidence.filter((entry) => entry.kind === 'command').length, 98);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missingGates, []);
  assert.deepEqual(readiness.unverifiedCriteria, []);
  assert.doesNotThrow(() => evidenceManifestsSchema.parse(manifests));
  const withLaterCommand = recordTaskEvidence(
    manifests,
    'revision',
    requiredCriteria,
    evidence({
      id: 'later-command',
      kind: 'command',
      name: 'later-command',
      timestamp: 200,
      criteria: [],
    }),
  );
  assert.equal(withLaterCommand[0].evidence.length, 101);
  assert.equal(
    evidenceReadiness(withLaterCommand, 'revision', requiredGates, requiredCriteria).ready,
    true,
  );
});

void test('older required evidence remains merge-ready after later commands fill the bound', () => {
  const requiredCriteria = ['criterion-one', 'criterion-two', 'criterion-three'];
  const requiredGates = ['code-adversary', 'findings-adversary', 'test-adversary'];
  let manifests: EvidenceManifest[] = [];
  for (const [index, name] of requiredGates.entries())
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      requiredCriteria,
      evidence({
        id: `required-gate-${index}`,
        name,
        timestamp: index + 1,
        criteria: [],
      }),
    );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    requiredCriteria,
    evidence({
      id: 'required-criteria',
      kind: 'command',
      name: 'task contract',
      timestamp: 4,
      criteria: requiredCriteria,
    }),
  );
  for (let index = 0; index < 100; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      requiredCriteria,
      evidence({
        id: `later-command-${index}`,
        kind: 'command',
        name: `later command ${index}`,
        timestamp: 10 + index,
        criteria: [],
      }),
    );

  const retainedIds = manifests[0].evidence.map((entry) => entry.id);
  const readiness = evidenceReadiness(manifests, 'revision', requiredGates, requiredCriteria);

  assert.equal(manifests[0].evidence.length, 100);
  assert.deepEqual(retainedIds.slice(0, 4), [
    'required-gate-0',
    'required-gate-1',
    'required-gate-2',
    'required-criteria',
  ]);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.missingGates, []);
  assert.deepEqual(readiness.unverifiedCriteria, []);
});

void test('normalizes duplicate persisted revisions to the newest manifest', () => {
  const first = recordTaskEvidence([], 'revision', criteria, evidence())[0];
  const newest = {
    ...first,
    evidence: [evidence({ id: 'newest', result: 'failed', timestamp: 30 })],
    updatedAt: 30,
  };

  const parsed = evidenceManifestsSchema.parse([first, newest]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].evidence[0].id, 'newest');
});

void test('deduplicates revisions before enforcing the persisted manifest bound', () => {
  const manifest = recordTaskEvidence([], 'revision', criteria, evidence())[0];
  const duplicates = Array.from({ length: 21 }, (_, index) => ({
    ...manifest,
    updatedAt: manifest.updatedAt + index,
  }));

  const parsed = evidenceManifestsSchema.parse(duplicates);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].updatedAt, manifest.updatedAt + 20);
});

void test('latest evidence uses timestamps instead of persisted array order', () => {
  const newest = evidence({ id: 'newest', result: 'passed', timestamp: 30, criteria });
  const older = evidence({ id: 'older', result: 'failed', timestamp: 20, criteria: [] });
  const manifest: EvidenceManifest = {
    revision: 'revision',
    baseRevision: null,
    acceptanceCriteria: criteria,
    evidence: [newest, older],
    stale: false,
    createdAt: 10,
    updatedAt: 30,
  };

  const readiness = evidenceReadiness([manifest], 'revision', ['code-adversary'], criteria);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.failedGates, []);
  assert.deepEqual(readiness.unverifiedCriteria, []);
});

void test('merges concurrent evidence without losing the newer update', () => {
  const original = recordTaskEvidence([], 'revision', criteria, evidence());
  const gateSnapshot = recordTaskEvidence(
    original,
    'revision',
    criteria,
    evidence({ id: 'gate', name: 'test-adversary', timestamp: 30 }),
  );
  const commandUpdate = recordTaskEvidence(
    original,
    'revision',
    criteria,
    evidence({ id: 'command', kind: 'command', name: 'npm test', timestamp: 40 }),
  );

  const merged = mergeEvidenceManifests(commandUpdate, gateSnapshot);
  assert.deepEqual(
    merged[0].evidence.map((entry) => entry.id),
    ['evidence-1', 'gate', 'command'],
  );
  assert.equal(merged[0].updatedAt, 40);
});

void test('orders same-sequence concurrent executions deterministically', () => {
  const original = recordTaskEvidence([], 'revision', criteria, evidence());
  const failed = recordTaskEvidence(
    original,
    'revision',
    criteria,
    evidence({
      id: 'failed-command',
      kind: 'command',
      name: 'npm test',
      result: 'failed',
      timestamp: 30,
      criteria: [],
    }),
  );
  const passed = recordTaskEvidence(
    original,
    'revision',
    criteria,
    evidence({
      id: 'passed-command',
      kind: 'command',
      name: 'npm test',
      result: 'passed',
      timestamp: 40,
      criteria,
    }),
  );

  const forward = mergeEvidenceManifests(failed, passed);
  const reverse = mergeEvidenceManifests(passed, failed);
  assert.deepEqual(reverse, forward);
  assert.deepEqual(mergeEvidenceManifests(forward, forward), forward);
  assert.deepEqual(evidenceReadiness(forward, 'revision', [], criteria).failedCommands, []);
  assert.equal(evidenceReadiness(forward, 'revision', [], criteria).ready, true);
  assert.ok(
    forward[0].evidence.find((entry) => entry.id === 'passed-command')!.sequence! >
      forward[0].evidence.find((entry) => entry.id === 'failed-command')!.sequence!,
  );
});

void test('treats evidence archived by a newer persisted snapshot as a tombstone', () => {
  let persisted: EvidenceManifest[] = [];
  const persist = (entry: TaskEvidence) => {
    const incoming = recordTaskEvidence(persisted, 'revision', criteria, entry);
    persisted = mergeEvidenceManifests(persisted, incoming);
  };
  persist(
    evidence({
      id: 'failed-run',
      kind: 'command',
      name: 'npm test',
      result: 'failed',
      criteria: [],
      timestamp: 1,
    }),
  );
  persist(
    evidence({
      id: 'passed-run',
      kind: 'command',
      name: 'npm test',
      result: 'passed',
      criteria,
      timestamp: 2,
    }),
  );
  for (let index = 0; index < 99; index += 1)
    persist(
      evidence({
        id: `after-pass-${index}`,
        kind: 'command',
        name: `command-${index}`,
        criteria: [],
        timestamp: 3 + index,
      }),
    );

  const readiness = evidenceReadiness(persisted, 'revision', [], criteria);
  assert.deepEqual(readiness.failedCommands, []);
  assert.equal(readiness.ready, true);
  assert.equal(
    persisted[0].evidence.some((entry) => entry.id === 'failed-run'),
    false,
  );
  assert.equal(
    persisted[0].evidence.some((entry) => entry.id === 'passed-run'),
    true,
  );
});

void test('applies archive tombstones when a missing revision reappears', () => {
  const archived = evidence({
    id: 'evicted-revision-evidence',
    kind: 'command',
    name: 'npm test',
    result: 'failed',
    criteria: [],
    sequence: 1,
    timestamp: 1,
  });
  const current: EvidenceManifest[] = [
    {
      revision: 'current',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 2,
      updatedAt: 2,
      economicsRollup: rollUpEconomics(undefined, [archived]),
    },
  ];
  const offline: EvidenceManifest[] = [
    {
      revision: 'evicted',
      acceptanceCriteria: criteria,
      evidence: [archived],
      stale: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  for (const merged of [
    mergeEvidenceManifests(current, offline),
    mergeEvidenceManifests(offline, current),
  ]) {
    assert.deepEqual(merged.find((manifest) => manifest.revision === 'evicted')?.evidence, []);
    assert.equal(summarizeTaskEconomics(merged, { ready: false }, 'current').samples, 0);
  }
});

void test('applies compacted tombstones when a missing revision reappears', () => {
  const archived = Array.from({ length: 1_025 }, (_, index) =>
    evidence({
      id: `compacted-tombstone-${index}`,
      kind: 'command',
      name: `command-${index}`,
      criteria: [],
      sequence: index + 1,
      timestamp: index + 1,
      economics: { ...emptyTaskEconomics('primary', 'test'), turns: 1 },
    }),
  );
  const current: EvidenceManifest[] = [
    {
      revision: 'current',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 2_000,
      updatedAt: 2_000,
      economicsRollup: rollUpEconomics(undefined, archived),
    },
  ];
  const offline: EvidenceManifest[] = [
    {
      revision: 'evicted',
      acceptanceCriteria: criteria,
      evidence: [archived[0]],
      stale: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  for (const merged of [
    mergeEvidenceManifests(current, offline),
    mergeEvidenceManifests(offline, current),
  ]) {
    assert.deepEqual(merged.find((manifest) => manifest.revision === 'evicted')?.evidence, []);
    const summary = summarizeTaskEconomics(merged, { ready: true }, 'current');
    assert.equal(summary.samples, 1_025);
    assert.equal(summary.identityCoverageComplete, true);
  }
});

void test('rejects changed offline content for a compacted identity', () => {
  const archived = Array.from({ length: 1_025 }, (_, index) =>
    evidence({
      id: `conflict-tombstone-${index}`,
      kind: 'command',
      name: `command-${index}`,
      criteria: [],
      sequence: index + 1,
      timestamp: index + 1,
    }),
  );
  const current: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 2_000,
      economicsRollup: rollUpEconomics(undefined, archived),
    },
  ];
  const offline: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [{ ...archived[0], name: 'changed command' }],
      stale: false,
      createdAt: 1,
      updatedAt: 2_001,
    },
  ];

  assert.throws(() => mergeEvidenceManifests(current, offline), /reused with different content/);
  assert.throws(() => mergeEvidenceManifests(offline, current), /reused with different content/);
});

void test('persists direct successors beyond the archived identity horizon', () => {
  const archivedEntries = Array.from({ length: 1_025 }, (_, index) =>
    evidence({
      id: `sequential-${index}`,
      kind: 'command',
      name: `command-${index}`,
      criteria: [],
      timestamp: index + 1,
      sequence: index + 1,
    }),
  );
  const retained = Array.from({ length: 100 }, (_, offset) => {
    const index = offset + archivedEntries.length;
    return evidence({
      id: `sequential-${index}`,
      kind: 'command',
      name: `command-${index}`,
      criteria: [],
      timestamp: index + 1,
      sequence: index + 1,
    });
  });
  let persisted: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: retained,
      stale: false,
      createdAt: 1,
      updatedAt: 1_125,
      economicsRollup: rollUpEconomics(undefined, archivedEntries),
    },
  ];
  const incoming = recordTaskEvidence(
    persisted,
    'revision',
    criteria,
    evidence({
      id: 'sequential-1125',
      kind: 'command',
      name: 'command-1125',
      criteria: [],
      timestamp: 1_126,
    }),
  );
  persisted = mergeEvidenceManifests(persisted, incoming);

  assert.equal(persisted[0].evidence.length, 100);
  assert.equal(persisted[0].evidence.at(-1)?.sequence, 1_126);
  assert.deepEqual(persisted[0].economicsRollup?.archivedSequenceRanges, [[1, 1_026]]);
  assert.equal(persisted[0].economicsRollup?.archivedEntries, 1_026);
  assert.equal(persisted[0].economicsRollup?.identityHorizonTruncated, true);
  assert.equal(persisted[0].economicsRollup?.identityCoverageComplete, true);
});

void test('keeps divergent concurrent entries while honoring shared archive tombstones', () => {
  let shared: EvidenceManifest[] = [];
  for (let index = 0; index < 100; index += 1)
    shared = recordTaskEvidence(
      shared,
      'revision',
      criteria,
      evidence({ id: `shared-${index}`, timestamp: index + 1 }),
    );
  const left = recordTaskEvidence(
    shared,
    'revision',
    criteria,
    evidence({ id: 'left-concurrent', timestamp: 101 }),
  );
  const right = recordTaskEvidence(
    shared,
    'revision',
    criteria,
    evidence({ id: 'right-concurrent', timestamp: 101 }),
  );

  for (const merged of [mergeEvidenceManifests(left, right), mergeEvidenceManifests(right, left)]) {
    const ids = new Set(merged[0].evidence.map((entry) => entry.id));
    assert.equal(ids.has('left-concurrent'), true);
    assert.equal(ids.has('right-concurrent'), true);
    assert.equal(merged[0].evidence.length, 100);
    assert.equal(merged[0].economicsRollup?.archivedEntries, 2);
  }
});

void test('keeps manifest metadata valid when the wall clock moves backward', () => {
  let manifests = syncEvidenceManifest([], 'revision', criteria, 100);
  manifests = recordTaskEvidence(manifests, 'revision', criteria, evidence({ timestamp: 50 }));

  assert.equal(manifests[0].createdAt, 100);
  assert.equal(manifests[0].updatedAt, 100);
  assert.doesNotThrow(() => evidenceManifestsSchema.parse(manifests));
});

void test('a later rerun wins when the wall clock moves backward', () => {
  let manifests = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence({ result: 'passed', timestamp: 100, criteria }),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({ id: 'rerun', result: 'failed', timestamp: 50, criteria }),
  );

  const readiness = evidenceReadiness(manifests, 'revision', ['code-adversary'], criteria);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.failedGates, ['code-adversary']);
});

void test('preserves the current revision when history is full and time moves backward', () => {
  let manifests: EvidenceManifest[] = [];
  for (let index = 0; index < 20; index += 1)
    manifests = syncEvidenceManifest(manifests, `old-${index}`, criteria, 100 + index);

  manifests = recordTaskEvidence(manifests, 'current', criteria, evidence({ timestamp: 50 }));

  assert.equal(manifests.length, 20);
  assert.equal(manifests.find((manifest) => manifest.revision === 'current')?.stale, false);
  assert.equal(
    manifests.find((manifest) => manifest.revision === 'current')?.evidence[0].id,
    'evidence-1',
  );
});

void test('rejects evidence recorded after its execution revision changed', () => {
  assert.doesNotThrow(() => requireEvidenceRevision('revision-a', 'revision-a'));
  assert.throws(() => requireEvidenceRevision(undefined, 'revision-a'), /captured before/);
  assert.throws(() => requireEvidenceRevision('revision-a', 'revision-b'), /Rerun/);
});

void test('rejects command evidence after mutation generation or shipping base changes', () => {
  const current = {
    revision: 'revision-a',
    mutationGeneration: 'generation-b',
    baseRevision: 'base-b',
  };

  assert.doesNotThrow(() =>
    requireEvidenceExecutionBoundary(
      {
        revision: 'revision-a',
        mutationGeneration: 'generation-b',
        baseRevision: 'base-b',
      },
      current,
    ),
  );
  assert.throws(
    () =>
      requireEvidenceExecutionBoundary(
        {
          revision: 'revision-a',
          mutationGeneration: 'generation-a',
          baseRevision: 'base-b',
        },
        current,
      ),
    /modified after execution started/,
  );
  assert.throws(
    () =>
      requireEvidenceExecutionBoundary(
        {
          revision: 'revision-a',
          mutationGeneration: 'generation-b',
          baseRevision: 'base-a',
        },
        current,
      ),
    /shipping base changed after execution started/,
  );
});

void test('captures a stable command execution boundary after a concurrent change', async () => {
  const revisions = ['revision-a', 'revision-b', 'revision-b', 'revision-b'];
  const generations = ['generation-a', 'generation-b', 'generation-b', 'generation-b'];
  const bases = ['base-a', 'base-b', 'base-b', 'base-b'];

  const boundary = await readStableEvidenceBoundary(
    async () => revisions.shift()!,
    async () => generations.shift()!,
    async () => bases.shift()!,
  );

  assert.deepEqual(boundary, {
    revision: 'revision-b',
    mutationGeneration: 'generation-b',
    baseRevision: 'base-b',
  });
});

for (const drift of ['revision', 'mutationGeneration', 'baseRevision'] as const) {
  void test(`rolls back only its evidence after durable ${drift} drift`, async () => {
    const expected = {
      revision: 'revision-a',
      mutationGeneration: 'generation-a',
      baseRevision: 'base-a',
    };
    let boundary = { ...expected };
    const state: { evidenceRevision?: string; evidenceManifests?: EvidenceManifest[] } = {
      evidenceRevision: 'revision-a',
      evidenceManifests: [],
    };
    let reachSave!: () => void;
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => (reachSave = resolve));
    const saved = new Promise<void>((resolve) => (finishSave = resolve));
    const operation = commitRevisionBoundEvidence({
      expected,
      readBoundary: async () => ({ ...boundary }),
      commit: async (registerRollback) => {
        const previous = structuredClone(state);
        state.evidenceManifests = recordTaskEvidence(
          state.evidenceManifests ?? [],
          expected.revision,
          criteria,
          evidence({ id: 'own', kind: 'command', name: 'npm test', criteria: [] }),
          expected.baseRevision,
        );
        const committed = structuredClone(state);
        registerRollback(async () => {
          Object.assign(state, rollbackTaskEvidenceRecord(state, previous, committed, 'own'));
        });
        reachSave();
        await saved;
      },
    });
    await saving;
    state.evidenceManifests = recordTaskEvidence(
      state.evidenceManifests ?? [],
      expected.revision,
      criteria,
      evidence({ id: 'concurrent', kind: 'command', name: 'cargo test', criteria: [] }),
      expected.baseRevision,
    );
    boundary = { ...expected, [drift]: `${drift}-changed` };
    finishSave();
    await assert.rejects(operation, /Rerun the evidence/);
    assert.deepEqual(
      state.evidenceManifests?.[0].evidence.map((entry) => entry.id),
      ['concurrent'],
    );
    assert.equal(state.evidenceRevision, 'revision-a');
  });
}

void test('rollback restores evidence evicted by a full manifest', () => {
  let manifests: EvidenceManifest[] = [];
  for (let index = 0; index < 100; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision-a',
      criteria,
      evidence({
        id: `prior-${index}`,
        kind: 'command',
        name: `command-${index}`,
        timestamp: index + 1,
      }),
      'base-a',
    );
  const previous = { evidenceRevision: 'revision-a', evidenceManifests: manifests };
  const committed = {
    evidenceRevision: 'revision-a',
    evidenceManifests: recordTaskEvidence(
      manifests,
      'revision-a',
      criteria,
      evidence({ id: 'own', kind: 'command', name: 'new command', timestamp: 101 }),
      'base-a',
    ),
  };

  const rolledBack = rollbackTaskEvidenceRecord(committed, previous, committed, 'own');

  assert.deepEqual(rolledBack.evidenceManifests, manifests);
});

void test('rollback removes compacted economics while preserving concurrent evidence', () => {
  let manifests: EvidenceManifest[] = [];
  for (let index = 0; index < 100; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision-a',
      criteria,
      measuredEvidence(`prior-${index}`, index + 1),
      'base-a',
    );
  const previous = { evidenceRevision: 'revision-a', evidenceManifests: manifests };
  const committed = {
    evidenceRevision: 'revision-a',
    evidenceManifests: recordTaskEvidence(
      manifests,
      'revision-a',
      criteria,
      measuredEvidence('own', 101),
      'base-a',
    ),
  };
  const current = structuredClone(committed);
  for (let index = 0; index < 100; index += 1)
    current.evidenceManifests = recordTaskEvidence(
      current.evidenceManifests,
      'revision-a',
      criteria,
      measuredEvidence(`concurrent-${index}`, index + 102),
      'base-a',
    );
  const beforeRollback = summarizeTaskEconomics(
    current.evidenceManifests,
    { ready: true },
    'revision-a',
  );

  const rolledBack = rollbackTaskEvidenceRecord(current, previous, committed, 'own');
  const summary = summarizeTaskEconomics(
    rolledBack.evidenceManifests,
    { ready: true },
    'revision-a',
  );

  assert.equal(beforeRollback.samples, 201);
  assert.equal(summary.samples, 200);
  assert.equal(summary.totals.turns, 200);
  assert.equal(rolledBack.evidenceManifests[0].economicsRollup?.archivedEntries, 100);
  assert.equal(rolledBack.evidenceManifests[0].evidence.length, 100);
  assert.equal(rolledBack.evidenceManifests[0].evidence[0].id, 'concurrent-0');
  assert.equal(rolledBack.evidenceManifests[0].evidence.at(-1)?.id, 'concurrent-99');
});

void test('rollback removes an immediately archived write and preserves concurrent archive', () => {
  const protectedFailures = Array.from({ length: 100 }, (_, index) =>
    measuredEvidence(`failure-${index}`, index + 1),
  ).reduce(
    (manifests, entry) =>
      recordTaskEvidence(
        manifests,
        'revision-a',
        criteria,
        { ...entry, result: 'failed', economics: { ...entry.economics!, failedCommands: 1 } },
        'base-a',
      ),
    [] as EvidenceManifest[],
  );
  const previous = { evidenceRevision: 'revision-a', evidenceManifests: protectedFailures };
  const committed = {
    evidenceRevision: 'revision-a',
    evidenceManifests: recordTaskEvidence(
      protectedFailures,
      'revision-a',
      criteria,
      measuredEvidence('own-passing', 101),
      'base-a',
    ),
  };
  const current = {
    evidenceRevision: 'revision-a',
    evidenceManifests: recordTaskEvidence(
      committed.evidenceManifests,
      'revision-a',
      criteria,
      measuredEvidence('concurrent-passing', 102),
      'base-a',
    ),
  };

  const rolledBack = rollbackTaskEvidenceRecord(current, previous, committed, 'own-passing');
  const summary = summarizeTaskEconomics(
    rolledBack.evidenceManifests,
    { ready: false },
    'revision-a',
  );

  assert.equal(summary.samples, 101);
  assert.equal(summary.totals.turns, 101);
  assert.equal(rolledBack.evidenceManifests[0].economicsRollup?.archivedEntries, 1);
  assert.equal(
    rolledBack.evidenceManifests[0].economicsRollup?.archivedEvidence[0].identityDigest,
    evidenceIdentityDigest('concurrent-passing'),
  );
});

void test('rejects a late evidence snapshot after a newer revision was stored', () => {
  assert.doesNotThrow(() => requireEvidenceBaseRevision('revision-a', undefined));
  assert.doesNotThrow(() => requireEvidenceBaseRevision('revision-a', 'revision-a'));
  assert.throws(() => requireEvidenceBaseRevision('revision-a', 'revision-b'), /concurrently/);
});

void test('counts each CI execution once across polling and status changes', () => {
  const firstRun = 'https://github.test/actions/runs/1';
  const firstCheck = { name: 'build', url: '', databaseId: 50, runId: 10, attempt: 1 };
  let manifests = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence(firstCheck, 'pending', 10),
  );
  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence({ ...firstCheck, url: firstRun }, 'pending', 20),
  );
  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(summarizeTaskEconomics(manifests, { ready: false }, 'revision').totals.checks, 1);

  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence({ ...firstCheck, url: firstRun }, 'passed', 30),
  );
  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].result, 'passed');
  assert.equal(summarizeTaskEconomics(manifests, { ready: false }, 'revision').totals.checks, 1);

  const retry = ciEvidence({ ...firstCheck, url: firstRun, attempt: 2 }, 'passed', 40);
  assert.notEqual(retry.id, manifests[0].evidence[0].id);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, retry);
  assert.equal(manifests[0].evidence.length, 2);
  assert.equal(summarizeTaskEconomics(manifests, { ready: false }, 'revision').totals.checks, 2);
});

void test('counts a CI execution once when its workflow run identity arrives later', () => {
  const pending = ciEvidence(
    { name: 'build', url: 'https://github.test/jobs/50', databaseId: 50, attempt: 1 },
    'pending',
    10,
  );
  const enriched = ciEvidence(
    {
      name: 'build',
      url: 'https://github.test/jobs/50',
      databaseId: 50,
      runId: 10,
      attempt: 1,
    },
    'passed',
    20,
  );
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, pending);

  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [enriched]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, enriched);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.equal(pending.id, enriched.id);
  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].result, 'passed');
  assert.equal(summary.totals.checks, 1);
});

void test('keeps independent CI checks distinct after workflow run enrichment', () => {
  const first = ciEvidence(
    { name: 'build', url: 'https://github.test/jobs/50', databaseId: 50, runId: 10 },
    'passed',
    10,
  );
  const second = ciEvidence(
    { name: 'build', url: 'https://github.test/jobs/51', databaseId: 51, runId: 11 },
    'passed',
    20,
  );
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, first);

  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, second);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.notEqual(first.id, second.id);
  assert.equal(manifests[0].evidence.length, 2);
  assert.equal(summary.totals.checks, 2);
});

void test('reconciles status updates without claiming a stable execution identity', () => {
  const pending = ciEvidence(
    {
      name: 'buildkite/test',
      url: 'https://buildkite.com/acme/widgets/builds/101/#job-1',
      statusContextId: 'SC_pending',
    },
    'pending',
    10,
  );
  const passed = ciEvidence(
    {
      name: 'buildkite/test',
      url: 'https://buildkite.com/acme/widgets/builds/101',
      statusContextId: 'SC_success',
    },
    'passed',
    20,
  );
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, pending);

  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [passed]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, passed);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.equal(pending.id, passed.id);
  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].result, 'passed');
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.identityCoverageComplete, false);
  assert.equal(summary.accepted, false);
});

void test('counts status executions with distinct run URLs separately', () => {
  const first = ciEvidence(
    {
      name: 'buildkite/test',
      url: 'https://buildkite.com/acme/widgets/builds/101',
      statusContextId: 'SC_first',
    },
    'passed',
    10,
  );
  const second = ciEvidence(
    {
      name: 'buildkite/test',
      url: 'https://buildkite.com/acme/widgets/builds/102',
      statusContextId: 'SC_second',
    },
    'passed',
    20,
  );
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, first);

  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [second]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, second);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.notEqual(first.id, second.id);
  assert.equal(summary.totals.checks, 2);
  assert.equal(summary.identityCoverageComplete, false);
  assert.equal(summary.accepted, false);
});

void test('reconciles a persisted status without claiming stable identity', () => {
  const url = 'https://buildkite.com/acme/widgets/builds/101';
  const pending = ciEvidence(
    { name: 'buildkite/test', url, identityUncertain: true },
    'pending',
    10,
  );
  const passed = ciEvidence(
    { name: 'buildkite/test', url, statusContextId: 'SC_success' },
    'passed',
    20,
  );
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, pending);

  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [passed]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, passed);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.identityCoverageComplete, false);
  assert.equal(summary.accepted, false);
});

void test('marks same-url status reruns ambiguous instead of accepting an undercount', () => {
  const first = ciEvidence(
    {
      name: 'external/build',
      url: 'https://ci.test/latest',
      statusContextId: 'SC_first',
    },
    'passed',
    10,
  );
  const second = ciEvidence(
    {
      name: 'external/build',
      url: 'https://ci.test/latest',
      statusContextId: 'SC_second',
    },
    'passed',
    20,
  );
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, first);

  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [second]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, second);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.equal(first.id, second.id);
  assert.equal(first.identityUncertain, true);
  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.identityCoverageComplete, false);
  assert.equal(summary.accepted, false);
});

void test('marks status contexts without a run URL as identity-incomplete', () => {
  const status = ciEvidence(
    {
      name: 'external/build',
      url: '',
      statusContextId: 'SC_kwDOStatusContext1',
    },
    'passed',
    20,
  );
  const manifests = recordCiEvidenceObservation([], 'revision', criteria, status);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.equal(status.identityUncertain, true);
  assert.equal(summary.identityCoverageComplete, false);
  assert.equal(summary.accepted, false);
});

void test('keeps a newer live CI state when the same execution is archived', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/1',
    databaseId: 50,
    runId: 10,
  };
  let archived = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence(check, 'failed', 1),
  );
  for (let index = 0; index < 100; index += 1)
    archived = recordTaskEvidence(
      archived,
      'revision',
      criteria,
      evidence({
        id: `ci-archive-filler-${index}`,
        kind: 'command',
        name: `filler-${index}`,
        criteria: [],
        timestamp: index + 2,
      }),
    );
  const passed = recordCiEvidenceObservation(
    archived,
    'revision',
    criteria,
    ciEvidence(check, 'passed', 200),
  );

  for (const merged of [
    mergeEvidenceManifests(archived, passed),
    mergeEvidenceManifests(passed, archived),
  ]) {
    const ci = merged[0].evidence.find((entry) => entry.id === ciEvidence(check, 'passed', 200).id);
    assert.equal(ci?.result, 'passed');
    assert.deepEqual(evidenceReadiness(merged, 'revision', [], []).failedCommands, []);
    const summary = summarizeTaskEconomics(merged, { ready: true }, 'revision');
    assert.equal(summary.totals.checks, 1);
    assert.equal(summary.totals.failedCommands, 1);

    const repolled = recordCiEvidenceObservation(
      merged,
      'revision',
      criteria,
      ciEvidence(check, 'passed', 300),
    );
    const latest = repolled[0].evidence.find((entry) => entry.id === ci?.id);
    assert.equal(latest?.result, 'passed');
    assert.equal(latest?.timestamp, 300);
    assert.equal(
      summarizeTaskEconomics(repolled, { ready: true }, 'revision').totals.failedCommands,
      1,
    );
  }
});

void test('persists archived CI transition economics through later compaction', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/transition',
    databaseId: 70,
    runId: 20,
  };
  const pending = { ...ciEvidence(check, 'pending', 1), sequence: 1 };
  let manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 1,
      economicsRollup: rollUpEconomics(undefined, [pending]),
    },
  ];
  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(check, 'failed', 200),
  );
  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(check, 'passed', 201),
  );
  for (let index = 0; index < 100; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      criteria,
      evidence({
        id: `later-filler-${index}`,
        kind: 'command',
        name: `later-filler-${index}`,
        criteria: [],
        timestamp: 300 + index,
      }),
    );
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(summary.totals.failedCommands, 1);
  assert.equal(
    manifests[0].economicsRollup?.archivedEvidence.find(
      (entry) => entry.identityDigest === evidenceIdentityDigest(ciEvidence(check, 'passed', 0).id),
    )?.economics?.failedCommands,
    1,
  );
});

void test('merges concurrent CI state by recency and failure cost monotonically', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/1',
    databaseId: 50,
    runId: 10,
  };
  const pending = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence(check, 'pending', 10),
  );
  const failed = recordCiEvidenceObservation(
    pending,
    'revision',
    criteria,
    ciEvidence(check, 'failed', 20),
  );
  const passed = recordCiEvidenceObservation(
    pending,
    'revision',
    criteria,
    ciEvidence(check, 'passed', 30),
  );

  for (const merged of [
    mergeEvidenceManifests(failed, passed),
    mergeEvidenceManifests(passed, failed),
  ]) {
    assert.equal(merged[0].evidence.length, 1);
    assert.equal(merged[0].evidence[0].result, 'passed');
    assert.equal(merged[0].evidence[0].timestamp, 30);
    assert.equal(merged[0].evidence[0].economics?.failedCommands, 1);
    assert.equal(
      summarizeTaskEconomics(merged, { ready: true }, 'revision').totals.failedCommands,
      1,
    );
  }
});

void test('orders equal-version concurrent CI results deterministically', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/tie',
    databaseId: 90,
    runId: 30,
  };
  const base = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence(check, 'pending', 10),
  );
  const failed = recordCiEvidenceObservation(
    base,
    'revision',
    criteria,
    ciEvidence(check, 'failed', 20),
  );
  const passed = recordCiEvidenceObservation(
    base,
    'revision',
    criteria,
    ciEvidence(check, 'passed', 20),
  );
  const forward = mergeEvidenceManifests(failed, passed);
  const reverse = mergeEvidenceManifests(passed, failed);
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0].evidence[0].result, 'failed');
  assert.deepEqual(evidenceReadiness(forward, 'revision', [], []).failedCommands, ['ci:build']);
  assert.deepEqual(mergeEvidenceManifests(forward, forward), forward);
});

void test('uses stable CI run attempts instead of API observation order', () => {
  const attemptOne = ciEvidence(
    { name: 'build', url: 'https://github.test/runs/10/1', runId: 10, attempt: 1 },
    'failed',
    20,
  );
  const attemptTwo = ciEvidence(
    { name: 'build', url: 'https://github.test/runs/10/2', runId: 10, attempt: 2 },
    'passed',
    20,
  );
  const forward = [attemptOne, attemptTwo].reduce(
    (manifests, entry) => recordCiEvidenceObservation(manifests, 'revision', criteria, entry),
    [] as EvidenceManifest[],
  );
  const reverse = [attemptTwo, attemptOne].reduce(
    (manifests, entry) => recordCiEvidenceObservation(manifests, 'revision', criteria, entry),
    [] as EvidenceManifest[],
  );
  assert.deepEqual(evidenceReadiness(forward, 'revision', [], []).failedCommands, []);
  assert.deepEqual(evidenceReadiness(reverse, 'revision', [], []).failedCommands, []);
  assert.deepEqual(
    mergeEvidenceManifests(forward, reverse),
    mergeEvidenceManifests(reverse, forward),
  );
});

void test('aggregates distinct same-name checks in the latest CI attempt', () => {
  const failed = ciEvidence(
    { name: 'build', url: 'https://github.test/jobs/1', databaseId: 51, runId: 10, attempt: 2 },
    'failed',
    20,
  );
  const passed = {
    ...ciEvidence(
      {
        name: 'build',
        url: 'https://github.test/jobs/2',
        databaseId: 52,
        runId: 10,
        attempt: 2,
      },
      'passed',
      20,
    ),
    criteria,
  };
  for (const observations of [
    [failed, passed],
    [passed, failed],
  ]) {
    const manifests = observations.reduce(
      (current, entry) => recordCiEvidenceObservation(current, 'revision', criteria, entry),
      [] as EvidenceManifest[],
    );
    const readiness = evidenceReadiness(manifests, 'revision', [], criteria);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.failedCommands, ['ci:build']);
  }
});

void test('accepts execution order added to archived CI evidence after upgrade', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/1',
    databaseId: 50,
    runId: 10,
    attempt: 2,
  };
  const current = ciEvidence(check, 'passed', 20);
  const legacy = ciEvidence(check, 'pending', 10);
  delete legacy.executionOrder;
  const manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 10,
      economicsRollup: rollUpEconomics(undefined, [{ ...legacy, sequence: 1 }]),
    },
  ];

  const updated = recordCiEvidenceObservation(manifests, 'revision', criteria, current);
  assert.equal(updated[0].evidence[0].result, 'passed');
  assert.deepEqual(updated[0].evidence[0].executionOrder, [10, 2]);
});

void test('accepts execution order added to retained CI evidence after upgrade', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/1',
    databaseId: 50,
    runId: 10,
    attempt: 2,
  };
  const legacy = ciEvidence(check, 'pending', 10);
  delete legacy.executionOrder;
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, legacy);

  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(check, 'passed', 20),
  );

  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].result, 'passed');
  assert.deepEqual(manifests[0].evidence[0].executionOrder, [10, 2]);
});

void test('aggregates same-name checks from independent CI run lineages', () => {
  const failed = ciEvidence(
    { name: 'build', url: 'https://github.test/runs/10', databaseId: 50, runId: 10 },
    'failed',
    20,
  );
  const passed = ciEvidence(
    { name: 'build', url: 'https://github.test/runs/11', databaseId: 51, runId: 11 },
    'passed',
    20,
  );
  const manifests = [failed, passed].reduce(
    (current, entry) => recordCiEvidenceObservation(current, 'revision', criteria, entry),
    [] as EvidenceManifest[],
  );

  assert.deepEqual(evidenceReadiness(manifests, 'revision', [], []).failedCommands, ['ci:build']);
});

void test('rekeys uncertain pending CI to a schema-valid failed execution', () => {
  const url = 'https://github.test/actions/runs/1';
  const pending = ciEvidence({ name: 'build', url, identityUncertain: true }, 'pending', 10);
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, pending);
  const failed = ciEvidence(
    { name: 'build', url, databaseId: 50, runId: 10, attempt: 1 },
    'failed',
    20,
  );
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, failed);

  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].id, failed.id);
  assert.equal(manifests[0].evidence[0].result, 'failed');
  assert.equal(manifests[0].evidence[0].economics?.failedCommands, 1);
  assert.doesNotThrow(() => evidenceManifestsSchema.parse(manifests));
});

void test('keeps distinct provisional CI executions uncertain until each is reconciled', () => {
  const first = ciEvidence(
    { name: 'build', url: 'https://github.test/actions/runs/provisional-1' },
    'pending',
    10,
  );
  const second = ciEvidence(
    { name: 'build', url: 'https://github.test/actions/runs/provisional-2' },
    'pending',
    20,
  );
  assert.notEqual(first.id, second.id);
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, first);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, second);
  assert.deepEqual(evidenceReadiness(manifests, 'revision', [], []).pendingCommands, ['ci:build']);
  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(
      {
        name: 'build',
        url: first.outputReference,
        databaseId: 50,
        runId: 10,
        attempt: 1,
      },
      'passed',
      30,
    ),
  );
  assert.equal(manifests[0].evidence.length, 2);
  assert.equal(summarizeTaskEconomics(manifests, { ready: true }, 'revision').accepted, false);
  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(
      {
        name: 'build',
        url: second.outputReference,
        databaseId: 51,
        runId: 11,
        attempt: 1,
      },
      'passed',
      40,
    ),
  );
  assert.equal(manifests[0].evidence.length, 2);
  assert.equal(
    manifests[0].evidence.some((entry) => entry.identityUncertain === true),
    false,
  );
});

void test('normalizes known gate economics to validator context', () => {
  let manifests = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence({
      economics: { ...emptyTaskEconomics('primary', 'implement'), checks: 1 },
    }),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence({
      id: 'test-gate',
      name: 'test-adversary',
      economics: { ...emptyTaskEconomics('guardian', 'complete'), checks: 1 },
    }),
  );
  assert.deepEqual(
    manifests[0].evidence.map((entry) => [entry.economics?.role, entry.economics?.phase]),
    [
      ['validator', 'review'],
      ['validator', 'test'],
    ],
  );
});

void test('keeps differently referenced provisional CI executions distinct', () => {
  const pending = ciEvidence({ name: 'build', url: '', identityUncertain: true }, 'pending', 10);
  const passed = ciEvidence(
    { name: 'build', url: 'https://github.test/actions/runs/1', identityUncertain: true },
    'passed',
    20,
  );
  assert.notEqual(pending.id, passed.id);
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, pending);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, passed);

  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(summary.totals.checks, 2);
  assert.equal(summary.identityCoverageComplete, false);
  assert.equal(summary.accepted, false);
});

void test('rekeys a transient legacy CI observation and preserves a real retry', () => {
  const url = 'https://github.test/actions/runs/1';
  let manifests = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence({ name: 'build', url, identityUncertain: true }, 'pending', 10),
  );
  const stable = ciEvidence(
    { name: 'build', url, databaseId: 50, runId: 10, attempt: 1 },
    'passed',
    20,
  );
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, stable);
  let summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].id, stable.id);
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.identityCoverageComplete, true);

  const retry = ciEvidence(
    { name: 'build', url, databaseId: 51, runId: 10, attempt: 2 },
    'passed',
    30,
  );
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, retry);
  summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(manifests[0].evidence.length, 2);
  assert.equal(summary.totals.checks, 2);
});

void test('temporary CI identity loss keeps the enriched execution counted once', () => {
  const url = 'https://github.test/actions/runs/identity-refresh';
  const stable = ciEvidence(
    { name: 'build', url, databaseId: 50, runId: 10, attempt: 1 },
    'passed',
    10,
  );
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, stable);
  const fallback = ciEvidence({ name: 'build', url, identityUncertain: true }, 'passed', 20);

  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [fallback]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, fallback);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.equal(manifests[0].evidence.length, 1);
  assert.equal(manifests[0].evidence[0].id, stable.id);
  assert.equal(manifests[0].evidence[0].identityUncertain, false);
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.identityCoverageComplete, true);
  assert.equal(summary.accepted, true);
});

void test('temporary CI identity loss restores archived enriched execution to live evidence', () => {
  const url = 'https://github.test/actions/runs/archived-identity-refresh';
  const stable = ciEvidence(
    { name: 'build', url, databaseId: 50, runId: 10, attempt: 1 },
    'passed',
    1,
  );
  let manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 1,
      economicsRollup: rollUpEconomics(undefined, [{ ...stable, sequence: 1 }]),
    },
  ];
  const fallback = ciEvidence({ name: 'build', url, identityUncertain: true }, 'passed', 200);

  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [fallback]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, fallback);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  const archived = manifests[0].economicsRollup?.archivedEvidence.find(
    (entry) => entry.identityDigest === evidenceIdentityDigest(stable.id),
  );

  assert.equal(
    manifests[0].evidence.some((entry) => entry.id === fallback.id),
    true,
  );
  assert.equal(
    archived?.identityAliases.some(
      (alias) => alias.identityDigest === evidenceIdentityDigest(fallback.id),
    ),
    true,
  );
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.identityCoverageComplete, true);
  assert.equal(summary.accepted, true);
});

void test('rekeys a compacted legacy CI failure with monotonic economics', () => {
  const url = 'https://github.test/actions/runs/1';
  const provisional = {
    ...ciEvidence({ name: 'build', url, identityUncertain: true }, 'pending', 10),
    sequence: 1,
  };
  let manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 10,
      economicsRollup: rollUpEconomics(undefined, [provisional]),
    },
  ];
  const stable = ciEvidence(
    { name: 'build', url, databaseId: 50, runId: 10, attempt: 1 },
    'failed',
    200,
  );
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, stable);

  const summary = summarizeTaskEconomics(manifests, { ready: false }, 'revision');
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.totals.failedCommands, 1);
  assert.equal(summary.identityCoverageComplete, true);
  assert.doesNotThrow(() => evidenceManifestsSchema.parse(manifests));
  assert.ok(
    manifests[0].economicsRollup?.archivedEvidence.some(
      (entry) => entry.identityDigest === evidenceIdentityDigest(stable.id),
    ),
  );
});

void test('updates a failed CI execution after its identity becomes a tombstone', () => {
  const check = {
    name: 'build',
    url: 'https://github.test/actions/runs/tombstoned',
    databaseId: 50,
    runId: 10,
    attempt: 1,
  };
  const pending = { ...ciEvidence(check, 'pending', 1), sequence: 1 };
  const fillers = Array.from({ length: 1_024 }, (_, index) =>
    evidence({
      id: `stable-tombstone-filler-${index}`,
      kind: 'command',
      name: `filler-${index}`,
      criteria: [],
      timestamp: index + 2,
      sequence: index + 2,
    }),
  );
  const manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 2_000,
      economicsRollup: rollUpEconomics(undefined, [pending, ...fillers]),
    },
  ];

  const updated = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(check, 'failed', 3_000),
  );
  const summary = summarizeTaskEconomics(updated, { ready: false }, 'revision');

  assert.equal(updated[0].evidence.length, 1);
  assert.equal(updated[0].evidence[0].result, 'failed');
  assert.equal(summary.samples, 1);
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.totals.failedCommands, 1);
});

void test('reconciles a provisional CI identity after it becomes a tombstone', () => {
  const url = 'https://github.test/actions/runs/reconciled-tombstone';
  const provisional = {
    ...ciEvidence({ name: 'build', url, identityUncertain: true }, 'pending', 1),
    sequence: 1,
  };
  const fillers = Array.from({ length: 1_024 }, (_, index) =>
    evidence({
      id: `provisional-tombstone-filler-${index}`,
      kind: 'command',
      name: `filler-${index}`,
      criteria: [],
      timestamp: index + 2,
      sequence: index + 2,
    }),
  );
  const manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 2_000,
      economicsRollup: rollUpEconomics(undefined, [provisional, ...fillers]),
    },
  ];
  const stable = ciEvidence(
    { name: 'build', url, databaseId: 50, runId: 10, attempt: 1 },
    'passed',
    3_000,
  );

  const updated = recordCiEvidenceObservation(manifests, 'revision', criteria, stable);
  const summary = summarizeTaskEconomics(updated, { ready: true }, 'revision');

  assert.equal(updated[0].evidence.length, 1);
  assert.equal(updated[0].evidence[0].id, stable.id);
  assert.equal(summary.samples, 1);
  assert.equal(summary.totals.checks, 1);
  assert.equal(summary.identityCoverageComplete, true);

  const offline: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [provisional],
      stale: false,
      createdAt: 1,
      updatedAt: 2_500,
    },
  ];
  for (const merged of [
    mergeEvidenceManifests(updated, offline),
    mergeEvidenceManifests(offline, updated),
  ]) {
    assert.deepEqual(
      merged[0].evidence.map((entry) => entry.id),
      [stable.id],
    );
    assert.equal(summarizeTaskEconomics(merged, { ready: true }, 'revision').samples, 1);
  }
});

void test('accepts a stable observation for an archived uncertain identity alias', () => {
  const reconciliationKey = 'b'.repeat(16);
  const provisional: TaskEvidence = {
    id: 'ci:provisional-alias',
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'pending',
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/uncertain-alias',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain: true,
    reconciliationKey,
  };
  const canonical = {
    ...provisional,
    id: 'ci:canonical-alias',
    identityUncertain: false,
  };
  const rollup = rekeyArchivedEconomicsEvidence(
    rollUpEconomics(undefined, [provisional]),
    reconciliationKey,
    canonical,
    false,
  );
  const manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 2,
      economicsRollup: rollup,
    },
  ];

  const updated = recordCiEvidenceObservation(manifests, 'revision', criteria, {
    ...provisional,
    result: 'passed',
    timestamp: 3,
    identityUncertain: false,
  });

  assert.deepEqual(updated[0].evidence, []);
  assert.equal(summarizeTaskEconomics(updated, { ready: true }, 'revision').samples, 1);
});

void test('keeps unmatched provisional and stable CI executions distinct', () => {
  const legacy = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence(
      { name: 'build', url: 'https://github.test/actions/runs/unknown', identityUncertain: true },
      'pending',
      10,
    ),
  );
  const known = recordCiEvidenceObservation(
    [],
    'revision',
    criteria,
    ciEvidence(
      { name: 'build', url: 'https://github.test/actions/runs/1', databaseId: 50, runId: 10 },
      'passed',
      20,
    ),
  );
  let manifests = mergeEvidenceManifests(legacy, known);
  manifests = recordCiEvidenceObservation(
    manifests,
    'revision',
    criteria,
    ciEvidence(
      { name: 'build', url: 'https://github.test/actions/runs/2', databaseId: 60, runId: 20 },
      'passed',
      30,
    ),
  );

  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(summary.totals.checks, 3);
  assert.equal(summary.identityCoverageComplete, false);
  assert.equal(manifests[0].evidence.length, 3);
});

void test('retires obsolete identityless CI observations from the active snapshot', () => {
  const failed = ciEvidence({ name: 'build', url: 'https://github.test/jobs/old' }, 'failed', 10);
  const passed = ciEvidence({ name: 'build', url: 'https://github.test/jobs/new' }, 'passed', 20);
  let manifests = recordCiEvidenceObservation([], 'revision', criteria, failed);
  const stale = manifests;
  manifests = reconcileCiEvidenceSnapshot(manifests, 'revision', [passed]);
  manifests = recordCiEvidenceObservation(manifests, 'revision', criteria, passed);

  for (const current of [
    manifests,
    mergeEvidenceManifests(manifests, stale),
    mergeEvidenceManifests(stale, manifests),
  ]) {
    assert.deepEqual(evidenceReadiness(current, 'revision', [], []).failedCommands, []);
    assert.equal(current[0].evidence.length, 1);
    assert.equal(current[0].evidence[0].id, passed.id);
    assert.equal(summarizeTaskEconomics(current, { ready: true }, 'revision').totals.checks, 2);
  }
});

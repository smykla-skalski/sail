import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evidenceReadiness,
  evidenceManifestsSchema,
  mergeEvidenceManifests,
  nextTaskEvidenceSequence,
  requireEvidenceBaseRevision,
  requireEvidenceRevision,
  recordTaskEvidence,
  syncEvidenceManifest,
  type EvidenceManifest,
  type TaskEvidence,
} from '../src/lib/task-evidence.ts';

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

void test('rejects a late evidence snapshot after a newer revision was stored', () => {
  assert.doesNotThrow(() => requireEvidenceBaseRevision('revision-a', undefined));
  assert.doesNotThrow(() => requireEvidenceBaseRevision('revision-a', 'revision-a'));
  assert.throws(() => requireEvidenceBaseRevision('revision-a', 'revision-b'), /concurrently/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archivedEvidenceIdentityLimit,
  emptyTaskEconomics,
  economicsRollupSchema,
  exportTaskEconomics,
  maxEconomicsCounter,
  mergeEconomicsRollups,
  rekeyArchivedEconomicsEvidence,
  rollUpEconomics,
  summarizeTaskEconomics,
  syntheticCiEconomics,
  taskEconomicsSchema,
  totalEconomicsTokens,
  updateArchivedEconomicsEvidence,
  type TaskEconomics,
} from '../src/lib/task-economics.ts';
import {
  mergeEvidenceManifests,
  recordTaskEvidence,
  type EvidenceManifest,
  type TaskEvidence,
} from '../src/lib/task-evidence.ts';

const criteria = ['The accepted result is verified.'];

function metric(overrides: Partial<TaskEconomics> = {}): TaskEconomics {
  return {
    ...emptyTaskEconomics('primary', 'implement'),
    turns: 2,
    toolCalls: 5,
    tokens: { input: 100, output: 50, reasoning: 25, cacheRead: 20, cacheWrite: 5 },
    elapsedMs: 1_000,
    ...overrides,
  };
}

function evidence(id: string, economics: TaskEconomics): TaskEvidence {
  return {
    id,
    kind: 'command',
    name: `private command ${id}`,
    provider: 'codex',
    model: 'gpt-test',
    result: 'passed',
    timestamp: id === 'primary' ? 10 : 20,
    outputReference: `private output ${id}`,
    criteria,
    economics,
  };
}

void test('measures an accepted task and keeps agent roles separate', () => {
  let manifests = recordTaskEvidence([], 'revision', criteria, evidence('primary', metric()));
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence(
      'validator',
      metric({
        role: 'validator',
        phase: 'review',
        turns: 1,
        toolCalls: 2,
        failedCommands: 1,
        approvalLatencyMs: 800,
        repeatedWork: 3,
      }),
    ),
  );

  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(summary.accepted, true);
  assert.equal(summary.samples, 2);
  assert.equal(summary.totals.turns, 3);
  assert.equal(summary.totals.toolCalls, 7);
  assert.equal(summary.totals.tokens.input, 200);
  assert.equal(summary.totals.failedCommands, 1);
  assert.equal(summary.totals.approvalLatencyMs, 800);
  assert.equal(summary.totals.repeatedWork, 3);
  assert.equal(summary.byRole.primary?.turns, 2);
  assert.equal(summary.byRole.validator?.turns, 1);
});

void test('exports counters without command, prompt, criterion, or tool-output bodies', () => {
  const manifests = recordTaskEvidence([], 'revision', criteria, evidence('primary', metric()));
  const exported = exportTaskEconomics(
    [
      {
        task: 'owner/repo#275',
        acceptedRevision: 'revision',
        manifests,
        outcomeAccepted: true,
      },
    ],
    30,
  );
  const json = JSON.stringify(exported);

  assert.equal(exported.schemaVersion, 3);
  assert.equal(exported.tasks[0].accepted, true);
  assert.equal(exported.tasks[0].samples[0].economics.role, 'primary');
  assert.doesNotMatch(json, /private command/);
  assert.doesNotMatch(json, /private output/);
  assert.doesNotMatch(json, /accepted result/);
  assert.doesNotMatch(json, /"(?:prompt|outputReference|criteria|command)":/i);
});

void test('reports zero accepted-task cost before any economics sample exists', () => {
  const summary = summarizeTaskEconomics([], { ready: false }, null);

  assert.equal(summary.accepted, false);
  assert.equal(summary.samples, 0);
  assert.equal(summary.totals.elapsedMs, 0);
  assert.deepEqual(summary.byRole, {});
});

void test('requires at least one measured activity counter', () => {
  const empty = emptyTaskEconomics('primary', 'implement');

  assert.throws(() => taskEconomicsSchema.parse(empty), /at least one unit of measured activity/);
  assert.doesNotThrow(() =>
    taskEconomicsSchema.parse({
      ...empty,
      tokens: { ...empty.tokens, cacheRead: 1 },
    }),
  );
  assert.doesNotThrow(() => taskEconomicsSchema.parse({ ...empty, failedCommands: 1 }));
  assert.doesNotThrow(() => taskEconomicsSchema.parse(syntheticCiEconomics()));
});

void test('does not report accepted economics when acceptance evidence lacks metrics', () => {
  const missing = { ...evidence('primary', metric()), economics: undefined };
  const manifests = recordTaskEvidence([], 'revision', criteria, missing);
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');

  assert.equal(summary.outcomeAccepted, true);
  assert.equal(summary.accepted, false);
  assert.equal(summary.economicsComplete, false);
  assert.equal(summary.lifetimeEconomicsComplete, false);
  assert.equal(summary.missingSamples, 1);
});

void test('keeps acceptance incomplete when an earlier execution lacks economics', () => {
  const missing = { ...evidence('first', metric()), name: 'quality', economics: undefined };
  let manifests = recordTaskEvidence([], 'revision', criteria, missing);
  manifests = recordTaskEvidence(manifests, 'revision', criteria, {
    ...evidence('rerun', metric()),
    name: 'quality',
  });

  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(summary.accepted, false);
  assert.equal(summary.economicsComplete, true);
  assert.equal(summary.lifetimeEconomicsComplete, false);
  assert.equal(summary.missingSamples, 1);
});

void test('includes superseded revision work in the accepted-task cost', () => {
  let manifests = recordTaskEvidence([], 'revision-one', criteria, evidence('primary', metric()));
  manifests = recordTaskEvidence(
    manifests,
    'revision-two',
    criteria,
    evidence('validator', metric({ role: 'validator', phase: 'test', repeatedWork: 1 })),
  );

  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision-two');
  assert.equal(manifests[0].stale, true);
  assert.equal(summary.samples, 2);
  assert.equal(summary.totals.turns, 4);
  assert.equal(summary.totals.repeatedWork, 1);
});

void test('preserves lifetime totals when revision and evidence bounds evict details', () => {
  let manifests: EvidenceManifest[] = [];
  for (let revision = 0; revision < 25; revision += 1)
    manifests = recordTaskEvidence(
      manifests,
      `revision-${revision}`,
      criteria,
      evidence(`revision-${revision}`, metric({ turns: 1 })),
    );
  for (let index = 0; index < 105; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision-24',
      criteria,
      evidence(`bounded-${index}`, metric({ turns: 1 })),
    );

  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision-24');
  assert.equal(manifests.length, 20);
  assert.equal(manifests.at(-1)?.evidence.length, 100);
  assert.equal(summary.lifetimeTruncated, true);
  assert.equal(summary.samples, 130);
  assert.equal(summary.totals.turns, 130);
});

void test('rejects unsafe counters and flags saturated lifetime totals', () => {
  assert.throws(() => taskEconomicsSchema.parse(metric({ turns: maxEconomicsCounter + 1 })));
  let manifests = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence('max-one', metric({ turns: maxEconomicsCounter })),
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence('max-two', metric({ turns: maxEconomicsCounter })),
  );

  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  assert.equal(summary.totals.turns, maxEconomicsCounter);
  assert.equal(summary.overflowed, true);
  assert.equal(summary.lifetimeEconomicsComplete, false);
  assert.equal(summary.accepted, false);
  const exported = exportTaskEconomics([
    {
      task: 'owner/repo#275',
      acceptedRevision: 'revision',
      manifests,
      outcomeAccepted: true,
    },
  ]);
  assert.equal(exported.tasks[0].lifetimeEconomicsComplete, false);
  assert.equal(exported.tasks[0].accepted, false);
});

void test('keeps 201 concurrent distinct records through sequence collisions and bounding', () => {
  let left: EvidenceManifest[] = [];
  let right: EvidenceManifest[] = [];
  for (let index = 0; index < 101; index += 1)
    left = recordTaskEvidence(
      left,
      'revision',
      criteria,
      evidence(`left-${index}`, metric({ turns: 1 })),
    );
  for (let index = 0; index < 100; index += 1)
    right = recordTaskEvidence(
      right,
      'revision',
      criteria,
      evidence(`right-${index}`, metric({ turns: 1 })),
    );

  const merged = mergeEvidenceManifests(left, right);
  const summary = summarizeTaskEconomics(merged, { ready: true }, 'revision');
  const sequences = merged.flatMap((manifest) => manifest.evidence.map((entry) => entry.sequence));
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(merged[0].evidence.length, 100);
  assert.equal(summary.samples, 201);
  assert.equal(summary.totals.turns, 201);
});

void test('losslessly merges divergent archives in either order', () => {
  const common = recordTaskEvidence(
    [],
    'revision',
    criteria,
    evidence('common', metric({ turns: 1 })),
  );
  let left = structuredClone(common);
  let right = structuredClone(common);
  for (let index = 0; index < 100; index += 1) {
    left = recordTaskEvidence(
      left,
      'revision',
      criteria,
      evidence(`left-divergent-${index}`, metric({ turns: 1 })),
    );
    right = recordTaskEvidence(
      right,
      'revision',
      criteria,
      evidence(`right-divergent-${index}`, metric({ turns: 1 })),
    );
  }

  for (const merged of [mergeEvidenceManifests(left, right), mergeEvidenceManifests(right, left)]) {
    const summary = summarizeTaskEconomics(merged, { ready: true }, 'revision');
    assert.equal(summary.samples, 201);
    assert.equal(summary.totals.turns, 201);
    assert.equal(merged[0].economicsRollup?.archivedEntries, 101);
    assert.equal(merged[0].economicsRollup?.archivedEvidence.length, 101);
  }
});

void test('deduplicates shared archive history while retaining both divergent tails', () => {
  let shared: EvidenceManifest[] = [];
  for (let index = 0; index < 101; index += 1)
    shared = recordTaskEvidence(
      shared,
      'revision',
      criteria,
      evidence(`shared-${index}`, metric({ turns: 1 })),
    );
  let left = structuredClone(shared);
  let right = structuredClone(shared);
  for (let index = 0; index < 101; index += 1) {
    left = recordTaskEvidence(
      left,
      'revision',
      criteria,
      evidence(`left-tail-${index}`, metric({ turns: 1 })),
    );
    right = recordTaskEvidence(
      right,
      'revision',
      criteria,
      evidence(`right-tail-${index}`, metric({ turns: 1 })),
    );
  }

  const forward = summarizeTaskEconomics(
    mergeEvidenceManifests(left, right),
    { ready: true },
    'revision',
  );
  const reverse = summarizeTaskEconomics(
    mergeEvidenceManifests(right, left),
    { ready: true },
    'revision',
  );
  assert.equal(forward.samples, 303);
  assert.equal(forward.totals.turns, 303);
  assert.deepEqual(reverse, forward);
});

void test('merges divergent snapshots beyond the former identity horizon exactly', () => {
  let shared: EvidenceManifest[] = [];
  for (let index = 0; index < 400; index += 1)
    shared = recordTaskEvidence(
      shared,
      'revision',
      criteria,
      evidence(`large-shared-${index}`, metric({ turns: 1 })),
    );
  let left = structuredClone(shared);
  let right = structuredClone(shared);
  for (let index = 0; index < 300; index += 1)
    left = recordTaskEvidence(
      left,
      'revision',
      criteria,
      evidence(`large-left-${index}`, metric({ turns: 1 })),
    );
  for (let index = 0; index < 10; index += 1)
    right = recordTaskEvidence(
      right,
      'revision',
      criteria,
      evidence(`large-right-${index}`, metric({ turns: 1 })),
    );

  for (const merged of [mergeEvidenceManifests(left, right), mergeEvidenceManifests(right, left)]) {
    const summary = summarizeTaskEconomics(merged, { ready: true }, 'revision');
    assert.equal(summary.samples, 710);
    assert.equal(summary.totals.turns, 710);
  }
});

void test('retains archived provider, model, role, and phase attribution in safe exports', () => {
  const archived = rollUpEconomics(undefined, [
    {
      ...evidence('attributed-primary', metric({ turns: 1 })),
      sequence: 1,
    },
    {
      ...evidence('attributed-validator', metric({ role: 'validator', phase: 'review', turns: 1 })),
      provider: 'claude',
      model: 'claude-test',
      sequence: 2,
    },
  ]);
  const manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 1,
      economicsRollup: archived,
    },
  ];
  const exported = exportTaskEconomics([
    { task: 'owner/repo#275', acceptedRevision: 'revision', manifests, outcomeAccepted: true },
  ]);

  assert.deepEqual(
    exported.tasks[0].rollup?.byAttribution.map(({ provider, model, role, phase, samples }) => ({
      provider,
      model,
      role,
      phase,
      samples,
    })),
    [
      {
        provider: 'claude',
        model: 'claude-test',
        role: 'validator',
        phase: 'review',
        samples: 1,
      },
      {
        provider: 'codex',
        model: 'gpt-test',
        role: 'primary',
        phase: 'implement',
        samples: 1,
      },
    ],
  );
  const json = JSON.stringify(exported);
  assert.doesNotMatch(json, /attributed-primary|attributed-validator/);
});

void test('does not export archived evidence identities', () => {
  let manifests: EvidenceManifest[] = [];
  for (let index = 0; index < 101; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      criteria,
      evidence(`private-archive-id-${index}`, metric({ turns: 1 })),
    );

  const exported = exportTaskEconomics([
    { task: 'owner/repo#275', acceptedRevision: 'revision', manifests, outcomeAccepted: true },
  ]);
  const json = JSON.stringify(exported);
  assert.equal(exported.tasks[0].rollup?.archivedEvidenceCount, 1);
  assert.doesNotMatch(json, /private-archive-id/);
  assert.doesNotMatch(json, /archivedEvidence"/);
});

void test('selects revision completeness but retains lifetime gaps in either manifest order', () => {
  const accepted = recordTaskEvidence([], 'accepted', criteria, evidence('accepted', metric()))[0];
  const unrelated = {
    ...recordTaskEvidence([], 'unrelated', criteria, {
      ...evidence('unrelated', metric()),
      economics: undefined,
    })[0],
    stale: false,
  };

  for (const manifests of [
    [unrelated, accepted],
    [accepted, unrelated],
  ]) {
    const summary = summarizeTaskEconomics(manifests, { ready: true }, 'accepted');
    assert.equal(summary.accepted, false);
    assert.equal(summary.economicsComplete, true);
    assert.equal(summary.lifetimeEconomicsComplete, false);
    assert.equal(summary.missingSamples, 1);
  }
  const exported = exportTaskEconomics([
    {
      task: 'owner/repo#275',
      acceptedRevision: 'accepted',
      manifests: [unrelated, accepted],
      outcomeAccepted: true,
    },
  ]);
  assert.equal(exported.tasks[0].accepted, false);
});

void test('validates archived idempotent retries and rejects conflicting reuse', () => {
  let manifests: EvidenceManifest[] = [];
  for (let index = 0; index < 101; index += 1)
    manifests = recordTaskEvidence(
      manifests,
      'revision',
      criteria,
      evidence(`archive-${index}`, metric({ turns: 1 })),
    );

  assert.throws(
    () =>
      recordTaskEvidence(
        manifests,
        'revision',
        criteria,
        evidence('archive-0', metric({ turns: 2 })),
      ),
    /reused with different content/,
  );
  manifests = recordTaskEvidence(
    manifests,
    'revision',
    criteria,
    evidence('archive-0', metric({ turns: 1 })),
  );
  assert.equal(summarizeTaskEconomics(manifests, { ready: true }, 'revision').totals.turns, 101);
});

void test('continues aggregation after the archived identity horizon truncates', () => {
  const entries = Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
    ...evidence(`horizon-${index}`, metric({ turns: 1 })),
    sequence: index + 1,
  }));
  const rollup = rollUpEconomics(undefined, entries);

  assert.equal(rollup.archivedEntries, archivedEvidenceIdentityLimit + 1);
  assert.equal(rollup.samples, archivedEvidenceIdentityLimit + 1);
  assert.equal(rollup.totals.turns, archivedEvidenceIdentityLimit + 1);
  assert.equal(rollup.archivedEvidence.length, archivedEvidenceIdentityLimit);
  assert.equal(rollup.archivedTombstones.length, 1);
  assert.equal(rollup.identityCoverageComplete, true);

  const continued = rollUpEconomics(rollup, [
    { ...evidence('after-horizon', metric({ turns: 1 })), sequence: entries.length + 1 },
  ]);
  assert.equal(continued.totals.turns, archivedEvidenceIdentityLimit + 2);
  assert.equal(continued.identityCoverageComplete, true);

  const summary = summarizeTaskEconomics(
    [
      {
        revision: 'revision',
        acceptanceCriteria: criteria,
        evidence: [],
        stale: false,
        createdAt: 1,
        updatedAt: 1,
        economicsRollup: continued,
      },
    ],
    { ready: true },
    'revision',
  );
  assert.equal(summary.identityCoverageComplete, true);
  assert.equal(summary.lifetimeEconomicsComplete, true);
  assert.equal(summary.accepted, true);
});

void test('marks identity coverage incomplete after tombstone identities overflow', () => {
  const entries = Array.from({ length: archivedEvidenceIdentityLimit * 2 + 1 }, (_, index) => ({
    ...evidence(`tombstone-horizon-${index}`, metric({ turns: 1 })),
    sequence: index + 1,
  }));
  const rollup = rollUpEconomics(undefined, entries);

  assert.equal(rollup.archivedTombstones.length, archivedEvidenceIdentityLimit);
  assert.equal(rollup.identityCoverageComplete, false);
});

void test('sums token categories exactly beyond the safe integer range', () => {
  const tokens = {
    input: maxEconomicsCounter,
    output: maxEconomicsCounter,
    reasoning: maxEconomicsCounter,
    cacheRead: maxEconomicsCounter,
    cacheWrite: maxEconomicsCounter,
  };

  const total = totalEconomicsTokens(tokens);
  assert.equal(total, BigInt(maxEconomicsCounter) * 5n);
  assert.equal(total.toLocaleString('en-US'), '45,035,996,273,704,955');
});

void test('rejects divergent archive merges after the bounded identity horizon', () => {
  const entries = Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
    ...evidence(`shared-horizon-${index}`, metric({ turns: 1 })),
    sequence: index + 1,
  }));
  const shared = rollUpEconomics(undefined, entries);
  const left = rollUpEconomics(shared, [
    {
      ...evidence('left-after-horizon', metric({ turns: 1 })),
      sequence: entries.length + 1,
    },
  ]);
  const right = rollUpEconomics(shared, [
    {
      ...evidence('right-after-horizon', metric({ turns: 1 })),
      sequence: entries.length + 1,
    },
  ]);

  assert.throws(
    () => mergeEconomicsRollups([left, right]),
    /Cannot safely merge economics archives beyond the identity horizon/,
  );
});

void test('uses causal digests for truncated successor commutativity and hidden divergence', () => {
  const entries = Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
    ...evidence(`causal-${index}`, metric({ turns: 1 })),
    sequence: index + 1,
  }));
  const ancestor = rollUpEconomics(undefined, entries);
  const successor = rollUpEconomics(ancestor, [
    {
      ...evidence('causal-successor', metric({ turns: 1 })),
      sequence: entries.length + 1,
    },
  ]);

  assert.deepEqual(mergeEconomicsRollups([ancestor, successor]), successor);
  assert.deepEqual(mergeEconomicsRollups([successor, ancestor]), successor);
  assert.deepEqual(mergeEconomicsRollups([successor, successor]), successor);

  const hiddenDivergence = { ...structuredClone(ancestor), causalDigest: 'f'.repeat(32) };
  assert.throws(
    () => mergeEconomicsRollups([successor, hiddenDivergence]),
    /state digest does not match its contents/,
  );
});

void test('migrates complete legacy rollups and fails closed for truncated legacy history', () => {
  const complete = rollUpEconomics(undefined, [
    { ...evidence('legacy-complete', metric({ turns: 1 })), sequence: 1 },
  ]);
  const legacyComplete = economicsRollupSchema.parse({
    ...complete,
    causalDigest: undefined,
    causalAncestors: undefined,
    causalProofComplete: undefined,
    causalProofVersion: undefined,
    stateVersion: undefined,
    stateDigest: undefined,
  });
  assert.equal(legacyComplete.causalProofComplete, false);
  const migrated = rollUpEconomics(legacyComplete, [
    { ...evidence('legacy-next', metric({ turns: 1 })), sequence: 2 },
  ]);
  assert.equal(migrated.causalProofComplete, true);

  const truncated = rollUpEconomics(
    undefined,
    Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
      ...evidence(`legacy-truncated-${index}`, metric({ turns: 1 })),
      sequence: index + 1,
    })),
  );
  const legacyTruncated = economicsRollupSchema.parse({
    ...truncated,
    causalDigest: undefined,
    causalAncestors: undefined,
    causalProofComplete: undefined,
    causalProofVersion: undefined,
    stateVersion: undefined,
    stateDigest: undefined,
  });
  const unprovable = rollUpEconomics(legacyTruncated, [
    {
      ...evidence('legacy-truncated-next', metric({ turns: 1 })),
      sequence: archivedEvidenceIdentityLimit + 2,
    },
  ]);
  assert.equal(unprovable.causalProofComplete, false);
  assert.deepEqual(mergeEconomicsRollups([legacyTruncated, unprovable]), unprovable);
  const divergent = rollUpEconomics(legacyTruncated, [
    {
      ...evidence('legacy-truncated-divergent', metric({ turns: 1 })),
      sequence: archivedEvidenceIdentityLimit + 3,
    },
  ]);
  assert.throws(
    () => mergeEconomicsRollups([unprovable, divergent]),
    /Cannot safely merge economics archives beyond the identity horizon/,
  );
});

void test('rejects unequal-generation divergent legacy archive descendants', () => {
  const truncated = rollUpEconomics(
    undefined,
    Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
      ...evidence(`legacy-root-${index}`, metric({ turns: 1 })),
      sequence: index + 1,
    })),
  );
  const legacy = economicsRollupSchema.parse({
    ...truncated,
    causalProofComplete: false,
    causalProofVersion: 1,
    causalAncestors: [],
    incompleteCausalLineage: null,
    incompleteCausalGeneration: 0,
    incompleteCausalAncestors: [],
    stateVersion: undefined,
    stateDigest: undefined,
  });
  const firstBranch = rollUpEconomics(
    rollUpEconomics(legacy, [
      {
        ...evidence('legacy-first-1', metric({ turns: 1 })),
        sequence: archivedEvidenceIdentityLimit + 2,
      },
    ]),
    [
      {
        ...evidence('legacy-first-2', metric({ turns: 1 })),
        sequence: archivedEvidenceIdentityLimit + 3,
      },
    ],
  );
  const secondBranch = rollUpEconomics(legacy, [
    {
      ...evidence('legacy-second', metric({ turns: 1 })),
      sequence: archivedEvidenceIdentityLimit + 2,
    },
  ]);

  assert.equal(firstBranch.incompleteCausalGeneration, 2);
  assert.equal(secondBranch.incompleteCausalGeneration, 1);
  assert.throws(
    () => mergeEconomicsRollups([firstBranch, secondBranch]),
    /Cannot safely merge economics archives beyond the identity horizon/,
  );
});

void test('canonically merges equal-sequence stored archive entries', () => {
  const leftEntry = { ...evidence('equal-left', metric({ turns: 1 })), sequence: 1 };
  const rightEntry = { ...evidence('equal-right', metric({ turns: 2 })), sequence: 1 };
  const left = rollUpEconomics(undefined, [leftEntry]);
  const right = rollUpEconomics(undefined, [rightEntry]);
  const expected = rollUpEconomics(undefined, [leftEntry, rightEntry]);
  const forward = mergeEconomicsRollups([left, right]);
  const reverse = mergeEconomicsRollups([right, left]);
  assert.equal(forward?.causalDigest, expected.causalDigest);
  assert.equal(reverse?.causalDigest, expected.causalDigest);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(mergeEconomicsRollups([forward, forward]), forward);
});

void test('canonicalizes equivalent CI update and archive orders after truncation', () => {
  const pending: TaskEvidence = {
    id: 'ci:canonical-order',
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'pending',
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/actions/runs/1',
    criteria: [],
    economics: syntheticCiEconomics(),
  };
  const failed: TaskEvidence = {
    ...pending,
    result: 'failed',
    timestamp: 2,
    economics: { ...syntheticCiEconomics(), failedCommands: 1 },
  };
  const updatedFirst = updateArchivedEconomicsEvidence(
    rollUpEconomics(undefined, [pending]),
    failed,
  );
  const archivedFinal = rollUpEconomics(undefined, [failed]);
  const fillers = Array.from({ length: archivedEvidenceIdentityLimit }, (_, index) => ({
    ...evidence(`canonical-filler-${index}`, metric({ turns: 1 })),
    sequence: index + 2,
  }));
  const left = rollUpEconomics(updatedFirst, fillers);
  const right = rollUpEconomics(archivedFinal, fillers);
  assert.equal(left.causalDigest, right.causalDigest);
  assert.deepEqual(mergeEconomicsRollups([left, right]), mergeEconomicsRollups([right, left]));
});

void test('rejects inserts before a persisted causal prefix', () => {
  const entries = Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
    ...evidence(`prefix-${index}`, metric({ turns: 1 })),
    sequence: index + 2,
  }));
  const truncated = rollUpEconomics(undefined, entries);
  assert.throws(
    () =>
      rollUpEconomics(truncated, [
        { ...evidence('late-prefix', metric({ turns: 1 })), sequence: 1 },
      ]),
    /before the causal archive prefix/,
  );
});

void test('rejects a successor whose state changed after its ancestry was sealed', () => {
  const entries = Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
    ...evidence(`sealed-${index}`, metric({ turns: 1 })),
    sequence: index + 1,
  }));
  const ancestor = rollUpEconomics(undefined, entries);
  const successor = rollUpEconomics(ancestor, [
    {
      ...evidence('sealed-successor', metric({ turns: 1 })),
      sequence: archivedEvidenceIdentityLimit + 2,
    },
  ]);
  successor.totals.turns = 999_999;

  assert.throws(
    () => mergeEconomicsRollups([ancestor, successor]),
    /state digest does not match its contents/,
  );
});

void test('deduplicates a provisional rekey that collides with archived stable evidence', () => {
  const reconciliationKey = 'a'.repeat(16);
  const reference = 'https://github.test/runs/1';
  const provisional: TaskEvidence = {
    id: 'ci:provisional',
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'pending',
    timestamp: 1,
    sequence: 1,
    outputReference: reference,
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain: true,
    reconciliationKey,
  };
  const stable: TaskEvidence = {
    ...provisional,
    id: 'ci:stable',
    result: 'passed',
    timestamp: 2,
    sequence: 2,
    identityUncertain: false,
  };
  const rollup = rollUpEconomics(undefined, [provisional, stable]);
  const rekeyed = rekeyArchivedEconomicsEvidence(rollup, reconciliationKey, stable, false);
  assert.equal(rekeyed.archivedEntries, 1);
  assert.equal(rekeyed.samples, 1);
  assert.equal(rekeyed.totals.checks, 1);
  assert.equal(rekeyed.archivedEvidence.length, 1);
  assert.equal(rekeyed.identityCoverageComplete, true);
});

void test('requires sealed state for versioned rollups', () => {
  const rollup = rollUpEconomics(undefined, [
    { ...evidence('sealed-version', metric({ turns: 1 })), sequence: 1 },
  ]);
  const corrupted = { ...structuredClone(rollup), stateDigest: null };
  assert.throws(
    () => mergeEconomicsRollups([corrupted]),
    /state digest does not match its contents/,
  );
});

void test('does not subtract from saturated reconciliation totals', () => {
  const reconciliationKey = 'b'.repeat(16);
  const gate = {
    ...evidence('saturated-gate', metric({ checks: maxEconomicsCounter })),
    sequence: 1,
  };
  const provisional: TaskEvidence = {
    id: 'ci:saturated-provisional',
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'pending',
    timestamp: 2,
    sequence: 2,
    outputReference: 'https://github.test/runs/saturated',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain: true,
    reconciliationKey,
  };
  const stable = {
    ...provisional,
    id: 'ci:saturated-stable',
    result: 'passed' as const,
    timestamp: 3,
    sequence: 3,
    identityUncertain: false,
  };
  const rollup = rollUpEconomics(undefined, [gate, provisional, stable]);
  const saturatedAttributions = structuredClone(rollup.byAttribution);
  for (const attribution of saturatedAttributions) attribution.samples = maxEconomicsCounter;
  const saturated = economicsRollupSchema.parse({
    ...rollup,
    archivedEntries: maxEconomicsCounter,
    samples: maxEconomicsCounter,
    byAttribution: saturatedAttributions,
    overflowed: true,
    stateVersion: 0,
    stateDigest: null,
  });
  const reconciled = rekeyArchivedEconomicsEvidence(saturated, reconciliationKey, stable, false);
  assert.equal(reconciled.totals.checks, maxEconomicsCounter);
  assert.equal(reconciled.archivedEntries, maxEconomicsCounter);
  assert.equal(reconciled.samples, maxEconomicsCounter);
  assert.equal(reconciled.byAttribution[0].samples, maxEconomicsCounter);
  assert.equal(reconciled.overflowed, true);
});

void test('preserves complete ancestry across a visible truncated rekey', () => {
  const reconciliationKey = 'c'.repeat(16);
  const fillers = Array.from({ length: archivedEvidenceIdentityLimit - 1 }, (_, index) => ({
    ...evidence(`rekey-filler-${index}`, metric({ turns: 1 })),
    sequence: index + 1,
  }));
  const provisional: TaskEvidence = {
    id: 'ci:rekey-provisional',
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'pending',
    timestamp: archivedEvidenceIdentityLimit,
    sequence: archivedEvidenceIdentityLimit,
    outputReference: 'https://github.test/runs/rekey',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain: true,
    reconciliationKey,
  };
  const stable = {
    ...provisional,
    id: 'ci:rekey-stable',
    result: 'passed' as const,
    timestamp: archivedEvidenceIdentityLimit + 1,
    sequence: archivedEvidenceIdentityLimit + 1,
    identityUncertain: false,
  };
  const ancestor = rollUpEconomics(undefined, [...fillers, provisional, stable]);
  const successor = rekeyArchivedEconomicsEvidence(ancestor, reconciliationKey, stable, false);
  assert.equal(successor.causalProofComplete, true);
  assert.deepEqual(mergeEconomicsRollups([ancestor, successor]), successor);
});

void test('collapses excess attribution keys into deterministic buckets', () => {
  const rollup = rollUpEconomics(
    undefined,
    Array.from({ length: archivedEvidenceIdentityLimit + 1 }, (_, index) => ({
      ...evidence(`attribution-${index}`, metric({ turns: 1 })),
      provider: `provider-${index}`,
      sequence: index + 1,
    })),
  );
  assert.equal(rollup.byAttribution.length, 1);
  assert.equal(rollup.byAttribution[0].provider, 'overflow');
  assert.equal(rollup.byAttribution[0].model, null);
  assert.equal(rollup.byAttribution[0].bucket, true);
  assert.equal(rollup.byAttribution[0].samples, archivedEvidenceIdentityLimit + 1);
  assert.equal(rollup.byAttribution[0].totals.turns, archivedEvidenceIdentityLimit + 1);
  assert.equal(rollup.attributionCoverageComplete, false);

  const manifests: EvidenceManifest[] = [
    {
      revision: 'revision',
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: 1,
      updatedAt: 1,
      economicsRollup: rollup,
    },
  ];
  const summary = summarizeTaskEconomics(manifests, { ready: true }, 'revision');
  const exported = exportTaskEconomics([
    {
      task: 'owner/repo#275',
      acceptedRevision: 'revision',
      manifests,
      outcomeAccepted: true,
    },
  ]);

  assert.equal(summary.attributionCoverageComplete, false);
  assert.equal(summary.lifetimeEconomicsComplete, false);
  assert.equal(summary.accepted, false);
  assert.equal(exported.tasks[0].attributionCoverageComplete, false);
  assert.equal(exported.tasks[0].rollup?.attributionCoverageComplete, false);
});

void test('preserves every reconciled identity when an archived CI execution stabilizes', () => {
  const reconciliationKey = 'd'.repeat(16);
  const observation = (id: string, timestamp: number): TaskEvidence => ({
    id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'passed',
    timestamp,
    sequence: 1,
    outputReference: 'https://github.test/runs/rekey-chain',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain: true,
    reconciliationKey,
  });
  const original = observation('ci:provisional-0', 1);
  let rollup = rollUpEconomics(undefined, [original]);
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:provisional-1', 2),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:provisional-2', 3),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:provisional-3', 4),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:provisional-4', 5),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:provisional-5', 6),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:provisional-6', 7),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    { ...observation('ci:stable', 10), identityUncertain: false },
    false,
  );

  const replayed = rollUpEconomics(rollup, [original]);

  assert.equal(rollup.identityCoverageComplete, true);
  assert.equal(replayed.archivedEntries, 1);
  assert.equal(replayed.samples, 1);
  assert.equal(replayed.totals.checks, 1);
});

void test('preserves a provisional alias chain when reconciliation collides', () => {
  const reconciliationKey = 'e'.repeat(16);
  const observation = (id: string, identityUncertain = true): TaskEvidence => ({
    id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'passed',
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/alias-collision',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain,
    reconciliationKey,
  });
  const original = observation('ci:collision-provisional-0');
  let rollup = rollUpEconomics(undefined, [original]);
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:collision-provisional-1'),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:collision-provisional-2'),
    true,
  );
  const stable = observation('ci:collision-stable', false);
  rollup = rollUpEconomics(rollup, [stable]);
  rollup = rekeyArchivedEconomicsEvidence(rollup, reconciliationKey, stable, false);

  const replayed = rollUpEconomics(rollup, [original]);

  assert.equal(rollup.archivedEvidence[0].identityAliases.length, 3);
  assert.equal(replayed.archivedEntries, 1);
  assert.equal(replayed.samples, 1);
  assert.equal(replayed.totals.checks, 1);
});

void test('updates mutable CI economics through an archived identity alias', () => {
  const reconciliationKey = 'f'.repeat(16);
  const observation = (
    id: string,
    result: TaskEvidence['result'] = 'passed',
    identityUncertain = true,
  ): TaskEvidence => ({
    id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result,
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/alias-update',
    criteria: [],
    economics: {
      ...syntheticCiEconomics(),
      failedCommands: result === 'failed' ? 1 : 0,
    },
    identityUncertain,
    reconciliationKey,
  });
  let rollup = rollUpEconomics(undefined, [observation('ci:first-provisional')]);
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:first-stable'),
    true,
  );
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:canonical-stable', 'passed', false),
    false,
  );
  rollup = rollUpEconomics(rollup, [observation('ci:second-provisional')]);
  rollup = rekeyArchivedEconomicsEvidence(
    rollup,
    reconciliationKey,
    observation('ci:first-stable', 'failed', false),
    false,
  );

  assert.equal(rollup.archivedEntries, 1);
  assert.equal(rollup.totals.failedCommands, 1);
  assert.equal(rollup.archivedEvidence[0].economics?.failedCommands, 1);
});

void test('rejects archive merges whose identity alias graphs overlap', () => {
  const reconciliationKey = '1'.repeat(16);
  const observation = (id: string, identityUncertain = true): TaskEvidence => ({
    id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'passed',
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/divergent-alias',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain,
    reconciliationKey,
  });
  const base = rollUpEconomics(undefined, [observation('ci:shared-provisional')]);
  const left = rekeyArchivedEconomicsEvidence(
    base,
    reconciliationKey,
    observation('ci:left-stable', false),
    false,
  );
  const right = rekeyArchivedEconomicsEvidence(
    base,
    reconciliationKey,
    observation('ci:right-stable', false),
    false,
  );

  assert.throws(
    () => mergeEconomicsRollups([left, right]),
    /overlapping archived evidence identities/,
  );
});

void test('subsumes a stale canonical archive after rekeying', () => {
  const reconciliationKey = '2'.repeat(16);
  const observation = (id: string, identityUncertain = true): TaskEvidence => ({
    id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'passed',
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/stale-canonical',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain,
    reconciliationKey,
  });
  const ancestor = rollUpEconomics(undefined, [observation('ci:stale-canonical')]);
  const successor = rekeyArchivedEconomicsEvidence(
    ancestor,
    reconciliationKey,
    observation('ci:stable-successor', false),
    false,
  );

  const forward = mergeEconomicsRollups([ancestor, successor]);
  const reverse = mergeEconomicsRollups([successor, ancestor]);
  assert.deepEqual(forward, reverse);
  for (const merged of [forward, reverse]) {
    assert.equal(merged?.archivedEntries, 1);
    assert.equal(merged?.samples, 1);
    assert.equal(merged?.totals.checks, 1);
    assert.equal(
      merged?.archivedEvidence[0].identityDigest,
      successor.archivedEvidence[0].identityDigest,
    );
    assert.deepEqual(
      merged?.archivedEvidence[0].identityAliases,
      successor.archivedEvidence[0].identityAliases,
    );
  }
});

void test('preserves mutable CI failures while subsuming a rekeyed archive', () => {
  const reconciliationKey = '4'.repeat(16);
  const observation = (
    id: string,
    failedCommands: number,
    identityUncertain: boolean,
  ): TaskEvidence => ({
    id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: failedCommands > 0 ? 'failed' : 'pending',
    timestamp: failedCommands + 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/subsumed-update',
    criteria: [],
    economics: { ...syntheticCiEconomics(), failedCommands },
    identityUncertain,
    reconciliationKey,
  });
  const ancestor = rollUpEconomics(undefined, [observation('ci:provisional', 0, true)]);
  const updated = updateArchivedEconomicsEvidence(ancestor, observation('ci:provisional', 4, true));
  const rekeyed = rekeyArchivedEconomicsEvidence(
    ancestor,
    reconciliationKey,
    observation('ci:stable', 0, false),
    false,
  );

  const updatedFirst = mergeEconomicsRollups([updated, rekeyed]);
  const rekeyedFirst = mergeEconomicsRollups([rekeyed, updated]);

  assert.equal(updatedFirst?.totals.failedCommands, 4);
  assert.equal(updatedFirst?.archivedEvidence[0].economics?.failedCommands, 4);
  assert.equal(rekeyedFirst?.totals.failedCommands, 4);
  assert.equal(rekeyedFirst?.archivedEvidence[0].economics?.failedCommands, 4);
});

void test('merges concurrent mutable CI counters by their greatest value', () => {
  const pending: TaskEvidence = {
    id: 'ci:concurrent-update',
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'pending',
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/concurrent-update',
    criteria: [],
    economics: syntheticCiEconomics(),
  };
  const ancestor = rollUpEconomics(undefined, [pending]);
  const nineFailures = updateArchivedEconomicsEvidence(ancestor, {
    ...pending,
    result: 'failed',
    timestamp: 10,
    economics: { ...syntheticCiEconomics(), failedCommands: 9 },
  });
  const tenFailures = updateArchivedEconomicsEvidence(ancestor, {
    ...pending,
    result: 'failed',
    timestamp: 11,
    economics: { ...syntheticCiEconomics(), failedCommands: 10 },
  });

  const nineFirst = mergeEconomicsRollups([nineFailures, tenFailures]);
  const tenFirst = mergeEconomicsRollups([tenFailures, nineFailures]);

  assert.equal(nineFirst?.totals.failedCommands, 10);
  assert.equal(nineFirst?.archivedEvidence[0].economics?.failedCommands, 10);
  assert.equal(tenFirst?.totals.failedCommands, 10);
  assert.equal(tenFirst?.archivedEvidence[0].economics?.failedCommands, 10);
});

void test('canonically merges converged alias branches', () => {
  const reconciliationKey = '3'.repeat(16);
  const observation = (id: string, identityUncertain = true): TaskEvidence => ({
    id,
    kind: 'command',
    name: 'ci:build',
    provider: 'github',
    model: null,
    result: 'passed',
    timestamp: 1,
    sequence: 1,
    outputReference: 'https://github.test/runs/converged-aliases',
    criteria: [],
    economics: syntheticCiEconomics(),
    identityUncertain,
    reconciliationKey,
  });
  const ancestor = rollUpEconomics(undefined, [observation('ci:common-ancestor')]);
  const branch = (intermediate: string) =>
    rekeyArchivedEconomicsEvidence(
      rekeyArchivedEconomicsEvidence(ancestor, reconciliationKey, observation(intermediate), true),
      reconciliationKey,
      observation('ci:converged-stable', false),
      false,
    );
  const left = branch('ci:left-intermediate');
  const right = branch('ci:right-intermediate');
  const forward = mergeEconomicsRollups([left, right]);
  const reverse = mergeEconomicsRollups([right, left]);

  assert.deepEqual(forward, reverse);
  assert.equal(forward?.stateDigest, reverse?.stateDigest);
  assert.deepEqual(
    forward?.archivedEvidence[0].identityAliases,
    forward?.archivedEvidence[0].identityAliases.toSorted((leftAlias, rightAlias) =>
      leftAlias.identityDigest.localeCompare(rightAlias.identityDigest),
    ),
  );
});

void test('rejects active evidence that conflicts with archived content', () => {
  const archived = { ...evidence('conflicting-active', metric({ turns: 1 })), sequence: 1 };
  const rollup = rollUpEconomics(undefined, [archived]);
  const manifest: EvidenceManifest = {
    revision: 'revision',
    acceptanceCriteria: criteria,
    evidence: [
      {
        ...archived,
        name: 'changed command',
        outputReference: 'changed output',
        economics: metric({ turns: 99 }),
      },
    ],
    stale: false,
    createdAt: 1,
    updatedAt: 2,
    economicsRollup: rollup,
  };

  assert.throws(
    () => summarizeTaskEconomics([manifest], { ready: true }, 'revision'),
    /conflicting content/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoReplayRegressions,
  assertReplayCoverage,
  compareFailureReplay,
  failureReplayCorpusSchema,
  runFailureReplay,
  summarizeFailureReplay,
  type FailureReplayObservation,
} from '../src/lib/failure-replay.ts';

const corpus = {
  schemaVersion: 1 as const,
  name: 'redacted-failures',
  cases: [
    {
      id: 'stale-evidence',
      title: 'Stale evidence',
      redacted: true as const,
      failureClass: 'evidence-freshness',
      prompt: 'Use <REDACTED_REPOSITORY> and replace stale evidence.',
      expectedBehavior: ['Report current evidence.'],
      tags: ['evidence'],
    },
  ],
};

const matrix = {
  release: 'candidate',
  providers: ['claude', 'codex', 'opencode'] as const,
  profiles: [
    { id: 'default', description: 'Default shipping workflow' },
    { id: 'high-risk', description: 'High-risk shipping workflow' },
  ],
};

function observation(overrides: Partial<FailureReplayObservation> = {}): FailureReplayObservation {
  const grade = { passed: true, evidence: ['Observed in the bounded run output.'] };
  return {
    grades: {
      ownership: grade,
      acceptance: grade,
      evidenceFreshness: grade,
      permissionBehavior: grade,
      recovery: grade,
      finalOutcome: grade,
    },
    outcomeAccepted: true,
    metrics: {
      elapsedMs: 100,
      turns: 2,
      toolCalls: 3,
      permissionRequests: 0,
      retries: 0,
      humanInterventions: 0,
      failedCommands: 0,
      repeatedWork: 0,
    },
    outputReference: 'runs/result.json',
    ...overrides,
  };
}

void test('validates that the shared corpus is redacted and uniquely identified', () => {
  assert.deepEqual(failureReplayCorpusSchema.parse(corpus), corpus);
  assert.throws(
    () =>
      failureReplayCorpusSchema.parse({
        ...corpus,
        cases: [{ ...corpus.cases[0], redacted: false }],
      }),
    /Invalid input/,
  );
  assert.throws(
    () =>
      failureReplayCorpusSchema.parse({
        ...corpus,
        cases: [corpus.cases[0], corpus.cases[0]],
      }),
    /unique/,
  );
});

void test('runs every provider, profile, and case with stable isolated identities', async () => {
  const seen: string[] = [];
  const report = await runFailureReplay(corpus, matrix, async (invocation) => {
    seen.push(`${invocation.runId}:${invocation.seed}`);
    return observation();
  });

  assert.equal(report.results.length, 6);
  assert.equal(new Set(seen).size, 6);
  assert.equal(
    report.results.every((result) => result.accepted),
    true,
  );
  assert.doesNotThrow(() => assertReplayCoverage(report, corpus));

  const repeated = await runFailureReplay(corpus, matrix, async () => observation());
  assert.deepEqual(
    repeated.results.map(({ runId, seed }) => ({ runId, seed })),
    report.results.map(({ runId, seed }) => ({ runId, seed })),
  );
});

void test('bounds parallel replay work without changing result order', async () => {
  let active = 0;
  let maximumActive = 0;
  const report = await runFailureReplay(
    corpus,
    matrix,
    async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return observation();
    },
    2,
  );
  assert.equal(maximumActive, 2);
  assert.deepEqual(
    report.results.map((result) => result.provider),
    ['claude', 'claude', 'codex', 'codex', 'opencode', 'opencode'],
  );
  await assert.rejects(() => runFailureReplay(corpus, matrix, async () => observation(), 0), /1/);
});

void test('requires every grade and the final outcome before accepting a task', async () => {
  const report = await runFailureReplay(
    corpus,
    { ...matrix, providers: ['codex'], profiles: [matrix.profiles[0]] },
    async () => {
      const value = observation();
      value.grades.permissionBehavior = {
        passed: false,
        evidence: ['The denied command was retried unchanged.'],
      };
      return value;
    },
  );
  assert.equal(report.results[0].accepted, false);
  assert.equal(summarizeFailureReplay(report.results).acceptanceRate, 0);
});

void test('compares releases by workflow route, grade, and accepted-task cost', async () => {
  const oneRoute = { ...matrix, providers: ['codex'] as const, profiles: [matrix.profiles[0]] };
  const baseline = await runFailureReplay(corpus, oneRoute, async () => observation());
  const slower = await runFailureReplay(corpus, { ...oneRoute, release: 'slower' }, async () =>
    observation({ metrics: { ...observation().metrics, turns: 4 } }),
  );
  const costRegressions = compareFailureReplay(baseline, slower);
  assert.deepEqual(
    costRegressions.map(({ scope, metric }) => ({ scope, metric })),
    [
      { scope: 'all', metric: 'acceptedTaskMetrics.turns' },
      { scope: 'codex/default', metric: 'acceptedTaskMetrics.turns' },
    ],
  );
  assert.throws(() => assertNoReplayRegressions(costRegressions), /acceptedTaskMetrics.turns/);

  const failed = await runFailureReplay(corpus, { ...oneRoute, release: 'failed' }, async () =>
    observation({ outcomeAccepted: false }),
  );
  assert.deepEqual(
    compareFailureReplay(baseline, failed).map((regression) => regression.metric),
    ['acceptanceRate', 'acceptanceRate'],
  );
});

void test('rejects comparisons that silently omit a baseline route', async () => {
  const baseline = await runFailureReplay(corpus, matrix, async () => observation());
  const candidate = await runFailureReplay(
    corpus,
    { ...matrix, release: 'partial', providers: ['codex'] },
    async () => observation(),
  );
  assert.throws(() => compareFailureReplay(baseline, candidate), /missing runs/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedFailureExcerpt,
  ciFailureId,
  ciFailurePrompt,
  ciTriageEconomics,
  classifyCiFailure,
  recordCiFailureTriage,
  rerunDecision,
  resolveCiFailureTriages,
  triageCiFailure,
} from '../src/lib/ci-failure-triage.ts';

const policy = { allowed: ['flaky', 'infrastructure'] as const, maxAttempts: 2 };

void test('deduplicates failures by revision, workflow, job, and attempt', () => {
  const identity = { revision: 'abc', workflow: 'CI', job: 'test', attempt: 1 };
  assert.equal(ciFailureId(identity), ciFailureId({ ...identity }));
  assert.notEqual(ciFailureId(identity), ciFailureId({ ...identity, attempt: 2 }));

  const triage = triageCiFailure(
    { ...identity, log: 'error: compile failed', url: 'job' },
    policy,
    1,
  );
  const once = recordCiFailureTriage([], triage);
  const twice = recordCiFailureTriage(once.records, { ...triage, routedAt: 2 });
  assert.equal(twice.duplicate, true);
  assert.deepEqual(twice.records, once.records);
});

void test('extracts bounded failure context and classifies common failures', () => {
  const log = [
    ...Array.from({ length: 100 }, (_, index) => `setup ${index}`),
    'src/main.ts:12: compile error: expected string',
    'received: number',
    ...Array.from({ length: 100 }, (_, index) => `cleanup ${index}`),
  ].join('\n');
  const excerpt = boundedFailureExcerpt(log);
  assert.match(excerpt, /compile error/);
  assert.ok(excerpt.length < log.length);
  assert.equal(classifyCiFailure(log), 'code');
  assert.equal(classifyCiFailure('EAI_AGAIN: network service unavailable'), 'infrastructure');
  assert.equal(classifyCiFailure('flaky test passed on retry'), 'flaky');
  assert.equal(classifyCiFailure('process stopped'), 'unknown');
});

void test('requires policy to allow a rerun and enforces attempt limits', () => {
  assert.deepEqual(rerunDecision('code', 1, policy), {
    allowed: false,
    reason: 'code failures are not allowed by rerun policy',
  });
  assert.equal(rerunDecision('flaky', 1, policy).allowed, true);
  assert.equal(rerunDecision('flaky', 2, policy).allowed, false);
  assert.throws(() => rerunDecision('flaky', 1, { allowed: ['flaky'], maxAttempts: 0 }));
});

void test('tracks recurrence, resolution, metrics, and concise routing evidence', () => {
  const first = triageCiFailure(
    {
      revision: 'abc',
      workflow: 'CI',
      job: 'test',
      attempt: 1,
      log: 'flaky test failed',
      url: 'https://example.test/job/1',
    },
    policy,
    10,
  );
  const second = triageCiFailure(
    { ...first, revision: 'def', attempt: 2, log: 'flaky test failed' },
    policy,
    20,
  );
  const recorded = recordCiFailureTriage(recordCiFailureTriage([], first).records, second).triage;
  assert.equal(recorded.recurrence, 2);
  assert.equal(ciTriageEconomics(recorded).repeatedWork, 1);
  assert.match(ciFailurePrompt(recorded), /Rerun policy: not allowed/);
  const resolved = resolveCiFailureTriages([recorded], 'def', new Set(['test']), 30);
  assert.equal(resolved[0].resolvedAt, 30);
});

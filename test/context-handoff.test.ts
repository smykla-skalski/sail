import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContextPressureRecorder,
  contextHandoffPrompt,
  contextPressureStage,
  handoffOutcome,
  parseContextHandoffThreshold,
  reconcileHandoffOutcomes,
  transferHandoffOwnership,
  updateThreadContextPressure,
} from '../src/lib/context-handoff.ts';
import { initialTaskCheckpoint } from '../src/lib/task-checkpoint.ts';

void test('validates the configured context threshold', () => {
  assert.equal(parseContextHandoffThreshold('80'), 80);
  assert.equal(parseContextHandoffThreshold('59'), 85);
  assert.equal(parseContextHandoffThreshold('96'), 85);
  assert.equal(parseContextHandoffThreshold('not-a-number'), 85);
});

void test('emits checkpoint and handoff stages only when thresholds are crossed', () => {
  assert.equal(contextPressureStage(70, 75, 85), 'checkpoint');
  assert.equal(contextPressureStage(75, 84, 85), null);
  assert.equal(contextPressureStage(84, 85, 85), 'handoff');
  assert.equal(contextPressureStage(90, 91, 85), null);
});

void test('records pressure even when live usage already contains the same sample', async () => {
  const recorder = new ContextPressureRecorder();
  const liveUsage = { '/work:thread': 85 };
  const recorded: number[] = [];

  await Promise.all([
    recorder.record('/work:thread', liveUsage['/work:thread'], async () => {
      recorded.push(85);
    }),
    recorder.record('/work:thread', liveUsage['/work:thread'], async () => {
      recorded.push(85);
    }),
  ]);

  assert.deepEqual(recorded, [85]);
});

void test('handoff prompt binds semantic state to repository state', () => {
  const checkpoint = initialTaskCheckpoint(
    { id: 'owner/repo#1', url: 'https://github.com/owner/repo/issues/1', title: 'Task' },
    10,
  );
  const prompt = contextHandoffPrompt({
    checkpoint,
    branch: 'feat/task',
    revision: 'abc123',
    pullRequest: null,
    gates: ['code-adversary: PASS'],
  });
  assert.match(prompt, /task_checkpoint_read/);
  assert.match(prompt, /abc123/);
  assert.match(prompt, /code-adversary: PASS/);
  assert.match(prompt, /owner\/repo#1/);
});

void test('records whether retries or lost-state failures regressed', () => {
  const handoff = {
    retriesBefore: 1,
    lostStateFailuresBefore: 0,
  };
  assert.equal(handoffOutcome(handoff, 1, 0).outcome, 'no_regression');
  assert.equal(handoffOutcome(handoff, 2, 0).outcome, 'regressed');
});

void test('handoff ownership transfer excludes retries recorded by the previous worker', () => {
  const offered = {
    id: 'handoff-one',
    provider: 'codex' as const,
    fromThreadId: 'old',
    toThreadId: null,
    context: 90,
    compactions: 0,
    checkpointSequence: 1,
    revision: 'abc',
    offeredAt: 10,
    startedAt: null,
    retriesBefore: 0,
    lostStateFailuresBefore: 0,
    retriesAfter: null,
    lostStateFailuresAfter: null,
    outcome: 'pending' as const,
    error: null,
  };

  const transferred = transferHandoffOwnership(offered, 'new', 20, 1, 0);

  assert.equal(handoffOutcome(transferred, 1, 0).outcome, 'no_regression');
  assert.equal(transferred.retriesBefore, 1);
  assert.equal(transferred.toThreadId, 'new');
});

void test('recovers a pending handoff from its persisted completed receipt', () => {
  const handoff = {
    id: 'handoff-one',
    provider: 'codex' as const,
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
    retriesAfter: null,
    lostStateFailuresAfter: null,
    outcome: 'pending' as const,
    error: null,
  };

  const recovered = reconcileHandoffOutcomes(
    [handoff],
    [
      {
        requestId: 'handoff:handoff-one',
        targetId: 'new',
        state: 'completed',
        error: null,
      },
    ],
    1,
    0,
  );

  assert.deepEqual(recovered?.[0], {
    ...handoff,
    retriesAfter: 1,
    lostStateFailuresAfter: 0,
    outcome: 'no_regression',
  });
});

void test('tracks context pressure independently for primary and descendant threads', () => {
  const child = updateThreadContextPressure({ primary: 84 }, 'child', 90);
  const primary = updateThreadContextPressure(child.contexts, 'primary', 86);

  assert.equal(child.previous, undefined);
  assert.equal(primary.previous, 84);
  assert.equal(contextPressureStage(primary.previous, 86, 85), 'handoff');
});

void test('retains a recently updated owner when descendant history reaches its limit', () => {
  const contexts = Object.fromEntries([
    ['primary', 86],
    ...Array.from({ length: 99 }, (_, index) => [`child-${index}`, 90]),
  ]);
  const refreshed = updateThreadContextPressure(contexts, 'primary', 87, 'primary');

  const bounded = updateThreadContextPressure(refreshed.contexts, 'child-99', 90, 'primary');

  assert.equal(bounded.contexts.primary, 87);
  assert.equal(Object.keys(bounded.contexts).length, 100);
  assert.equal(contextPressureStage(bounded.contexts.primary, 88, 85), null);
});

void test('pins the owner while newer descendant context fills the history', () => {
  const contexts = Object.fromEntries([
    ['primary', 86],
    ...Array.from({ length: 100 }, (_, index) => [`child-${index}`, 90]),
  ]);

  const bounded = updateThreadContextPressure(contexts, 'child-100', 90, 'primary');
  const primary = updateThreadContextPressure(bounded.contexts, 'primary', 87, 'primary');

  assert.equal(bounded.contexts.primary, 86);
  assert.equal(Object.keys(bounded.contexts).length, 100);
  assert.equal(primary.previous, 86);
  assert.equal(contextPressureStage(primary.previous, 87, 85), null);
});

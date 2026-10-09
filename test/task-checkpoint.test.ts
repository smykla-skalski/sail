import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialTaskCheckpoint,
  reconcileTaskCheckpoint,
  prepareTaskCheckpointUpdate,
  taskCheckpointSchema,
  updateTaskCheckpoint,
} from '../src/lib/task-checkpoint.ts';

const task = {
  id: 'owner/repo#270',
  url: 'https://github.com/owner/repo/issues/270',
  title: 'Persist canonical checkpoints',
};

void test('a checkpoint keeps task context and one concrete next action together', () => {
  const checkpoint = initialTaskCheckpoint(task, 10);
  assert.equal(checkpoint.taskId, task.id);
  assert.equal(checkpoint.objective, task.title);
  assert.deepEqual(checkpoint.requiredGates, [
    'code-adversary',
    'findings-adversary',
    'test-adversary',
  ]);
  assert.match(checkpoint.nextAction, /Resolve the task source/);
  assert.deepEqual(taskCheckpointSchema.parse(checkpoint), checkpoint);
});

void test('updates preserve checkpoint identity and reject contradictory state', () => {
  const checkpoint = initialTaskCheckpoint(task, 10);
  const updated = updateTaskCheckpoint(
    checkpoint,
    {
      objective: 'Resume without conversation replay',
      acceptanceCriteria: ['Persist state', 'Reconcile before resume'],
      phase: 'publish',
      nextAction: 'Publish the implementation before independent validation.',
    },
    20,
  );
  assert.equal(updated.taskId, checkpoint.taskId);
  assert.equal(updated.source, checkpoint.source);
  assert.equal(updated.createdAt, 10);
  assert.equal(updated.updatedAt, 20);
  assert.equal(updated.sequence, 1);
  assert.throws(
    () => updateTaskCheckpoint(updated, { status: 'blocked', blocker: null }, 30),
    /Only blocked checkpoints have a blocker/,
  );
  assert.throws(() => updateTaskCheckpoint(updated, { taskId: 'other' }, 30), /Unrecognized key/);
  assert.throws(() => updateTaskCheckpoint(updated, { revision: 'other' }, 30), /Unrecognized key/);
});

void test('compare-and-swap rejects drift and concurrent stale updates', () => {
  const checkpoint = initialTaskCheckpoint(task, 10);
  assert.throws(
    () => prepareTaskCheckpointUpdate(checkpoint, {}, 'revision-one', 0, null, false, 20),
    /explicitly rebind/,
  );
  const bound = prepareTaskCheckpointUpdate(checkpoint, {}, 'revision-one', 0, null, true, 20);
  assert.equal(bound.revision, 'revision-one');
  assert.equal(bound.sequence, 1);
  assert.throws(
    () => prepareTaskCheckpointUpdate(bound, {}, 'revision-one', 0, null, false, 30),
    /changed after it was read/,
  );
  assert.throws(
    () => prepareTaskCheckpointUpdate(bound, {}, 'revision-two', 1, 'revision-one', false, 30),
    /explicitly rebind/,
  );
});

void test('reconciliation stops stale, blocked, and externally inconsistent resumes', () => {
  const unbound = reconcileTaskCheckpoint(initialTaskCheckpoint(task, 10), 'current', {
    issueState: 'OPEN',
    pullRequest: null,
    deliveryState: 'working',
  });
  assert.equal(unbound.revisionMatches, false);
  assert.equal(unbound.resumable, false);
  assert.match(unbound.reason!, /no revision baseline/);

  const checkpoint = prepareTaskCheckpointUpdate(
    initialTaskCheckpoint(task, 10),
    { phase: 'review', nextAction: 'Run review.' },
    'expected',
    0,
    null,
    true,
    20,
  );
  assert.equal(
    reconcileTaskCheckpoint(checkpoint, 'expected', {
      issueState: 'OPEN',
      pullRequest: null,
      deliveryState: 'working',
    }).resumable,
    true,
  );
  const stale = reconcileTaskCheckpoint(checkpoint, 'changed', {
    issueState: 'OPEN',
    pullRequest: null,
    deliveryState: 'working',
  });
  assert.equal(stale.resumable, false);
  assert.match(stale.reason!, /revision differs/);

  const unknown = reconcileTaskCheckpoint(checkpoint, 'expected', {
    pullRequest: null,
    deliveryState: 'working',
    refreshError: 'offline',
  });
  assert.equal(unknown.resumable, false);
  assert.match(unknown.reason!, /offline/);

  const blocked = updateTaskCheckpoint(
    checkpoint,
    { status: 'blocked', blocker: 'Missing credentials.', nextAction: 'Authenticate.' },
    30,
  );
  assert.equal(
    reconcileTaskCheckpoint(blocked, 'expected', {
      issueState: 'OPEN',
      pullRequest: null,
      deliveryState: 'working',
    }).reason,
    'Missing credentials.',
  );
});

void test('a checkpoint can end cancelled or failed and is then not resumable', () => {
  const base = initialTaskCheckpoint(task, 10);
  const stopped = updateTaskCheckpoint(base, { status: 'cancelled' }, 20);
  assert.equal(stopped.phase, 'resolve');
  const failed = updateTaskCheckpoint(
    { ...base, revision: 'rev' },
    { status: 'failed', phase: 'complete' },
    20,
  );
  assert.equal(taskCheckpointSchema.parse(failed).status, 'failed');
  assert.throws(
    () => updateTaskCheckpoint(base, { phase: 'complete', status: 'active' }, 20),
    /must occur together/,
  );
  assert.throws(
    () => updateTaskCheckpoint(base, { status: 'completed' }, 20),
    /must occur together/,
  );
  const result = reconcileTaskCheckpoint({ ...stopped, revision: 'rev' }, 'rev', {
    issueState: 'OPEN',
    deliveryState: 'open',
  });
  assert.equal(result.resumable, false);
  assert.match(result.reason!, /Retry the issue/);
});

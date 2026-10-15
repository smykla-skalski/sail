import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskStore } from '../src/lib/session-tasks.ts';
import { createNativeTaskReconciler } from '../src/lib/native-session-tasks.ts';
import type { NativeSubagentSnapshot, NativeSubagentSnapshotSet } from '../src/lib/acp.ts';

const parent = { agent: 'opencode', directory: '/repo', sessionId: 'parent' };
const scope = { ...parent, sessionId: 'child' };
const child = (overrides: Partial<NativeSubagentSnapshot> = {}): NativeSubagentSnapshot => ({
  ...scope,
  agent: 'opencode',
  parentSessionId: 'parent',
  capabilityProfile: 'build',
  outcome: 'working',
  taskIdentity: 'verified',
  taskTurnId: 'child-turn',
  ...overrides,
});
const set = (
  generation: number,
  ...subagents: NativeSubagentSnapshot[]
): NativeSubagentSnapshotSet => ({ generation, subagents });
const store = () => createTaskStore({ read: () => null, write: async () => undefined });

await test('verified children report their own tasks without changing parent revision or focus', async () => {
  const tasks = store();
  const reconcile = createNativeTaskReconciler(tasks);
  await tasks.start(parent, 'parent-turn');
  const before = tasks.snapshot(parent);
  await reconcile('/repo', set(1, child()));
  const initial = tasks.snapshot(scope);
  await tasks.report(scope, {
    turnId: initial.turnId,
    expectedRevision: initial.revision,
    tasks: [{ id: 'review', title: 'Review child work', status: 'in_progress' }],
    focus: 'review',
  });
  assert.deepEqual(tasks.snapshot(parent), before);
  assert.equal(tasks.snapshot(scope).focus, 'review');
  await assert.rejects(
    tasks.report(parent, {
      turnId: 'child-turn',
      expectedRevision: before.revision,
      tasks: [],
      focus: null,
    }),
    /different turn/,
  );
});

await test('completion and interruption clear only the child focus and stale snapshots cannot reopen it', async () => {
  await Promise.all(
    (['completed', 'interrupted', 'failed', 'unknown'] as const).map(async (outcome) => {
      const tasks = store();
      const reconcile = createNativeTaskReconciler(tasks);
      await tasks.start(parent, 'parent-turn');
      await reconcile('/repo', set(1, child()));
      const started = tasks.snapshot(scope);
      await tasks.report(scope, {
        turnId: 'child-turn',
        expectedRevision: started.revision,
        tasks: [{ id: 'review', title: 'Review', status: 'in_progress' }],
        focus: 'review',
      });
      await reconcile('/repo', set(2, child({ outcome, taskTurnId: null })));
      await reconcile('/repo', set(1, child()));
      assert.equal(tasks.snapshot(scope).focus, null);
      assert.equal(tasks.snapshot(scope).turnId, null);
      assert.equal(tasks.snapshot(parent).turnId, 'parent-turn');
      await assert.rejects(
        tasks.report(scope, {
          turnId: 'child-turn',
          expectedRevision: tasks.snapshot(scope).revision,
          tasks: [],
          focus: null,
        }),
        /different turn/,
      );
    }),
  );
});

await test('observed children never acquire a reportable scope, including spoofed turn metadata', async () => {
  const tasks = store();
  const reconcile = createNativeTaskReconciler(tasks);
  await reconcile('/repo', set(1, child({ taskIdentity: 'observed', taskTurnId: 'spoofed' })));
  assert.deepEqual(tasks.snapshot(scope), {
    turnId: null,
    revision: 0,
    tasks: [],
    focus: null,
    reportedAt: null,
  });
});

await test('restoration retains durable child tasks, clears orphan focus and starts a fresh child turn', async () => {
  let saved: string | null = null;
  const storage = {
    read: () => saved,
    write: async (value: string) => {
      saved = value;
    },
  };
  const original = createTaskStore(storage);
  await original.start(scope, 'old-turn');
  await original.report(scope, {
    turnId: 'old-turn',
    expectedRevision: original.snapshot(scope).revision,
    tasks: [{ id: 'stable', title: 'Stable child task', status: 'in_progress' }],
    focus: 'stable',
  });
  const restored = createTaskStore(storage);
  const reconcile = createNativeTaskReconciler(restored);
  await reconcile('/repo', set(4, child({ outcome: 'unknown', taskTurnId: null })));
  assert.equal(restored.snapshot(scope).focus, null);
  assert.equal(
    restored.snapshot(scope).tasks.find((task) => task.id === 'stable')?.title,
    'Stable child task',
  );
  await reconcile('/repo', set(5, child({ taskTurnId: 'new-turn' })));
  assert.equal(restored.snapshot(scope).turnId, 'new-turn');
});

await test('late pre-disconnect snapshots cannot restore the old child turn or focus', async () => {
  const tasks = store();
  const reconcile = createNativeTaskReconciler(tasks);
  const live = set(6, child());
  await reconcile('/repo', live);
  await reconcile('/repo', set(7, child({ outcome: 'unknown', taskTurnId: null })));
  assert.equal(await reconcile('/repo', live), false);
  assert.equal(tasks.snapshot(scope).turnId, null);
  assert.equal(tasks.snapshot(scope).focus, null);
});

await test('new complete snapshots finish omitted children without changing other scopes', async () => {
  const tasks = store();
  const reconcile = createNativeTaskReconciler(tasks);
  const sibling = { ...scope, sessionId: 'sibling' };
  const foreign = { ...scope, directory: '/other', sessionId: 'foreign' };
  await tasks.start(parent, 'parent-turn');
  await reconcile('/repo', set(10, child(), child({ ...sibling, taskTurnId: 'sibling-turn' })));
  await reconcile('/other', set(20, child({ ...foreign, taskTurnId: 'foreign-turn' })));
  await Promise.all(
    [parent, scope, sibling, foreign].map(async (target) => {
      const snapshot = tasks.snapshot(target);
      await tasks.report(target, {
        turnId: snapshot.turnId,
        expectedRevision: snapshot.revision,
        tasks: [{ id: 'review', title: 'Review', status: 'in_progress' }],
        focus: 'review',
      });
    }),
  );
  const retained = [parent, sibling, foreign].map((target) => tasks.snapshot(target));
  const childTasks = tasks.snapshot(scope).tasks;
  assert.equal(await reconcile('/repo', set(9)), false);
  assert.equal(tasks.snapshot(scope).focus, 'review');
  await reconcile('/repo', set(11, child({ ...sibling, taskTurnId: 'sibling-turn' })));
  await tasks.reconcile(scope, null, tasks.snapshot(scope).revision);
  assert.equal(tasks.snapshot(scope).turnId, null);
  assert.equal(tasks.snapshot(scope).focus, null);
  assert.deepEqual(tasks.snapshot(scope).tasks, childTasks);
  assert.deepEqual(
    [parent, sibling, foreign].map((target) => tasks.snapshot(target)),
    retained,
  );
  assert.equal(await reconcile('/repo', set(10, child())), false);
  assert.equal(tasks.snapshot(scope).turnId, null);
  await reconcile('/repo', set(12));
  assert.equal(tasks.snapshot(sibling).turnId, null);
  assert.equal(tasks.snapshot(sibling).focus, null);
  assert.deepEqual(tasks.snapshot(parent), retained[0]);
  assert.deepEqual(tasks.snapshot(foreign), retained[2]);
});

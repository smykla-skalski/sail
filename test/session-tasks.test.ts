import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskStore, type TaskScope } from '../src/lib/session-tasks.ts';
const scope: TaskScope = { agent: 'codex', directory: '/repo', sessionId: 'one' };
function fixture() {
  let value: string | null = null;
  let fail = false;
  const storage = {
    read: () => value,
    write: async (next: string) => {
      if (fail) throw new Error('disk full');
      value = next;
    },
  };
  return {
    store: createTaskStore(storage),
    storage,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
  };
}
const task = { id: 'inspect', title: 'Inspect repository', status: 'in_progress' as const };
function report(turnId: string, expectedRevision: number) {
  return { turnId, expectedRevision, tasks: [task], focus: task.id };
}

await test('turn start is visible before progress and durable, with Sail origin', async () => {
  const { store, storage } = fixture();
  const started = await store.start(scope, 'turn');
  assert.equal(started.tasks[0]?.origin, 'sail');
  assert.equal(started.focus, started.tasks[0]?.id);
  assert.deepEqual(createTaskStore(storage).snapshot(scope), started);
});
await test('reports update stable identities and notify only after persistence', async () => {
  let release!: () => void;
  let block = false;
  const store = createTaskStore({
    read: () => null,
    write: async () => {
      if (block)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    },
  });
  await store.start(scope, 'turn');
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  block = true;
  const pending = store.report(scope, report('turn', 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot(scope).revision, 1);
  assert.equal(notified, 0);
  release();
  const updated = await pending;
  assert.equal(updated.tasks[0]?.status, 'done');
  assert.equal(updated.tasks[1]?.id, task.id);
  assert.equal(notified, 1);
  block = false;
  await store.report(scope, {
    ...report('turn', 2),
    tasks: [{ ...task, status: 'done' }],
    focus: null,
  });
  assert.equal(store.snapshot(scope).tasks.length, 2);
  assert.equal(store.snapshot(scope).tasks[1]?.status, 'done');
});
await test('storage failures reject without visible mutation and next write recovers', async () => {
  const { store, storage, fail, recover } = fixture();
  await store.start(scope, 'turn');
  const before = store.snapshot(scope);
  fail();
  await assert.rejects(store.report(scope, report('turn', 1)), /disk full/);
  assert.deepEqual(store.snapshot(scope), before);
  assert.deepEqual(createTaskStore(storage).snapshot(scope), before);
  recover();
  assert.equal((await store.report(scope, report('turn', 1))).revision, 2);
});
await test('malformed, stale, cross-session and invalid focus writes leave state unchanged', async () => {
  const { store } = fixture();
  await store.start(scope, 'turn');
  const before = store.snapshot(scope);
  await Promise.all(
    [
      report('other', 1),
      report('turn', 0),
      { ...report('turn', 1), sessionId: 'other' },
      { ...report('turn', 1), focus: 'missing' },
      { ...report('turn', 1), tasks: [task, task] },
      { ...report('turn', 1), tasks: [{ ...task, id: 'sail:fake' }] },
      { ...report('turn', 1), tasks: [{ ...task, status: 'wat' }] },
    ].map(async (input) => {
      await assert.rejects(store.report(scope, input));
      assert.deepEqual(store.snapshot(scope), before);
    }),
  );
  await assert.rejects(store.report({ ...scope, sessionId: 'other' }, report('turn', 1)));
  assert.deepEqual(store.snapshot({ ...scope, sessionId: 'other' }).tasks, []);
});
await test('simultaneous reports cannot both apply the same revision', async () => {
  const { store } = fixture();
  await store.start(scope, 'turn');
  const results = await Promise.allSettled([
    store.report(scope, report('turn', 1)),
    store.report(scope, report('turn', 1)),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot(scope).revision, 2);
});
await test('finish clears focus and retains history; stale finish cannot clear new focus', async () => {
  const { store } = fixture();
  await store.start(scope, 'turn');
  await store.report(scope, report('turn', 1));
  await store.finish(scope, 'turn');
  assert.equal(store.snapshot(scope).focus, null);
  assert.equal(store.snapshot(scope).tasks.length, 2);
  const next = await store.start(scope, 'next');
  await store.finish(scope, 'turn');
  assert.deepEqual(store.snapshot(scope), next);
  await assert.rejects(store.report(scope, report('turn', next.revision)), /inactive/);
  await store.report(scope, report('next', next.revision));
  assert.equal(store.snapshot(scope).tasks.filter((item) => item.id === task.id).length, 1);
});
await test('restore clears orphan focus but keeps focus for a live turn', async () => {
  const { store, storage } = fixture();
  await store.start(scope, 'turn');
  const restored = createTaskStore(storage);
  await restored.reconcile(scope, 'turn');
  assert.equal(restored.snapshot(scope).focus, 'sail:turn');
  await restored.reconcile(scope, null);
  assert.equal(restored.snapshot(scope).focus, null);
  assert.equal(restored.snapshot(scope).tasks.length, 1);
});
await test('forget is durable and cannot remove neighboring providers, directories or sessions', async () => {
  const { store, storage } = fixture();
  const neighbors = [
    { ...scope, agent: 'claude' },
    { ...scope, directory: '/other' },
    { ...scope, sessionId: 'other' },
  ];
  await store.start(scope, 'turn');
  await Promise.all(neighbors.map((neighbor) => store.start(neighbor, 'turn')));
  await store.forget(scope);
  const restored = createTaskStore(storage);
  assert.deepEqual(restored.snapshot(scope).tasks, []);
  for (const neighbor of neighbors) assert.equal(restored.snapshot(neighbor).tasks.length, 1);
});
await test('history and retained sessions remain bounded', async () => {
  const { store, storage } = fixture();
  await Promise.all(
    Array.from({ length: 205 }, (_, i) => [
      store.start(scope, `t${i}`),
      store.finish(scope, `t${i}`),
    ]).flat(),
  );
  assert.equal(store.snapshot(scope).tasks.length, 200);
  await Promise.all(
    Array.from({ length: 101 }, (_, i) => {
      const neighbor = { ...scope, sessionId: `s${i}` };
      return [store.start(neighbor, 'turn'), store.finish(neighbor, 'turn')];
    }).flat(),
  );
  assert.equal(createTaskStore(storage).scopes().length, 100);
});

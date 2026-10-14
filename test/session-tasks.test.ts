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

await test('local starting turns survive backend registration gaps', async () => {
  const { store } = fixture();
  const started = await store.start(scope, 'turn');
  await store.reconcile(scope, null, started.revision);
  assert.equal(store.snapshot(scope).turnId, 'turn');
  await store.report(scope, report('turn', started.revision));
  assert.equal(store.snapshot(scope).focus, task.id);
});
await test('retrying a finished prompt attempt reuses its starting task identity', async () => {
  const { store, storage } = fixture();
  await store.start(scope, 'turn');
  await store.finish(scope, 'turn');
  const retried = await store.start(scope, 'turn');
  assert.deepEqual(
    retried.tasks.map((item) => item.id),
    ['sail:turn'],
  );
  assert.deepEqual(
    createTaskStore(storage)
      .snapshot(scope)
      .tasks.map((item) => item.id),
    ['sail:turn'],
  );
});

await test('resuming a saved task turn takes local ownership before backend registration', async () => {
  const { store, storage } = fixture();
  await store.start(scope, 'turn');
  const restored = createTaskStore(storage);
  const started = await restored.start(scope, 'turn');
  await restored.reconcile(scope, null, started.revision);
  assert.equal(restored.snapshot(scope).turnId, 'turn');
  assert.equal(restored.snapshot(scope).tasks.length, 1);
});

await test('missing reports allow one durable correction and remain explicit after completion', async () => {
  const { store, storage } = fixture();
  await store.start(scope, 'turn');
  const claims = await Promise.all([
    store.requestCorrection(scope, 'turn'),
    store.requestCorrection(scope, 'turn'),
  ]);
  assert.deepEqual(claims, [true, false]);
  const restored = createTaskStore(storage);
  assert.equal(await restored.requestCorrection(scope, 'turn'), false);
  assert.equal(restored.snapshot(scope).reporting?.state, 'correcting');
  await restored.finish(scope, 'turn');
  const completed = createTaskStore(storage).snapshot(scope);
  assert.equal(completed.reporting?.state, 'missing');
  assert.equal(completed.tasks[0]?.origin, 'sail');
  assert.equal(completed.tasks[0]?.status, 'in_progress');
  assert.equal(completed.focus, null);
});

await test('a successful empty report counts as reported and prevents correction', async () => {
  const { store } = fixture();
  await store.start(scope, 'turn');
  await store.report(scope, { turnId: 'turn', expectedRevision: 1, tasks: [], focus: null });
  assert.equal(await store.requestCorrection(scope, 'turn'), false);
  await store.finish(scope, 'turn');
  assert.equal(store.snapshot(scope).reporting?.state, 'reported');
});

await test('reporting failures do not count as progress, and a correction can recover', async () => {
  const { store, fail, recover } = fixture();
  await store.start(scope, 'turn');
  fail();
  await assert.rejects(store.report(scope, report('turn', 1)), /disk full/);
  assert.equal(store.snapshot(scope).reporting?.state, 'awaiting');
  await assert.rejects(store.requestCorrection(scope, 'turn'), /disk full/);
  recover();
  assert.equal(await store.requestCorrection(scope, 'turn'), true);
  await assert.rejects(store.report(scope, report('turn', 1)), /Stale/);
  const accepted = await store.report(scope, report('turn', 2));
  assert.equal(accepted.reporting?.state, 'reported');
  assert.equal(accepted.reporting?.correctionRequested, true);
  await store.finish(scope, 'turn');
  assert.equal(store.snapshot(scope).reporting?.state, 'reported');
});

await test('failed, interrupted and orphan turns never permit a corrective request', async () => {
  await Promise.all(
    (['failed', 'interrupted'] as const).map(async (outcome) => {
      const { store, storage } = fixture();
      await store.start(scope, 'turn');
      await store.finish(scope, 'turn', outcome);
      assert.equal(await store.requestCorrection(scope, 'turn'), false);
      assert.equal(createTaskStore(storage).snapshot(scope).reporting?.state, outcome);
    }),
  );
  const { store, storage } = fixture();
  await store.start(scope, 'orphan');
  const restored = createTaskStore(storage);
  await restored.reconcile(scope, null);
  assert.equal(await restored.requestCorrection(scope, 'orphan'), false);
  assert.equal(restored.snapshot(scope).reporting?.state, 'interrupted');
});

await test('a new turn resets reporting without accepting another turn or session', async () => {
  const { store } = fixture();
  await store.start(scope, 'turn');
  assert.equal(await store.requestCorrection({ ...scope, sessionId: 'other' }, 'turn'), false);
  assert.equal(await store.requestCorrection(scope, 'other'), false);
  await store.requestCorrection(scope, 'turn');
  await store.finish(scope, 'turn', 'failed');
  assert.equal(store.snapshot(scope).reporting?.state, 'missing');
  await store.start(scope, 'next');
  assert.deepEqual(store.snapshot(scope).reporting, {
    turnId: 'next',
    state: 'awaiting',
    correctionRequested: false,
  });
  assert.equal(await store.requestCorrection(scope, 'next'), true);
});

await test('restoring a legacy active turn creates a missing-report marker', async () => {
  const storage = {
    read: () =>
      JSON.stringify([
        {
          scope,
          updated: 0,
          snapshot: {
            turnId: 'legacy',
            revision: 1,
            focus: 'sail:legacy',
            tasks: [
              {
                id: 'sail:legacy',
                title: 'Starting task',
                status: 'in_progress',
                origin: 'sail',
                turnId: 'legacy',
              },
            ],
          },
        },
      ]),
    write: async () => {},
  };
  const store = createTaskStore(storage);
  await store.start(scope, 'legacy');
  assert.equal(await store.requestCorrection(scope, 'legacy'), true);
});

await test('restarting the same logical turn cannot repeat its corrective request', async () => {
  const { store } = fixture();
  await store.start(scope, 'turn');
  await store.requestCorrection(scope, 'turn');
  await store.finish(scope, 'turn');
  await store.start(scope, 'turn');
  assert.equal(await store.requestCorrection(scope, 'turn'), false);
});

await test('restoration retains missing status after a correction completed off screen', async () => {
  const { store, storage } = fixture();
  await store.start(scope, 'turn');
  await store.requestCorrection(scope, 'turn');
  const restored = createTaskStore(storage);
  await restored.reconcile(scope, null, store.snapshot(scope).revision, {
    turnId: 'turn',
    status: 'done',
  });
  assert.equal(restored.snapshot(scope).turnId, null);
  assert.equal(restored.snapshot(scope).reporting?.state, 'missing');
  assert.equal(restored.snapshot(scope).reporting?.correctionRequested, true);
  assert.equal(createTaskStore(storage).snapshot(scope).reporting?.state, 'missing');
});

await test('restoration uses only matching completed outcomes and preserves reported work', async () => {
  const outcomes = ['done', 'failed', 'interrupted'] as const;
  await Promise.all(
    outcomes.map(async (status) => {
      const { store, storage } = fixture();
      await store.start(scope, 'turn');
      const restored = createTaskStore(storage);
      await restored.reconcile(scope, null, 1, { turnId: 'turn', status });
      assert.equal(
        restored.snapshot(scope).reporting?.state,
        status === 'done' ? 'missing' : status,
      );
    }),
  );
  const { store, storage } = fixture();
  await store.start(scope, 'turn');
  const restored = createTaskStore(storage);
  await restored.reconcile(scope, null, 1, { turnId: 'older', status: 'done' });
  assert.equal(restored.snapshot(scope).reporting?.state, 'interrupted');
  await restored.start(scope, 'next');
  await restored.report(scope, report('next', restored.snapshot(scope).revision));
  const reported = createTaskStore(storage);
  await reported.reconcile(scope, null, restored.snapshot(scope).revision, {
    turnId: 'next',
    status: 'done',
  });
  assert.equal(reported.snapshot(scope).reporting?.state, 'reported');
});

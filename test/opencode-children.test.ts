import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenCodeChildStore,
  openCodeChildActivity,
  openCodeChildReceipts,
  openCodeChildStatusLabel,
  type OpenCodeChildClient,
  type OpenCodeChildren,
} from '../src/lib/opencode-children.ts';
import type { SessionInfo, SessionMessageInfo } from '../src/lib/opencode.ts';

function session(id: string, parentID: string): SessionInfo {
  return {
    id,
    parentID,
    projectID: 'project',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: `Child ${id}`,
    location: { directory: '/repo' },
  };
}

function message(sessionID: string): SessionMessageInfo {
  return {
    id: `${sessionID}-message`,
    type: 'assistant',
    agent: 'general',
    model: { id: 'model', providerID: 'provider' },
    content: [{ type: 'text', text: `Output of ${sessionID}` }],
    time: { created: 1 },
  };
}

function fakeClient(children: Record<string, string[]>, active: string[]) {
  const calls = {
    list: [] as string[],
    active: 0,
    summaries: [] as string[],
    histories: [] as string[],
  };
  const client: OpenCodeChildClient = {
    session: {
      list: async ({ parentID }) => {
        calls.list.push(parentID);
        return { data: (children[parentID] ?? []).map((id) => session(id, parentID)), cursor: {} };
      },
      active: async () => {
        calls.active++;
        return Object.fromEntries(active.map((id) => [id, {}]));
      },
    },
    message: {
      list: async ({ sessionID, type }) => {
        (type === 'assistant' ? calls.summaries : calls.histories).push(sessionID);
        return { data: [message(sessionID)], cursor: {} };
      },
    },
  };
  return { client, calls };
}

function fakeSchedule() {
  const timers = new Set<() => void>();
  return {
    timers,
    schedule: (run: () => void) => {
      timers.add(run);
      return () => void timers.delete(run);
    },
    tick: () => {
      for (const run of timers) run();
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function count(items: string[], value: string): number {
  return items.filter((item) => item === value).length;
}

await test('two views of one parent poll each child session once per interval', async () => {
  const { client, calls } = fakeClient({ parent: ['child-a', 'child-b'] }, ['child-a', 'child-b']);
  const clock = fakeSchedule();
  const store = createOpenCodeChildStore({ schedule: clock.schedule });
  let first: OpenCodeChildren | null = null;
  let second: OpenCodeChildren | null = null;

  const one = store.watch(client, 'parent', (state) => (first = state));
  const two = store.watch(client, 'parent', (state) => (second = state));
  await settle();

  assert.equal(clock.timers.size, 1);
  assert.deepEqual(calls.list, ['parent']);
  assert.equal(calls.active, 1);
  assert.deepEqual(calls.summaries.toSorted(), ['child-a', 'child-b']);

  one.expand('child-a');
  two.expand('child-a');
  await settle();
  const histories = count(calls.histories, 'child-a');
  calls.summaries.length = 0;

  clock.tick();
  await settle();

  assert.deepEqual(calls.list, ['parent', 'parent']);
  assert.equal(calls.active, 2);
  assert.deepEqual(calls.summaries.toSorted(), ['child-a', 'child-b']);
  assert.equal(count(calls.histories, 'child-a') - histories, 1);
  for (const state of [first, second] as (OpenCodeChildren | null)[]) {
    assert.deepEqual(
      state?.children.map((child) => child.id),
      ['child-a', 'child-b'],
    );
    assert.equal(state?.histories['child-a']?.length, 1);
  }
});

await test('a view that joins a live poll gets its state without another request', async () => {
  const { client, calls } = fakeClient({ parent: ['child-a'] }, []);
  const clock = fakeSchedule();
  const store = createOpenCodeChildStore({ schedule: clock.schedule });
  store.watch(client, 'parent', () => {});
  await settle();

  let joined: OpenCodeChildren | null = null;
  store.watch(client, 'parent', (state) => (joined = state));

  assert.deepEqual(
    (joined as OpenCodeChildren | null)?.children.map((child) => child.id),
    ['child-a'],
  );
  assert.deepEqual(calls.list, ['parent']);
});

await test('different parents and clients keep separate polls', async () => {
  const first = fakeClient({ one: ['child-1'], two: ['child-2'] }, []);
  const second = fakeClient({ one: ['child-3'] }, []);
  const clock = fakeSchedule();
  const store = createOpenCodeChildStore({ schedule: clock.schedule });

  store.watch(first.client, 'one', () => {});
  store.watch(first.client, 'two', () => {});
  store.watch(second.client, 'one', () => {});
  await settle();

  assert.equal(clock.timers.size, 3);
  assert.deepEqual(first.calls.list.toSorted(), ['one', 'two']);
  assert.deepEqual(second.calls.list, ['one']);
});

await test('closing the last view stops the poll and drops late results', async () => {
  const { client, calls } = fakeClient({ parent: ['child-a'] }, []);
  let release: (() => void) | undefined;
  const list = client.session.list;
  client.session.list = async (input) => {
    await new Promise<void>((resolve) => (release = resolve));
    return list(input);
  };
  const clock = fakeSchedule();
  const store = createOpenCodeChildStore({ schedule: clock.schedule });
  const updates: OpenCodeChildren[] = [];

  const one = store.watch(client, 'parent', (state) => updates.push(state));
  const two = store.watch(client, 'parent', () => {});
  one.close();
  assert.equal(clock.timers.size, 1);
  two.close();
  assert.equal(clock.timers.size, 0);

  release?.();
  await settle();

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].children, []);
  assert.deepEqual(calls.summaries, []);

  const reopened: OpenCodeChildren[] = [];
  store.watch(client, 'parent', (state) => reopened.push(state));
  release?.();
  await settle();
  assert.deepEqual(
    reopened.at(-1)?.children.map((child) => child.id),
    ['child-a'],
  );
});

await test('a finished child reads Finished, never Queued', () => {
  const finished = { ...session('done', 'parent'), outcome: undefined };
  const failed = { ...session('bad', 'parent'), outcome: 'failed' as const };
  const live = session('live', 'parent');
  const receipts = openCodeChildReceipts('parent', '/repo', {
    children: [live, finished, failed],
    active: ['live'],
    summaries: {},
  });
  const byId = Object.fromEntries(receipts.map((receipt) => [receipt.receiptId, receipt]));
  assert.equal(byId['opencode-child:live'].state, 'working');
  assert.equal(byId['opencode-child:done'].state, 'completed');
  assert.equal(byId['opencode-child:done'].activity, 'Finished');
  assert.equal(byId['opencode-child:bad'].state, 'failed');
  assert.equal(openCodeChildStatusLabel('completed'), 'Finished');
  assert.equal(openCodeChildStatusLabel('working'), undefined);
  assert.equal(openCodeChildStatusLabel('failed'), undefined);
  assert.equal(openCodeChildActivity('queued', undefined), 'Queued');
});

await test('child receipts point at the child thread and its parent', () => {
  const [receipt] = openCodeChildReceipts('parent', '/repo', {
    children: [session('child', 'parent')],
    active: [],
    summaries: { child: message('child') },
  });
  assert.equal(receipt.sourceId, 'opencode:parent');
  assert.equal(receipt.targetId, 'opencode:child');
  assert.equal(receipt.targetDirectory, '/repo');
  assert.equal(receipt.provider, 'opencode');
  assert.equal(receipt.prompt, 'Child child');
  assert.equal(receipt.activity, 'Output of child');
});

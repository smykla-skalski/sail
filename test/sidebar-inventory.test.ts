import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentThread } from '../src/lib/acp.ts';
import { createSidebarThreadLoader } from '../src/lib/sidebar-inventory.ts';

const firstThread: AgentThread = {
  agent: 'opencode',
  directory: '/repo',
  sessionId: 'first',
  title: 'First snapshot',
  updated: 1,
};
const secondThread: AgentThread = {
  agent: 'opencode',
  directory: '/repo',
  sessionId: 'second',
  title: 'Later snapshot',
  updated: 2,
};

await test(
  'unavailable worktrees return an empty inventory without starting a provider',
  { timeout: 1000 },
  async () => {
    const load = createSidebarThreadLoader(
      async () => false,
      async () => {
        throw new Error('Provider must not start for an unavailable worktree');
      },
    );

    const threads = await load('/removed');

    assert.deepEqual(threads, []);
  },
);

await test(
  'a worktree removed during listing returns an empty inventory',
  { timeout: 1000 },
  async () => {
    let present = true;
    const load = createSidebarThreadLoader(
      async () => present,
      async () => {
        present = false;
        throw new Error('fatal: not a git repository: /removed/.git/worktrees/task');
      },
    );

    const threads = await load('/removed-during-list');

    assert.deepEqual(threads, []);
  },
);

await test('provider errors remain visible for a valid worktree', { timeout: 1000 }, async () => {
  const failure = new Error('Provider authentication failed');
  const load = createSidebarThreadLoader(
    async () => true,
    async () => {
      throw failure;
    },
  );

  const request = load('/repo');

  await assert.rejects(request, failure);
});

await test(
  'overlapping requests for one worktree receive the same provider snapshot',
  { timeout: 1000 },
  async () => {
    const firstListing = Promise.withResolvers<AgentThread[]>();
    const snapshots = [firstListing.promise, Promise.resolve([secondThread])];
    const load = createSidebarThreadLoader(
      async () => true,
      async () => (await snapshots.shift()) ?? [],
    );

    const first = load('/repo');
    const overlapping = load('/repo');
    firstListing.resolve([firstThread]);

    assert.deepEqual(await first, [firstThread]);
    assert.deepEqual(await overlapping, [firstThread]);
  },
);

await test(
  'a blocked worktree inventory does not delay another worktree',
  { timeout: 1000 },
  async () => {
    const blocked = Promise.withResolvers<AgentThread[]>();
    const load = createSidebarThreadLoader(
      async () => true,
      async (path) => (path === '/blocked' ? blocked.promise : [secondThread]),
    );

    const first = load('/blocked');
    const independent = await load('/ready');

    assert.deepEqual(independent, [secondThread]);
    blocked.resolve([firstThread]);
    assert.deepEqual(await first, [firstThread]);
  },
);

await test(
  'completed inventories can be refreshed with a new provider snapshot',
  { timeout: 1000 },
  async () => {
    let snapshot = [firstThread];
    const load = createSidebarThreadLoader(
      async () => true,
      async () => snapshot,
    );
    assert.deepEqual(await load('/repo'), [firstThread]);

    snapshot = [secondThread];
    const refreshed = await load('/repo');

    assert.deepEqual(refreshed, [secondThread]);
  },
);

await test(
  'a failed inventory can be retried after the provider recovers',
  { timeout: 1000 },
  async () => {
    const snapshots = [
      Promise.reject(new Error('Provider is restarting')),
      Promise.resolve([secondThread]),
    ];
    const load = createSidebarThreadLoader(
      async () => true,
      async () => (await snapshots.shift()) ?? [],
    );
    await assert.rejects(load('/repo'), /Provider is restarting/);

    const retried = await load('/repo');

    assert.deepEqual(retried, [secondThread]);
  },
);

await test(
  'a previously unavailable worktree is listed when it becomes valid',
  { timeout: 1000 },
  async () => {
    let present = false;
    const load = createSidebarThreadLoader(
      async () => present,
      async () => [firstThread],
    );
    assert.deepEqual(await load('/repo'), []);

    present = true;
    const available = await load('/repo');

    assert.deepEqual(available, [firstThread]);
  },
);

await test(
  'availability failures reject without leaving a permanently pending inventory',
  { timeout: 1000 },
  async () => {
    const availability = [
      Promise.reject(new Error('Filesystem permission denied')),
      Promise.resolve(true),
    ];
    const load = createSidebarThreadLoader(
      async () => (await availability.shift()) ?? false,
      async () => [firstThread],
    );
    await assert.rejects(load('/repo'), /Filesystem permission denied/);

    const recovered = await load('/repo');

    assert.deepEqual(recovered, [firstThread]);
  },
);

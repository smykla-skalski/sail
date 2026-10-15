import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentThread } from '../src/lib/acp.ts';
import {
  createSidebarListingClock,
  createSidebarPassOwnership,
  createSidebarThreadLoader,
  mergeSidebarRefreshPaths,
  sidebarFocusRefreshDue,
  sidebarRefreshOnWindowEvent,
  unlistedSidebarPaths,
  type SidebarRefreshPaths,
} from '../src/lib/sidebar-inventory.ts';

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

void test('focus refreshes only when the last listing is at least 30 s old', () => {
  assert.equal(sidebarFocusRefreshDue(1_000, 20_000), false);
  assert.equal(sidebarFocusRefreshDue(1_000, 31_000), true);
  assert.equal(sidebarFocusRefreshDue(0, 5_000, 1_000), true);
});

void test('a catalog change lists only directories not listed before', () => {
  const listed = { '/repo': true, '/repo-wt-1': true };
  assert.deepEqual(unlistedSidebarPaths(['/repo', '/repo-wt-1', '/repo-wt-2'], listed), [
    '/repo-wt-2',
  ]);
  assert.deepEqual(unlistedSidebarPaths(['/repo'], listed), []);
});

void test('queued refresh requests merge instead of replacing each other', () => {
  const queued = mergeSidebarRefreshPaths(undefined, ['/a']);
  assert.deepEqual([...(queued ?? [])], ['/a']);
  assert.deepEqual([...(mergeSidebarRefreshPaths(queued, ['/b']) ?? [])], ['/a', '/b']);
  // Postponing a queued refresh keeps its directories.
  assert.deepEqual([...(mergeSidebarRefreshPaths(queued, undefined) ?? [])], ['/a']);
  // A full refresh absorbs partial ones, and nothing queued means a full refresh.
  assert.equal(mergeSidebarRefreshPaths(queued, 'all'), null);
  assert.equal(mergeSidebarRefreshPaths(null, ['/a']), null);
  assert.equal(mergeSidebarRefreshPaths(undefined, undefined), null);
});

const profile = Array.from({ length: 26 }, (_, index) => `/work/repo-wt-${index}`);

/** Counts the directory listings a session of focus and thread events starts. */
function listingSession() {
  const clock = createSidebarListingClock();
  let listings = 0;
  return {
    clock,
    get listings() {
      return listings;
    },
    list(wanted: SidebarRefreshPaths | undefined, now: number, directories = profile) {
      // A requested path outside the catalog stands for a thread created there.
      const outside = new Set([...(wanted ?? [])].filter((path) => !directories.includes(path)));
      const paths = clock.plan(directories, wanted, now, outside);
      listings += paths.length;
      return paths;
    },
    focus(now: number) {
      if (!clock.focusRefreshDue(now)) return [];
      return this.list(null, now);
    },
  };
}

void test('a 26-directory profile lists 26 directories at startup and none on an early focus', () => {
  const session = listingSession();

  assert.equal(session.list(new Set(profile), 1_000).length, 26);
  assert.deepEqual(session.focus(1_000 + 5_000), []);
  assert.equal(session.listings, 26);
});

void test('a thread outside the sidebar lists only its own directory', () => {
  const session = listingSession();
  session.list(new Set(profile), 1_000);

  assert.deepEqual(session.list(new Set(['/elsewhere']), 2_000), ['/elsewhere']);
  assert.equal(session.listings, 27);
  // Listing one outside directory does not restart the focus clock.
  assert.equal(session.clock.focusRefreshDue(31_000), true);
});

void test('startup, an early focus and an outside thread list 27 directories in total', () => {
  const session = listingSession();

  session.list(new Set(profile), 1_000);
  session.focus(6_000);
  session.list(new Set(['/elsewhere']), 7_000);

  assert.equal(session.listings, 27);
});

void test('focus lists everything again once the last full listing is 30 s old', () => {
  const session = listingSession();
  session.list(new Set(profile), 1_000);

  assert.deepEqual(session.focus(30_999), []);
  assert.equal(session.focus(31_000).length, 26);
  assert.equal(session.listings, 52);
});

void test('a new catalog directory and a new sidebar thread list only that directory', () => {
  const session = listingSession();
  session.list(new Set(profile), 1_000);
  const grown = [...profile, '/work/repo-wt-26'];

  assert.deepEqual(session.list(new Set(['/work/repo-wt-26']), 2_000, grown), ['/work/repo-wt-26']);
  assert.deepEqual(session.list(new Set([profile[3]]), 3_000, grown), [profile[3]]);
  assert.equal(session.listings, 28);
});

void test('a full listing request lists the catalog and restarts the focus clock', () => {
  const session = listingSession();

  assert.equal(session.list(null, 1_000).length, 26);
  assert.equal(session.clock.focusRefreshDue(10_000), false);
  assert.equal(session.clock.focusRefreshDelay(10_000), 21_000);
});

void test('a directory that left the catalog while queued is not listed', () => {
  const clock = createSidebarListingClock();
  const remaining = profile.filter((path) => path !== profile[5]);

  assert.deepEqual(clock.plan(remaining, new Set([profile[5], profile[6]]), 1_000), [profile[6]]);
  assert.deepEqual(clock.plan(remaining, new Set([profile[5]]), 2_000), []);
  // A thread's own outside directory is still listed.
  assert.deepEqual(
    clock.plan(remaining, new Set(['/elsewhere', profile[5]]), 3_000, new Set(['/elsewhere'])),
    ['/elsewhere'],
  );
});

void test('an outside thread during the startup pass keeps the startup results', () => {
  const passes = createSidebarPassOwnership();
  const startup = passes.begin(profile);
  const outside = passes.begin(['/elsewhere']);

  // The older pass finishes after the newer one started and still applies all 26 directories.
  assert.deepEqual(passes.owned(profile, startup), profile);
  assert.deepEqual(passes.owned(['/elsewhere'], outside), ['/elsewhere']);
});

void test('a newer pass owns the directories it listed again', () => {
  const passes = createSidebarPassOwnership();
  const first = passes.begin(profile);
  const second = passes.begin([profile[3]]);

  assert.deepEqual(
    passes.owned(profile, first),
    profile.filter((path) => path !== profile[3]),
  );
  assert.deepEqual(passes.owned([profile[3]], second), [profile[3]]);
  // Finishing in either order leaves one owner per directory and never loops.
  assert.deepEqual(passes.owned([profile[3]], first), []);
});

await test('only focus brings back a window that turned visible unattended', () => {
  assert.equal(sidebarRefreshOnWindowEvent('focus', 'visible', true), true);
  assert.equal(sidebarRefreshOnWindowEvent('visibilitychange', 'visible', true), true);
  assert.equal(sidebarRefreshOnWindowEvent('visibilitychange', 'visible', false), false);
  assert.equal(sidebarRefreshOnWindowEvent('visibilitychange', 'hidden', false), false);
  assert.equal(sidebarRefreshOnWindowEvent('focus', 'hidden', true), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addWorktree,
  assignRepository,
  currentCatalogWorktrees,
  externalGitWorktrees,
  loadProjectCatalog,
  owningRepository,
  removeRepository,
  removeWorktree,
  replaceRepositoryPath,
  setWorktreePullRequest,
  setWorktreeSetupStatus,
  setWorktreeStatus,
  ungroupedRepositories,
  worktreeAncestry,
  worktreeAt,
} from '../src/lib/projects.ts';

await test('restores the current repository and ignores malformed saved groups', () => {
  assert.deepEqual(loadProjectCatalog('{bad', '/repo'), {
    repositories: ['/repo'],
    groups: [],
    worktrees: {},
  });
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/first', '/first', '/second'],
      groups: [
        { id: 'one', name: 'Work', repositories: ['/first', '/missing'] },
        { id: 'two', name: 'Other', repositories: ['/first', '/second'] },
      ],
    }),
    '/current',
  );
  assert.deepEqual(catalog.repositories, ['/current', '/first', '/second']);
  assert.deepEqual(
    catalog.groups.map((group) => group.repositories),
    [['/first'], ['/second']],
  );
  assert.deepEqual(ungroupedRepositories(catalog), ['/current']);
});

await test('worktree status comments persist without changing sibling worktrees', () => {
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/repo'],
      worktrees: {
        '/repo': [
          { path: '/one', branch: 'one' },
          { path: '/two', branch: 'two' },
        ],
      },
    }),
    '/repo',
  );
  const updated = setWorktreeStatus(catalog, '/repo', '/one', '  Running tests  ');
  assert.equal(updated.worktrees['/repo'][0].statusComment, 'Running tests');
  assert.equal(updated.worktrees['/repo'][1].statusComment, undefined);
  assert.equal(
    loadProjectCatalog(JSON.stringify(updated), '/repo').worktrees['/repo'][0].statusComment,
    'Running tests',
  );
  assert.equal(
    setWorktreeStatus(updated, '/repo', '/one', '').worktrees['/repo'][0].statusComment,
    undefined,
  );
});

await test('moves repositories between named groups without losing saved entries', () => {
  const initial = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/one'],
      groups: [
        { id: 'a', name: 'Alpha', repositories: ['/one'] },
        { id: 'b', name: 'Beta', repositories: [] },
      ],
    }),
    '',
  );
  const moved = assignRepository(initial, '/one', 'b');
  assert.deepEqual(
    moved.groups.map((group) => group.repositories),
    [[], ['/one']],
  );
  assert.deepEqual(ungroupedRepositories(assignRepository(moved, '/one', null)), ['/one']);
  assert.deepEqual(removeRepository(moved, '/one').repositories, []);
});

await test('canonicalizes a saved repository without losing its group', () => {
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/var/repo'],
      groups: [{ id: 'work', name: 'Work', repositories: ['/var/repo'] }],
    }),
    '',
  );
  const normalized = replaceRepositoryPath(catalog, '/var/repo', '/private/var/repo');
  assert.deepEqual(normalized.repositories, ['/private/var/repo']);
  assert.deepEqual(normalized.groups[0].repositories, ['/private/var/repo']);
});

await test('restores collapsed projects and follows repository path changes', () => {
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/repo'],
      collapsedRepositories: ['/repo', '/missing', '/repo'],
    }),
    '',
  );
  assert.deepEqual(catalog.collapsedRepositories, ['/repo']);
  const renamed = replaceRepositoryPath(catalog, '/repo', '/canonical/repo');
  assert.deepEqual(renamed.collapsedRepositories, ['/canonical/repo']);
  assert.equal(removeRepository(renamed, '/canonical/repo').collapsedRepositories, undefined);
  const collision = replaceRepositoryPath(
    {
      ...catalog,
      repositories: ['/repo', '/canonical/repo'],
      collapsedRepositories: ['/repo', '/canonical/repo'],
    },
    '/repo',
    '/canonical/repo',
  );
  assert.deepEqual(collision.collapsedRepositories, ['/canonical/repo']);
});

await test('keeps a created worktree beneath its repository after restart', () => {
  const catalog = addWorktree(loadProjectCatalog(null, '/repo'), '/repo', {
    path: '/sail/worktrees/repo/task',
    branch: 'task',
  });
  const restored = loadProjectCatalog(JSON.stringify(catalog), '/sail/worktrees/repo/task');
  assert.deepEqual(restored.repositories, ['/repo']);
  assert.deepEqual(restored.worktrees['/repo'], [
    { path: '/sail/worktrees/repo/task', branch: 'task', setupStatus: 'ready' },
  ]);
});

await test('restores sibling worktrees in their Sail creation ancestry', () => {
  const rootGeneration =
    '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002';
  const firstGeneration =
    '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000003';
  const secondGeneration =
    '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000004';
  const first = {
    path: '/siblings/first',
    branch: 'first',
    generation: firstGeneration,
    origin: {
      sourcePath: '/repo',
      sourceGeneration: rootGeneration,
      agent: 'codex',
      sessionId: 'session-first',
      sessionTitle: 'First task',
    },
  };
  const second = {
    path: '/siblings/second',
    branch: 'second',
    generation: secondGeneration,
    origin: {
      sourcePath: '/siblings/first',
      sourceGeneration: firstGeneration,
      agent: 'claude',
      sessionId: 'session-second',
      sessionTitle: 'Second task',
    },
  };
  const registered = [
    { path: '/repo', generation: rootGeneration },
    { path: first.path, generation: firstGeneration },
    { path: second.path, generation: secondGeneration },
  ];
  const catalog = loadProjectCatalog(
    JSON.stringify(
      addWorktree(addWorktree(loadProjectCatalog(null, '/repo'), '/repo', second), '/repo', first),
    ),
    '/repo',
  );
  const rows = worktreeAncestry(catalog, '/repo', registered);
  assert.deepEqual(
    rows.map(({ worktree, depth, sourceMissing }) => [worktree.path, depth, sourceMissing]),
    [
      [first.path, 0, false],
      [second.path, 1, false],
    ],
  );
  assert.equal(rows[1].origin?.sessionId, 'session-second');
  assert.equal(rows[1].sourceLabel, 'first');

  const missingSource = worktreeAncestry(
    removeWorktree(catalog, '/repo', first.path),
    '/repo',
    registered,
  );
  assert.deepEqual(
    missingSource.map(({ depth, sourceMissing }) => [depth, sourceMissing]),
    [[0, true]],
  );
  const reusedSource = worktreeAncestry(catalog, '/repo', [
    registered[0],
    { path: first.path, generation: secondGeneration },
    registered[2],
  ]);
  assert.equal(
    reusedSource.find(({ worktree }) => worktree.path === second.path)?.sourceMissing,
    true,
  );
  const reusedChild = worktreeAncestry(catalog, '/repo', [
    registered[0],
    registered[1],
    { path: second.path, generation: firstGeneration },
  ]);
  assert.equal(
    reusedChild.find(({ worktree }) => worktree.path === second.path),
    undefined,
  );
});

await test('shows an external worktree when Git reuses a stale catalog path', () => {
  const old = addWorktree(loadProjectCatalog(null, '/repo'), '/repo', {
    path: '/sibling',
    branch: 'old',
    generation: 'old-generation',
    statusComment: 'old task',
  });
  const registered = [
    { path: '/repo', branch: 'main', generation: 'repo-generation' },
    { path: '/sibling', branch: 'external', generation: 'new-generation' },
  ];
  assert.deepEqual(currentCatalogWorktrees(old, '/repo', registered), []);
  assert.deepEqual(worktreeAncestry(old, '/repo', registered), []);
  assert.deepEqual(externalGitWorktrees(old, '/repo', registered), [
    { path: '/sibling', branch: 'external', generation: 'new-generation' },
  ]);
});

await test('does not infer ancestry for an external worktree or a reused catalog path', () => {
  const oldGeneration = '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002';
  const newGeneration = '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000003';
  const old = addWorktree(loadProjectCatalog(null, '/repo'), '/repo', {
    path: '/sibling',
    branch: 'old',
    generation: oldGeneration,
    origin: {
      sourcePath: '/repo',
      sourceGeneration: oldGeneration,
      agent: 'codex',
      sessionId: 'old-session',
      sessionTitle: 'Old task',
    },
  });
  const replaced = addWorktree(old, '/repo', {
    path: '/sibling',
    branch: 'new',
    generation: newGeneration,
  });
  const external = addWorktree(replaced, '/repo', { path: '/external', branch: 'external' });
  const rows = worktreeAncestry(loadProjectCatalog(JSON.stringify(external), '/repo'), '/repo', [
    { path: '/repo', generation: oldGeneration },
    { path: '/sibling', generation: newGeneration },
    { path: '/external', generation: null },
  ]);
  assert.deepEqual(
    rows.map(({ origin, depth }) => [origin, depth]),
    [
      [null, 0],
      [null, 0],
    ],
  );
});

await test('tracks worktree setup across failure and restart', () => {
  const catalog = addWorktree(loadProjectCatalog(null, '/repo'), '/repo', {
    path: '/repo/child',
    branch: 'child',
    setup: 'exit 7',
  });
  assert.equal(catalog.worktrees['/repo'][0].setupStatus, 'pending');
  const failed = setWorktreeSetupStatus(catalog, '/repo', '/repo/child', 'failed');
  assert.equal(
    loadProjectCatalog(JSON.stringify(failed), '/repo').worktrees['/repo'][0].setupStatus,
    'failed',
  );
  const ready = setWorktreeSetupStatus(failed, '/repo', '/repo/child', 'ready');
  assert.equal(ready.worktrees['/repo'][0].setupStatus, 'ready');
});

await test('keeps the worktree PR link after restart and rejects unsafe links', () => {
  const catalog = addWorktree(loadProjectCatalog(null, '/repo'), '/repo', {
    path: '/repo-pr',
    branch: 'feature',
    base: 'origin/main',
  });
  const linked = setWorktreePullRequest(catalog, '/repo', '/repo-pr', {
    number: 42,
    url: 'https://github.com/owner/repo/pull/42',
  });
  assert.deepEqual(loadProjectCatalog(JSON.stringify(linked), '/repo-pr').worktrees['/repo'], [
    linked.worktrees['/repo'][0],
  ]);
  const malformed = JSON.parse(JSON.stringify(linked));
  malformed.worktrees['/repo'][0].pullRequest.url = 'javascript:alert(1)';
  assert.equal(
    loadProjectCatalog(JSON.stringify(malformed), '/repo-pr').worktrees['/repo'][0].pullRequest,
    undefined,
  );
});

await test('finds the worktree for a directory and skips main checkouts', () => {
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/repo', '/other'],
      groups: [],
      worktrees: {
        '/repo': [{ path: '/wt/one', branch: 'one' }],
        '/other': [{ path: '/wt/two', branch: 'two' }],
      },
    }),
    '/repo',
  );
  assert.deepEqual(worktreeAt(catalog, '/wt/two'), {
    repository: '/other',
    worktree: { path: '/wt/two', branch: 'two' },
  });
  assert.equal(worktreeAt(catalog, '/repo'), null);
  assert.equal(worktreeAt(catalog, '/missing'), null);
});

await test('resolves the owning repository of a project or catalogued worktree only', () => {
  const catalog = loadProjectCatalog(
    JSON.stringify({
      repositories: ['/repo'],
      worktrees: { '/repo': [{ path: '/wt/one', branch: 'one' }] },
    }),
    '/repo',
  );
  assert.equal(owningRepository(catalog, '/repo'), '/repo');
  assert.equal(owningRepository(catalog, '/wt/one'), '/repo');
  assert.equal(owningRepository(catalog, '/wt/uncatalogued'), null);
});

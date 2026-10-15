import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coordinationKey,
  coordinationSourceThread,
  coordinationTarget,
  coordinationMessageForText,
  coordinationPrompt,
  enqueueCoordinationMessage,
  loadCoordinationMessages,
  projectWorktreeInfo,
  projectReceiptThreads,
} from '../src/lib/coordination.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';

function ownedReceipt(overrides: Partial<SpawnReceipt> = {}): SpawnReceipt {
  return {
    receiptId: 'receipt',
    accessKey: 'secret',
    requestId: 'request',
    project: '/repo',
    sourceId: 'acp:codex:parent',
    sourceDirectory: '/repo',
    targetId: 'acp:codex:sail-owned:receipt:session',
    targetDirectory: '/scratch/worker',
    turnId: 'turn',
    worktreeId: 'worker',
    provider: 'codex',
    prompt: null,
    state: 'working',
    created: 1,
    updated: 2,
    result: null,
    error: null,
    ...overrides,
  };
}

await test('returned owned IDs resolve without sidebar or worktree catalog entries', () => {
  const receipt = ownedReceipt();
  const threads = projectReceiptThreads([receipt], '/repo');
  assert.equal(threads.length, 1);
  assert.equal(
    coordinationTarget(threads, [receipt], '/repo', receipt.targetId!).directory,
    '/scratch/worker',
  );
});

await test('owned IDs remain scoped to their receipt project', () => {
  const receipt = ownedReceipt();
  const threads = projectReceiptThreads([receipt], '/other');
  assert.deepEqual(threads, []);
  assert.throws(
    () => coordinationTarget(threads, [receipt], '/other', receipt.targetId!),
    /not in this project/,
  );
  assert.deepEqual(projectReceiptThreads([ownedReceipt({ targetId: null })], '/repo'), []);
});

await Promise.all(
  (['interrupted', 'unavailable'] as const).map((state) =>
    test(`${state} owned ID reports lifecycle restriction and replacement action`, () => {
      const receipt = ownedReceipt({ state });
      const threads = projectReceiptThreads([receipt], '/repo');
      assert.throws(
        () => coordinationTarget(threads, [receipt], '/repo', receipt.targetId!),
        new RegExp(`Target worker is ${state}.*agent_result.*agent_spawn`),
      );
    }),
  ),
);

await test('latest receipt state controls messaging while unrelated project states do not', () => {
  const old = ownedReceipt({ state: 'interrupted', updated: 1 });
  const current = ownedReceipt({ updated: 2 });
  const foreign = ownedReceipt({ project: '/other', state: 'unavailable', updated: 3 });
  const receipts = [current, foreign, old];
  const threads = projectReceiptThreads(receipts, '/repo');
  assert.equal(
    coordinationTarget(threads, receipts, '/repo', current.targetId!).id,
    current.targetId,
  );
});

await test('worktree discovery stays in the source project and marks stale entries', () => {
  const threads = [
    { agent: 'claude', directory: '/repo/task', sessionId: 'one', title: 'Build', updated: 1 },
    { agent: 'codex', directory: '/repo/task', sessionId: 'two', title: 'Review', updated: 2 },
    { agent: 'codex', directory: '/other', sessionId: 'three', title: 'Private', updated: 3 },
  ];
  const catalog = {
    repositories: ['/repo', '/other'],
    groups: [],
    worktrees: {
      '/repo': [
        { path: '/repo/task', branch: 'task', statusComment: 'Working' },
        { path: '/repo/stale', branch: 'old' },
      ],
      '/other': [{ path: '/other/task', branch: 'private' }],
    },
  };
  const registered = [
    { path: '/repo', branch: 'main', present: true },
    { path: '/repo/task', branch: 'updated', present: true },
    { path: '/other/task', branch: 'private', present: true },
  ];
  const attention = {
    '["claude","/repo/task","one"]': { status: 'working' as const, unread: false },
  };
  const details = projectWorktreeInfo(catalog, '/repo', registered, threads, attention);
  assert.deepEqual(
    details.map(({ path, branch, stale, threadCount }) => ({ path, branch, stale, threadCount })),
    [
      { path: '/repo', branch: 'main', stale: false, threadCount: 0 },
      { path: '/repo/task', branch: 'updated', stale: false, threadCount: 2 },
      { path: '/repo/stale', branch: 'old', stale: true, threadCount: 0 },
    ],
  );
  assert.equal(details[1].statusComment, 'Working');
  assert.equal(details[1].threadStatuses.working, 1);
  assert.equal(details[1].threadStatuses.unknown, 1);
  assert.deepEqual(projectWorktreeInfo(catalog, '/missing', registered, threads, attention), []);
});

await test('worktree discovery exposes a verified creating session', () => {
  const repositoryGeneration =
    '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002';
  const childGeneration =
    '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000003';
  const origin = {
    sourcePath: '/repo',
    sourceGeneration: repositoryGeneration,
    agent: 'codex',
    sessionId: 'session-123',
    sessionTitle: 'Build task',
  };
  const catalog = {
    repositories: ['/repo'],
    groups: [],
    worktrees: {
      '/repo': [{ path: '/sibling', branch: 'task', generation: childGeneration, origin }],
    },
  };
  const registered = [
    { path: '/repo', branch: 'main', present: true, generation: repositoryGeneration },
    { path: '/sibling', branch: 'task', present: true, generation: childGeneration },
  ];
  const current = projectWorktreeInfo(catalog, '/repo', registered, [], {})[1];
  assert.deepEqual(current.origin, origin);
  assert.equal(current.sourceMissing, false);
  const missing = projectWorktreeInfo(catalog, '/repo', registered.slice(1), [], {})[1];
  assert.equal(missing.sourceMissing, true);
});

await test('messages keep sender and target across reload', () => {
  const target = coordinationKey('/repo/worktree', 'acp:claude:session-1');
  const message = {
    id: 'message-1',
    target,
    sender: 'Claude · Review',
    text: 'Please test',
    created: 123,
  };
  assert.deepEqual(loadCoordinationMessages(JSON.stringify([message])), [message]);
  assert.deepEqual(loadCoordinationMessages('{broken'), []);
  assert.deepEqual(
    loadCoordinationMessages(JSON.stringify([{ ...message, created: 'wrong' }])),
    [],
  );
  assert.deepEqual(
    loadCoordinationMessages(JSON.stringify([{ ...message, delivered: 'wrong' }])),
    [],
  );
});

await test('message queue prunes delivered entries before pending entries', () => {
  const message = {
    id: 'new',
    target: 'target',
    sender: 'Agent',
    text: 'Hello',
    created: 3,
  };
  const pending = { ...message, id: 'pending', created: 1 };
  const delivered = { ...message, id: 'delivered', created: 2, delivered: true };
  assert.deepEqual(enqueueCoordinationMessage([pending, delivered], message, 2), [
    pending,
    message,
  ]);
  assert.throws(() => enqueueCoordinationMessage([pending], message, 1), /queue is full/);
});

await test('delivered prompt matches its transcript entry for sender attribution', () => {
  const message = {
    id: 'message-1',
    target: 'target',
    sender: 'Claude · Review',
    text: 'Please test',
    created: 123,
  };
  const prompt = coordinationPrompt(message);
  assert.equal(coordinationMessageForText(prompt, [message]), message);
  assert.equal(coordinationMessageForText('Unrelated user prompt', [message]), undefined);
});

await test('opening a native child preserves source identity despite its saved recent-thread copy', () => {
  const child = {
    agent: 'opencode',
    directory: '/repo',
    sessionId: 'child',
    title: 'Child',
    updated: 1,
  };
  const recent = { ...child, title: 'Recently opened child', updated: 2 };
  const unrelated = [
    { ...child, agent: 'codex' },
    { ...child, directory: '/elsewhere' },
    { ...child, sessionId: 'parent' },
  ];
  assert.equal(coordinationSourceThread([...unrelated, child], child), child);
  assert.equal(coordinationSourceThread([...unrelated, recent, child], child)?.sessionId, 'child');
  assert.equal(coordinationSourceThread(unrelated, child), undefined);
});

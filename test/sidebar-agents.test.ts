import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupSidebarThreads,
  listSidebarOpenCodeThreads,
  sidebarThreadRows,
  sidebarThreadStatus,
  type SidebarSessionSource,
} from '../src/lib/sidebar-agents.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';

function nativeReceipt(
  sessionId: string,
  sourceId: string,
  state: SpawnReceipt['state'],
): SpawnReceipt {
  return {
    receiptId: `native:codex:${sessionId}`,
    accessKey: '',
    requestId: `native:${sessionId}`,
    project: '/repo',
    sourceId: `acp:codex:${sourceId}`,
    sourceDirectory: '/repo',
    targetId: `acp:codex:${sessionId}`,
    turnId: null,
    targetDirectory: '/repo',
    worktreeId: null,
    provider: 'codex',
    prompt: sessionId,
    state,
    created: 1,
    updated: 2,
    result: state === 'completed' ? 'Completed' : null,
    error: null,
  };
}

await test('sidebar groups every thread by checkout and keeps distinct sessions', () => {
  const grouped = groupSidebarThreads([
    { agent: 'claude', directory: '/repo/a', sessionId: 'one', title: 'Old', updated: 1 },
    { agent: 'claude', directory: '/repo/a', sessionId: 'two', title: 'Second', updated: 2 },
    { agent: 'codex', directory: '/repo/a', sessionId: 'one', title: 'Codex', updated: 3 },
    { agent: 'claude', directory: '/repo/b', sessionId: 'one', title: 'Other', updated: 4 },
    { agent: 'claude', directory: '/repo/a', sessionId: 'one', title: 'Renamed', updated: 5 },
  ]);
  assert.deepEqual(
    grouped['/repo/a'].map(({ title }) => title),
    ['Renamed', 'Codex', 'Second'],
  );
  assert.deepEqual(
    grouped['/repo/b'].map(({ title }) => title),
    ['Other'],
  );
});

await test('fresh OpenCode outcome replaces stale saved terminal status', () => {
  const thread = {
    agent: 'opencode',
    directory: '/repo/a',
    sessionId: 'one',
    title: 'Agent',
    updated: 1,
  };
  const key = JSON.stringify(['opencode', '/repo/a', 'one']);
  assert.equal(
    sidebarThreadStatus(
      thread,
      { [key]: { status: 'done', unread: false } },
      { [key]: 'failed' },
      true,
      true,
      [],
    ),
    'failed',
  );
  assert.equal(
    sidebarThreadStatus(
      thread,
      { [key]: { status: 'failed', unread: false } },
      { [key]: 'done' },
      true,
      true,
      [],
    ),
    'done',
  );
});

await test('active subagent keeps a finished parent visibly working', () => {
  const thread = {
    agent: 'codex',
    directory: '/repo',
    sessionId: 'parent',
    title: 'Parent',
    updated: 1,
  };
  const key = JSON.stringify(['codex', '/repo', 'parent']);
  const receipt: SpawnReceipt = {
    receiptId: 'one',
    accessKey: 'key',
    requestId: 'request',
    project: '/repo',
    sourceId: 'acp:codex:parent',
    sourceDirectory: '/repo',
    targetId: 'acp:codex:child',
    turnId: 'turn',
    targetDirectory: '/repo/task',
    worktreeId: '/repo/task',
    provider: 'codex',
    prompt: 'Task',
    state: 'working',
    created: 1,
    updated: 2,
    result: null,
    error: null,
  };
  const status = (receipts: SpawnReceipt[], ready = true) =>
    sidebarThreadStatus(
      thread,
      { [key]: { status: 'done', unread: false } },
      {},
      ready,
      true,
      [],
      receipts,
    );
  assert.equal(status([receipt]), 'working');
  assert.equal(status([{ ...receipt, state: 'waiting' }]), 'waiting');
  assert.equal(status([{ ...receipt, turnId: null }]), 'working');
  assert.equal(
    sidebarThreadStatus(
      thread,
      { [key]: { status: 'failed', unread: false } },
      {},
      true,
      true,
      [],
      [receipt],
    ),
    'failed',
  );
  assert.equal(status([{ ...receipt, state: 'completed' }]), 'done');
  assert.equal(status([{ ...receipt, state: 'queued', targetId: null, turnId: null }]), null);
  assert.equal(status([{ ...receipt, sourceDirectory: '/other' }]), 'done');
  assert.equal(status([receipt], false), null);
  assert.equal(
    sidebarThreadStatus(
      { ...thread, agent: 'opencode' },
      { [JSON.stringify(['opencode', '/repo', 'parent'])]: { status: 'done', unread: false } },
      {},
      true,
      false,
      [],
      [{ ...receipt, sourceId: 'opencode:parent' }],
    ),
    'working',
  );
});

await test('native child rows use their own outcome without parent attention state', () => {
  const thread = {
    agent: 'codex',
    directory: '/repo',
    sessionId: 'child',
    title: 'Child',
    updated: 1,
  };
  const receipt: SpawnReceipt = {
    receiptId: 'native:codex:child',
    accessKey: '',
    requestId: 'native:child',
    project: '/repo',
    sourceId: 'acp:codex:parent',
    sourceDirectory: '/repo',
    targetId: 'acp:codex:child',
    turnId: null,
    targetDirectory: '/repo',
    worktreeId: null,
    provider: 'codex',
    prompt: 'Child',
    state: 'waiting',
    created: 1,
    updated: 2,
    result: null,
    error: null,
  };
  const status = (state: SpawnReceipt['state']) =>
    sidebarThreadStatus(thread, {}, {}, true, true, [], [{ ...receipt, state }]);
  assert.equal(status('waiting'), 'waiting');
  assert.equal(status('completed'), 'done');
  assert.equal(status('failed'), 'failed');
  assert.equal(status('unavailable'), null);
});

await test('native sidebar rows preserve ancestry and collapse settled subtrees', () => {
  const parent = {
    agent: 'codex',
    directory: '/repo',
    sessionId: 'parent',
    title: 'Parent',
    updated: 1,
  };
  const child = { ...parent, sessionId: 'child', title: 'Child', updated: 3 };
  const grandchild = { ...parent, sessionId: 'grandchild', title: 'Grandchild', updated: 4 };
  const sibling = { ...parent, sessionId: 'sibling', title: 'Sibling', updated: 2 };
  const receipts = [
    nativeReceipt('child', 'parent', 'working'),
    nativeReceipt('grandchild', 'child', 'working'),
    nativeReceipt('sibling', 'parent', 'completed'),
  ];

  const collapsed = sidebarThreadRows([grandchild, child, sibling, parent], receipts);
  assert.deepEqual(
    collapsed.map((row) => [row.thread.sessionId, row.depth]),
    [
      ['parent', 0],
      ['child', 1],
      ['grandchild', 2],
    ],
  );
  assert.equal(collapsed[0].hiddenHistoricalChildren, 1);
  const expanded = sidebarThreadRows([grandchild, child, sibling, parent], receipts, [
    JSON.stringify(['codex', '/repo', 'parent']),
  ]);
  assert.deepEqual(
    expanded.map((row) => row.thread.sessionId),
    ['parent', 'child', 'grandchild', 'sibling'],
  );
});

await test('sidebar inventory follows every OpenCode page and excludes child and foreign sessions', async () => {
  const calls: Array<string | undefined> = [];
  const source: SidebarSessionSource = {
    session: {
      list: async ({ cursor }: { cursor?: string }) => {
        calls.push(cursor);
        return cursor
          ? {
              data: [
                {
                  id: 'second',
                  title: 'Second agent',
                  location: { directory: '/repo/a' },
                  time: { updated: 2 },
                  outcome: 'failed',
                },
                {
                  id: 'foreign',
                  location: { directory: '/repo/b' },
                  time: { updated: 3 },
                },
              ],
              cursor: { next: null },
            }
          : {
              data: [
                {
                  id: 'first',
                  location: { directory: '/repo/a' },
                  time: { updated: 1 },
                  outcome: 'succeeded',
                },
                {
                  id: 'child',
                  parentID: 'first',
                  location: { directory: '/repo/a' },
                  time: { updated: 2 },
                },
              ],
              cursor: { next: 'page-2' },
            };
      },
    },
  };
  const result = await listSidebarOpenCodeThreads(source, '/repo/a');
  assert.deepEqual(calls, [undefined, 'page-2']);
  assert.deepEqual(
    result.threads.map((thread) => thread.sessionId),
    ['first', 'second'],
  );
  assert.equal(result.threads[0].title, 'Untitled session');
  assert.deepEqual(Object.values(result.outcomes), ['done', 'failed']);
});

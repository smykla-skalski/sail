import assert from 'node:assert/strict';
import type { AgentSessionListing } from '../src/lib/acp.ts';
import test from 'node:test';
import {
  advanceFailedChildNotices,
  failedChildCount,
  failedChildLabel,
  groupSidebarThreads,
  openedFailedChildren,
  listSidebarAcpThreads,
  listOpenCodeChildSessionIds,
  recordSidebarOpenCodeOutcome,
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
    ),
    'failed',
  );
  assert.equal(
    sidebarThreadStatus(
      thread,
      { [key]: { status: 'failed', unread: false } },
      { [key]: 'done' },
      true,
    ),
    'done',
  );
  assert.equal(
    sidebarThreadStatus(
      thread,
      { [key]: { status: 'done', unread: false } },
      { [key]: 'interrupted' },
      true,
    ),
    'interrupted',
  );
});

await test('later OpenCode completion replaces interrupted sidebar outcome when refresh fails', () => {
  const thread = {
    agent: 'opencode',
    directory: '/repo/a',
    sessionId: 'one',
    title: 'Agent',
    updated: 2,
  };
  const key = JSON.stringify(['opencode', '/repo/a', 'one']);
  const otherKey = JSON.stringify(['opencode', '/repo/a', 'two']);
  const stale = { [key]: 'interrupted' as const, [otherKey]: 'failed' as const };
  const current = recordSidebarOpenCodeOutcome(stale, thread, 'done');
  assert.deepEqual(current, { [key]: 'done', [otherKey]: 'failed' });
  assert.equal(
    sidebarThreadStatus(thread, { [key]: { status: 'done', unread: false } }, current, true),
    'done',
  );
  assert.equal(stale[key], 'interrupted');
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
    sidebarThreadStatus(thread, { [key]: { status: 'done', unread: false } }, {}, ready, receipts);
  assert.equal(status([receipt]), 'working');
  assert.equal(status([{ ...receipt, state: 'waiting' }]), 'waiting');
  assert.equal(status([{ ...receipt, turnId: null }]), 'working');
  assert.equal(
    sidebarThreadStatus(thread, { [key]: { status: 'failed', unread: false } }, {}, true, [
      receipt,
    ]),
    'failed',
  );
  assert.equal(status([{ ...receipt, state: 'completed' }]), 'done');
  assert.equal(status([{ ...receipt, state: 'interrupted' }]), 'done');
  assert.equal(
    sidebarThreadStatus(thread, { [key]: { status: 'interrupted', unread: false } }, {}, true, [
      receipt,
    ]),
    'interrupted',
  );
  assert.equal(status([{ ...receipt, state: 'queued', targetId: null, turnId: null }]), null);
  assert.equal(status([{ ...receipt, sourceDirectory: '/other' }]), 'done');
  assert.equal(status([receipt], false), null);
  assert.equal(
    sidebarThreadStatus(
      { ...thread, agent: 'opencode' },
      { [JSON.stringify(['opencode', '/repo', 'parent'])]: { status: 'done', unread: false } },
      {},
      true,
      [{ ...receipt, sourceId: 'acp:opencode:parent' }],
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
    sidebarThreadStatus(thread, {}, {}, true, [{ ...receipt, state }]);
  assert.equal(status('waiting'), 'waiting');
  assert.equal(status('completed'), 'done');
  assert.equal(status('failed'), 'failed');
  assert.equal(status('interrupted'), 'interrupted');
  assert.equal(
    sidebarThreadStatus(
      { ...thread, updated: 3 },
      { [JSON.stringify(['codex', '/repo', 'child'])]: { status: 'done', unread: false } },
      {},
      true,
      [{ ...receipt, state: 'interrupted' }],
    ),
    'done',
  );
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

await test('parents count every descendant', () => {
  const parent = {
    agent: 'codex',
    directory: '/repo',
    sessionId: 'parent',
    title: 'Parent',
    updated: 1,
  };
  const child = { ...parent, sessionId: 'child', title: 'Child', updated: 3 };
  const grandchild = { ...parent, sessionId: 'grandchild', title: 'Grandchild', updated: 4 };
  const rows = sidebarThreadRows(
    [parent, child, grandchild],
    [nativeReceipt('child', 'parent', 'working'), nativeReceipt('grandchild', 'child', 'working')],
  );
  assert.deepEqual(
    rows.map((row) => [row.thread.sessionId, row.descendants]),
    [
      ['parent', 2],
      ['child', 1],
      ['grandchild', 0],
    ],
  );
});

await test('a child in another worktree shows as a reference row under its parent', () => {
  const parent = { agent: 'claude', directory: '/a', sessionId: 'p', title: 'Parent', updated: 1 };
  const remote = {
    agent: 'claude',
    directory: '/b',
    sessionId: 'r',
    title: 'Reviewer',
    updated: 2,
  };
  const mcp: SpawnReceipt = {
    ...nativeReceipt('r', 'p', 'working'),
    receiptId: 'mcp-1',
    sourceId: 'acp:claude:p',
    sourceDirectory: '/a',
    targetId: 'acp:claude:r',
    targetDirectory: '/b',
    provider: 'claude',
  };
  const everyThread = [parent, remote];
  const parentRows = sidebarThreadRows([parent], [mcp], [], everyThread);
  assert.deepEqual(
    parentRows.map((row) => [row.thread.sessionId, row.reference, row.depth]),
    [
      ['p', false, 0],
      ['r', true, 1],
    ],
  );
  assert.equal(parentRows[0].descendants, 1);
  assert.notEqual(parentRows[1].key, parentRows[0].key);
  const remoteRows = sidebarThreadRows([remote], [mcp], [], everyThread);
  assert.equal(remoteRows[0].reference, false);
  assert.equal(remoteRows[0].spawnedBy, 'Parent');
});

await test('a settled cross-worktree child leaves no reference row', () => {
  const parent = { agent: 'claude', directory: '/a', sessionId: 'p', title: 'Parent', updated: 1 };
  const done: SpawnReceipt = {
    ...nativeReceipt('r', 'p', 'completed'),
    receiptId: 'mcp-2',
    sourceId: 'acp:claude:p',
    sourceDirectory: '/a',
    targetId: 'acp:claude:r',
    targetDirectory: '/b',
  };
  assert.equal(sidebarThreadRows([parent], [done]).length, 1);
});

await test('OpenCode children nest under their parent', () => {
  const parent = {
    agent: 'opencode',
    directory: '/repo',
    sessionId: 'p',
    title: 'Parent',
    updated: 1,
  };
  const child: SpawnReceipt = {
    ...nativeReceipt('c', 'p', 'working'),
    receiptId: 'opencode-child:c',
    sourceId: 'acp:opencode:p',
    targetId: 'acp:opencode:c',
    provider: 'opencode',
    prompt: 'Review',
  };
  const rows = sidebarThreadRows([parent], [child]);
  assert.deepEqual(
    rows.map((row) => [row.thread.agent, row.thread.sessionId, row.thread.title, row.depth]),
    [
      ['opencode', 'p', 'Parent', 0],
      ['opencode', 'c', 'Review', 1],
    ],
  );
});

await test('OpenCode child session ids come from every native page', async () => {
  const calls: Array<string | undefined> = [];
  const pages: Record<string, Awaited<ReturnType<SidebarSessionSource['session']['list']>>> = {
    first: {
      data: [
        { id: 'root', location: { directory: '/repo/a' }, time: { updated: 1 } },
        { id: 'child', parentID: 'root', location: { directory: '/repo/a' }, time: { updated: 2 } },
      ],
      cursor: { next: 'page-2' },
    },
    'page-2': {
      data: [
        {
          id: 'grandchild',
          parentID: 'child',
          location: { directory: '/repo/a' },
          time: { updated: 3 },
        },
      ],
      cursor: { next: 'page-2' },
    },
  };
  const source: SidebarSessionSource = {
    session: {
      list: ({ cursor }) => {
        calls.push(cursor);
        return Promise.resolve(pages[cursor ?? 'first']);
      },
    },
  };
  const children = await listOpenCodeChildSessionIds(source, '/repo/a');
  assert.deepEqual(calls, [undefined, 'page-2']);
  assert.deepEqual([...children].toSorted(), ['child', 'grandchild']);
});

const parentThread = {
  agent: 'codex',
  directory: '/repo',
  sessionId: 'parent',
  title: 'p',
  updated: 9,
};
const childThread = (sessionId: string) => ({
  agent: 'codex',
  directory: '/repo',
  sessionId,
  title: sessionId,
  updated: 5,
});

await test('a failed child stays listed while completed ones collapse', () => {
  const rows = sidebarThreadRows(
    [parentThread, childThread('broke'), childThread('fine')],
    [nativeReceipt('broke', 'parent', 'failed'), nativeReceipt('fine', 'parent', 'completed')],
  );
  assert.deepEqual(
    rows.map((row) => row.thread.sessionId),
    ['parent', 'broke'],
  );
  assert.equal(rows[0].hiddenHistoricalChildren, 1);
  assert.equal(rows[0].historicalChildren, 1);
});

await test('a failed child notice clears after the next parent turn completes', () => {
  const receipts = [nativeReceipt('broke', 'parent', 'failed')];
  const turn = { busy: true };
  const parentBusy = () => turn.busy;
  const count = (notices: ReturnType<typeof advanceFailedChildNotices>) =>
    failedChildCount(notices, receipts, 'acp:codex:parent', '/repo');

  // The child fails while the parent's own turn runs, and that turn ending is not "next".
  let notices = advanceFailedChildNotices({}, receipts, parentBusy);
  assert.equal(count(notices), 1);
  turn.busy = false;
  notices = advanceFailedChildNotices(notices, receipts, parentBusy);
  assert.equal(count(notices), 1);
  // The next turn runs, and the notice stays until that turn completes.
  turn.busy = true;
  notices = advanceFailedChildNotices(notices, receipts, parentBusy);
  assert.equal(count(notices), 1);
  turn.busy = false;
  notices = advanceFailedChildNotices(notices, receipts, parentBusy);
  assert.equal(count(notices), 0);
  // A cleared notice does not return, even when the receipt disappears and comes back.
  notices = advanceFailedChildNotices(notices, [], parentBusy);
  assert.equal(count(advanceFailedChildNotices(notices, receipts, parentBusy)), 0);
});

await test('a failed child notice clears when the child is opened', () => {
  const receipts = [
    nativeReceipt('broke', 'parent', 'failed'),
    nativeReceipt('other', 'parent', 'failed'),
    nativeReceipt('working', 'parent', 'working'),
  ];
  let notices = advanceFailedChildNotices({}, receipts, () => false);
  assert.equal(failedChildCount(notices, receipts, 'acp:codex:parent', '/repo'), 2);
  const opened = openedFailedChildren(receipts, childThread('broke'));
  assert.deepEqual([...opened], ['native:codex:broke']);
  notices = advanceFailedChildNotices(notices, receipts, () => false, opened);
  assert.equal(failedChildCount(notices, receipts, 'acp:codex:parent', '/repo'), 1);
  assert.equal(openedFailedChildren(receipts, null).size, 0);
  assert.equal(openedFailedChildren(receipts, childThread('working')).size, 0);
});

await test('a child that fails again after being opened and resumed notifies again', () => {
  const failed = [nativeReceipt('broke', 'parent', 'failed')];
  const resumed = [nativeReceipt('broke', 'parent', 'working')];
  const count = (notices: ReturnType<typeof advanceFailedChildNotices>) =>
    failedChildCount(notices, failed, 'acp:codex:parent', '/repo');
  let notices = advanceFailedChildNotices({}, failed, () => false);
  notices = advanceFailedChildNotices(
    notices,
    failed,
    () => false,
    openedFailedChildren(failed, childThread('broke')),
  );
  assert.equal(count(notices), 0);
  notices = advanceFailedChildNotices(notices, resumed, () => false);
  notices = advanceFailedChildNotices(notices, failed, () => false);
  assert.equal(count(notices), 1);
  assert.equal(failedChildLabel(count(notices)), '1 failed child');
});

await test('failed child notices count only failed native children of that parent', () => {
  const receipts = [
    nativeReceipt('a', 'parent', 'failed'),
    nativeReceipt('b', 'elsewhere', 'failed'),
    { ...nativeReceipt('c', 'parent', 'failed'), receiptId: 'mcp:c' },
  ];
  const notices = advanceFailedChildNotices({}, receipts, () => false);
  assert.equal(failedChildCount(notices, receipts, 'acp:codex:parent', '/repo'), 1);
  assert.equal(failedChildCount(notices, receipts, 'acp:codex:parent', '/other'), 0);
  assert.equal(
    advanceFailedChildNotices(notices, receipts, () => false),
    notices,
  );
  assert.equal(failedChildLabel(1), '1 failed child');
  assert.equal(failedChildLabel(2), '2 failed children');
});

await test('ACP listing pages through the cursor and keeps only the asked directory', async () => {
  const pages: Record<string, AgentSessionListing> = {
    first: {
      sessions: [
        {
          sessionId: 'ses_a',
          cwd: '/repo/a',
          title: 'Outside Sail',
          updatedAt: '2026-01-02T00:00:00Z',
        },
        { sessionId: 'ses_other', cwd: '/repo/b', title: 'Elsewhere' },
      ],
      nextCursor: 'second',
    },
    second: {
      sessions: [{ sessionId: 'ses_b', cwd: '/repo/a/', title: null }],
      nextCursor: 'second',
    },
  };
  const asked: (string | undefined)[] = [];
  const threads = await listSidebarAcpThreads(
    'opencode',
    (cursor) => {
      asked.push(cursor);
      return Promise.resolve(pages[cursor ?? 'first']);
    },
    '/repo/a',
  );
  assert.deepEqual(asked, [undefined, 'second']);
  assert.deepEqual(
    threads.map((thread) => [thread.agent, thread.sessionId, thread.title, thread.updated]),
    [
      ['opencode', 'ses_a', 'Outside Sail', Date.parse('2026-01-02T00:00:00Z')],
      ['opencode', 'ses_b', 'Untitled session', 0],
    ],
  );
});

await test('ACP listing skips entries without a session id', async () => {
  // Parsed JSON stands in for what an agent sends, including values the types forbid.
  const listing: AgentSessionListing = JSON.parse(
    JSON.stringify({
      sessions: [
        { sessionId: '', cwd: '/repo/a', title: 'Empty id' },
        { sessionId: '  ', cwd: '/repo/a', title: 'Blank id' },
        { sessionId: 42, cwd: '/repo/a', title: 'Numeric id' },
        { sessionId: 'ses_ok', cwd: '/repo/a', title: 'Real' },
      ],
    }),
  );
  const threads = await listSidebarAcpThreads(
    'opencode',
    () => Promise.resolve(listing),
    '/repo/a',
  );
  assert.deepEqual(
    threads.map((thread) => thread.sessionId),
    ['ses_ok'],
  );
});

await test('ACP listing failure reaches the caller instead of an empty list', async () => {
  await assert.rejects(
    listSidebarAcpThreads('opencode', () => Promise.reject(new Error('agent exited')), '/repo/a'),
    /agent exited/,
  );
});

await test('a Sail title survives when the agent lists the same thread', () => {
  const saved = {
    agent: 'opencode',
    directory: '/repo/a',
    sessionId: 'ses_a',
    title: 'My name',
    updated: 1,
    renamed: true,
  };
  const listed = { ...saved, title: 'Agent name', updated: 5, renamed: undefined };
  for (const order of [
    [saved, listed],
    [listed, saved],
  ]) {
    const [thread] = groupSidebarThreads(order)['/repo/a'];
    assert.equal(thread.title, 'My name');
    assert.equal(thread.updated, 5);
    assert.equal(thread.renamed, true);
  }
});

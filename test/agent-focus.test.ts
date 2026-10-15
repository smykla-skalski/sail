import assert from 'node:assert/strict';
import test from 'node:test';
import { agentFocusDisplay, restoredFocusActiveTurns } from '../src/lib/agent-focus.ts';
import { buildAgentStatusItems } from '../src/lib/agent-status.ts';
import { createTaskStore, type TaskSnapshot } from '../src/lib/session-tasks.ts';
import { buildTaskOverviewCards } from '../src/lib/task-overview.ts';
import { threadKey } from '../src/lib/recent-threads.ts';

const snapshot: TaskSnapshot = {
  turnId: 'turn',
  revision: 2,
  focus: 'inspect',
  reportedAt: 1_700_000_000_000,
  tasks: [
    {
      id: 'inspect',
      title: 'Inspect repository',
      status: 'in_progress',
      origin: 'agent',
      turnId: 'turn',
    },
  ],
};

void test('reported focus is distinguished from observed status and retains its report time', () => {
  assert.deepEqual(agentFocusDisplay(snapshot, 'working', 'turn'), {
    text: 'Inspect repository',
    source: 'Agent report',
    reportedAt: 1_700_000_000_000,
  });
});

for (const [name, value, status, turn, text] of [
  ['no report', null, 'working', 'turn', 'Working — no focus reported'],
  [
    'Sail starting task',
    { ...snapshot, tasks: [{ ...snapshot.tasks[0], origin: 'sail' }] },
    'working',
    'turn',
    'Working — no focus reported',
  ],
  ['different turn', snapshot, 'working', 'next', 'Working — no focus reported'],
  ['missing runtime turn', snapshot, 'working', null, 'Working — no focus reported'],
  [
    'done focus',
    { ...snapshot, tasks: [{ ...snapshot.tasks[0], status: 'done' }] },
    'working',
    'turn',
    'Working — no focus reported',
  ],
  ['waiting', snapshot, 'waiting', 'turn', 'Waiting for input'],
  ['completed', snapshot, 'done', null, 'Turn completed'],
  ['failed', snapshot, 'failed', null, 'Turn failed'],
  ['interrupted', snapshot, 'interrupted', null, 'Turn interrupted'],
] as const) {
  void test(`${name} uses observed state without stale reported focus`, () => {
    assert.deepEqual(agentFocusDisplay(value, status, turn), {
      text,
      source: 'Observed status',
      reportedAt: null,
    });
  });
}

void test('reports persist Sail timestamps and a new turn clears the old report time', async () => {
  let saved: string | null = null;
  let now = 1000;
  const storage = {
    read: () => saved,
    write: async (value: string) => {
      saved = value;
    },
  };
  const store = createTaskStore(storage, () => now);
  const scope = { agent: 'codex', directory: '/repo', sessionId: 'one' };
  await store.start(scope, 'turn');
  now = 2000;
  await store.report(scope, {
    turnId: 'turn',
    expectedRevision: 1,
    tasks: [{ id: 'inspect', title: 'Inspect', status: 'in_progress' }],
    focus: 'inspect',
  });

  assert.equal(createTaskStore(storage).snapshot(scope).reportedAt, 2000);
  await store.finish(scope, 'turn');
  await store.start(scope, 'next');
  assert.equal(store.snapshot(scope).reportedAt, null);
  assert.equal(agentFocusDisplay(store.snapshot(scope), 'working')?.source, 'Observed status');
});

void test('legacy snapshots restore tasks without inventing a report timestamp', () => {
  const legacy = { ...snapshot };
  delete legacy.reportedAt;
  const scope = { agent: 'codex', directory: '/repo', sessionId: 'one' };
  const store = createTaskStore({
    read: () => JSON.stringify([{ scope, snapshot: legacy, updated: 1000 }]),
    write: async () => {},
  });

  assert.equal(store.snapshot(scope).tasks[0].title, 'Inspect repository');
  assert.equal(agentFocusDisplay(store.snapshot(scope), 'working')?.reportedAt, null);
});

void test('restored active native child keeps its reported focus visible', () => {
  const parent = {
    agent: 'claude',
    directory: '/repo',
    sessionId: 'parent',
    title: 'Parent',
    updated: 1,
  } as const;
  const child = {
    ...parent,
    sessionId: 'child',
    title: 'Child',
    updated: 2,
  };
  const activeTurns = restoredFocusActiveTurns([parent, child], {
    '["/repo","claude"]': {
      alive: true,
      active: ['child'],
      activeTurns: { child: 'turn' },
      waiting: [],
      sessions: ['parent', 'child'],
      finished: {},
    },
  });

  assert.deepEqual(agentFocusDisplay(snapshot, 'working', activeTurns[threadKey(child)]), {
    text: 'Inspect repository',
    source: 'Agent report',
    reportedAt: 1_700_000_000_000,
  });
});

void test('Tasks and compact Agents rows keep simultaneous provider sessions separate', () => {
  const threads = [
    { agent: 'codex', directory: '/repo', sessionId: 'one', title: 'First', updated: 1 },
    { agent: 'codex', directory: '/repo', sessionId: 'two', title: 'Second', updated: 2 },
    { agent: 'claude', directory: '/repo', sessionId: 'one', title: 'Third', updated: 3 },
  ];
  const keys = threads.map(threadKey);
  const focusByThread = {
    [keys[0]]: { text: 'Review code', source: 'Agent report' as const, reportedAt: 1000 },
    [keys[1]]: { text: 'Run tests', source: 'Agent report' as const, reportedAt: 2000 },
    [keys[2]]: { text: 'Waiting for input', source: 'Observed status' as const, reportedAt: null },
  };
  const statuses = {
    [keys[0]]: 'working' as const,
    [keys[1]]: 'working' as const,
    [keys[2]]: 'waiting' as const,
  };
  const items = buildAgentStatusItems({
    threads,
    statuses,
    focusByThread,
    attention: {},
    agentNames: {},
    usage: {},
    rates: {},
  });
  const cards = buildTaskOverviewCards({
    catalog: { repositories: ['/repo'], groups: [], worktrees: {} },
    threads: { '/repo': threads },
    statuses,
    focusByThread,
    agentNames: {},
    checks: [],
    receipts: [],
  });

  assert.deepEqual(
    items.map((item) => item.focus?.text),
    ['Waiting for input', 'Run tests', 'Review code'],
  );
  assert.deepEqual(
    cards[0].agentFocus.map((entry) => [entry.key, entry.focus.text]),
    [
      ['["codex","/repo","one"]', 'Review code'],
      ['["codex","/repo","two"]', 'Run tests'],
      ['["claude","/repo","one"]', 'Waiting for input'],
    ],
  );
});

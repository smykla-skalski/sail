import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentThread } from '../src/lib/acp.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import type { PostTurnCheck } from '../src/lib/post-turn-checks.ts';
import type { ProjectCatalog } from '../src/lib/projects.ts';
import {
  buildTaskOverviewCards,
  filterTaskOverviewCards,
  loadTaskOverviewPreferences,
  sortTaskOverviewCards,
} from '../src/lib/task-overview.ts';

const catalog: ProjectCatalog = {
  repositories: ['/code/alpha'],
  groups: [],
  worktrees: {
    '/code/alpha': [
      { path: '/work/urgent', branch: 'feat/urgent' },
      { path: '/work/quiet', branch: 'fix/quiet', setupStatus: 'failed' },
    ],
  },
};

const thread = (path: string, title: string, agent: string, updated: number): AgentThread => ({
  directory: path,
  title,
  agent,
  sessionId: `${title}-${updated}`,
  updated,
});

void test('cards expose the most urgent agent and latest meaningful event', () => {
  const working = thread('/work/urgent', 'Background task', 'codex', 30);
  const waiting = thread('/work/urgent', 'Needs a decision', 'claude', 20);
  const checks: PostTurnCheck[] = [
    {
      id: 'check',
      updated: 40,
      directory: '/work/urgent',
      thread: 'acp:claude:Needs a decision-20',
      turn: 'turn',
      source: 'repository',
      command: 'npm test',
      status: 'failed',
      output: 'failed',
      code: 1,
    },
  ];
  const receipts = [
    {
      receiptId: 'receipt',
      accessKey: 'key',
      requestId: 'request',
      project: '/code/alpha',
      sourceId: 'source',
      sourceDirectory: '/work/urgent',
      targetId: null,
      turnId: 'turn',
      targetDirectory: '/work/urgent',
      worktreeId: null,
      provider: 'codex',
      prompt: 'Investigate',
      state: 'working',
      created: 45,
      updated: 45,
      result: null,
      error: null,
      activity: 'Inspecting the failing test',
    },
  ] satisfies SpawnReceipt[];

  const cards = buildTaskOverviewCards({
    catalog,
    threads: { '/work/urgent': [working, waiting] },
    statuses: {
      '["codex","/work/urgent","Background task-30"]': 'working',
      '["claude","/work/urgent","Needs a decision-20"]': 'waiting',
    },
    agentNames: { codex: 'Codex', claude: 'Claude' },
    checks,
    receipts,
  });

  assert.deepEqual(
    cards.find((card) => card.path === '/work/urgent'),
    {
      id: '/work/urgent',
      path: '/work/urgent',
      repository: '/code/alpha',
      repositoryName: 'alpha',
      branch: 'feat/urgent',
      task: 'Needs a decision',
      threadKey: '["claude","/work/urgent","Needs a decision-20"]',
      agent: 'claude',
      agentName: 'Claude',
      status: 'waiting',
      nextAction: 'Respond to Claude',
      latestEvent: 'Inspecting the failing test',
      updated: 45,
      checkState: 'failed',
      check: checks[0],
      setupFailed: false,
    },
  );
});

void test('empty and failed worktrees never imply successful activity', () => {
  const cards = buildTaskOverviewCards({
    catalog,
    threads: {},
    statuses: {},
    agentNames: {},
    checks: [],
    receipts: [],
  });

  assert.deepEqual(
    cards.map(({ path, status, task, nextAction, checkState }) => ({
      path,
      status,
      task,
      nextAction,
      checkState,
    })),
    [
      {
        path: '/code/alpha',
        status: null,
        task: 'No active task',
        nextAction: 'Start an agent',
        checkState: 'none',
      },
      {
        path: '/work/urgent',
        status: null,
        task: 'No active task',
        nextAction: 'Start an agent',
        checkState: 'none',
      },
      {
        path: '/work/quiet',
        status: null,
        task: 'No active task',
        nextAction: 'Repair worktree setup',
        checkState: 'none',
      },
    ],
  );
});

void test('checks aggregate the newest turn without stale failures', () => {
  const checks = [
    {
      id: 'old-failure',
      updated: 10,
      directory: '/work/urgent',
      thread: 'thread',
      turn: 'old-turn',
      source: 'repository',
      command: 'npm test',
      status: 'failed',
      output: 'failed',
      code: 1,
    },
    {
      id: 'new-pass',
      updated: 20,
      directory: '/work/urgent',
      thread: 'thread',
      turn: 'new-turn',
      source: 'repository',
      command: 'npm test',
      status: 'passed',
      output: 'passed',
      code: 0,
    },
    {
      id: 'new-failure',
      updated: 21,
      directory: '/work/urgent',
      thread: 'thread',
      turn: 'new-turn',
      source: 'repository',
      command: 'npm run lint',
      status: 'timed_out',
      output: 'timed out',
      code: null,
    },
  ] satisfies PostTurnCheck[];
  const cards = buildTaskOverviewCards({
    catalog,
    threads: {},
    statuses: {},
    agentNames: {},
    checks,
    receipts: [],
  });
  const card = cards.find((item) => item.path === '/work/urgent');

  assert.equal(card?.checkState, 'failed');
  assert.equal(card?.check?.id, 'new-failure');
  assert.equal(card?.latestEvent, 'Check timed_out: npm run lint');

  const passingCards = buildTaskOverviewCards({
    catalog,
    threads: {},
    statuses: {},
    agentNames: {},
    checks: checks.filter((check) => check.id !== 'new-failure'),
    receipts: [],
  });
  assert.equal(passingCards.find((item) => item.path === '/work/urgent')?.checkState, 'passed');

  const canceledCards = buildTaskOverviewCards({
    catalog,
    threads: {},
    statuses: {},
    agentNames: {},
    checks: [{ ...checks[1], id: 'new-canceled', status: 'canceled' }],
    receipts: [],
  });
  assert.equal(canceledCards.find((item) => item.path === '/work/urgent')?.checkState, 'other');
});

void test('search matches task, repository, branch, and agent fields', () => {
  const cards = buildTaskOverviewCards({
    catalog,
    threads: { '/work/urgent': [thread('/work/urgent', 'Unicode 🧭 task', 'claude', 20)] },
    statuses: { 'claude:/work/urgent:Unicode 🧭 task-20': 'done' },
    agentNames: { claude: 'Claude' },
    checks: [],
    receipts: [],
  });

  assert.deepEqual(
    filterTaskOverviewCards(cards, 'unicode').map((card) => card.path),
    ['/work/urgent'],
  );
  assert.deepEqual(
    filterTaskOverviewCards(cards, 'alpha').map((card) => card.path),
    ['/code/alpha', '/work/urgent', '/work/quiet'],
  );
  assert.deepEqual(
    filterTaskOverviewCards(cards, 'feat/urgent').map((card) => card.path),
    ['/work/urgent'],
  );
  assert.deepEqual(
    filterTaskOverviewCards(cards, 'claude').map((card) => card.path),
    ['/work/urgent'],
  );
  assert.deepEqual(filterTaskOverviewCards(cards, 'missing'), []);
});

void test('sorting supports attention, recent activity, repository, and pinned first', () => {
  const cards = buildTaskOverviewCards({
    catalog,
    threads: {
      '/code/alpha': [thread('/code/alpha', 'Done', 'codex', 100)],
      '/work/urgent': [thread('/work/urgent', 'Waiting', 'claude', 10)],
    },
    statuses: {
      '["codex","/code/alpha","Done-100"]': 'done',
      '["claude","/work/urgent","Waiting-10"]': 'waiting',
    },
    agentNames: { codex: 'Codex', claude: 'Claude' },
    checks: [],
    receipts: [],
  });

  assert.deepEqual(
    sortTaskOverviewCards(cards, 'attention', []).map((card) => card.path),
    ['/work/urgent', '/work/quiet', '/code/alpha'],
  );
  assert.deepEqual(
    sortTaskOverviewCards(cards, 'recent', []).map((card) => card.path),
    ['/code/alpha', '/work/urgent', '/work/quiet'],
  );
  assert.deepEqual(
    sortTaskOverviewCards(cards, 'repository', []).map((card) => card.branch),
    ['Default branch', 'feat/urgent', 'fix/quiet'],
  );
  assert.equal(sortTaskOverviewCards(cards, 'pinned', ['/code/alpha'])[0].path, '/code/alpha');
});

void test('preferences restore valid values and reject malformed state', () => {
  assert.deepEqual(
    loadTaskOverviewPreferences(
      JSON.stringify({ sort: 'pinned', pinned: ['/work/one', '/work/one'], selected: '/work/one' }),
    ),
    { sort: 'pinned', pinned: ['/work/one'], selected: '/work/one' },
  );
  assert.deepEqual(loadTaskOverviewPreferences('{'), {
    sort: 'attention',
    pinned: [],
    selected: null,
  });
});

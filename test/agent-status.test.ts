import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentHeaderStatus,
  statusBarAttentionCount,
  agentStatusCounts,
  buildAgentStatusItems,
  resetLabel,
  type AgentHeaderInput,
} from '../src/lib/agent-status.ts';

const threads = [
  { agent: 'claude', sessionId: 'working', directory: '/work/one', title: 'Build', updated: 2 },
  { agent: 'opencode', sessionId: 'waiting', directory: '/work/two', title: 'Review', updated: 3 },
  { agent: 'codex', sessionId: 'done', directory: '/work/three', title: 'Test', updated: 1 },
];
const keys = threads.map((thread) =>
  JSON.stringify([thread.agent, thread.directory, thread.sessionId]),
);

void test('status bar keeps active and unread agents in urgency order', () => {
  const items = buildAgentStatusItems({
    threads,
    statuses: { [keys[0]]: 'working', [keys[1]]: 'waiting', [keys[2]]: 'done' },
    attention: {
      [keys[0]]: { status: 'working', unread: false },
      [keys[1]]: { status: 'waiting', unread: true },
      [keys[2]]: { status: 'done', unread: true },
    },
    agentNames: { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex' },
    usage: { [keys[0]]: { context: 42 }, [keys[1]]: { context: 73 } },
    rates: { claude: [{ label: '5h', remaining: 18 }] },
  });

  assert.deepEqual(
    items.map(({ agent, status, context }) => ({ agent, status, context })),
    [
      { agent: 'opencode', status: 'waiting', context: 73 },
      { agent: 'claude', status: 'working', context: 42 },
      { agent: 'codex', status: 'done', context: undefined },
    ],
  );
  assert.deepEqual(agentStatusCounts(items), { working: 1, waiting: 1, ready: 1 });
});

void test('status bar drops read completed sessions and formats future resets', () => {
  const items = buildAgentStatusItems({
    threads: [threads[2]],
    statuses: { [keys[2]]: 'done' },
    attention: { [keys[2]]: { status: 'done', unread: false } },
    agentNames: {},
    usage: {},
    rates: {},
  });
  assert.deepEqual(items, []);
  assert.equal(resetLabel(1_700_000_000_000 + 90 * 60_000, 1_700_000_000_000), '1h 30m');
  assert.equal(resetLabel(1_700_000_000_000, 1_700_000_000_000), null);
});

const idleHeader: AgentHeaderInput = {
  connecting: false,
  ready: true,
  waiting: false,
  sending: false,
  hasSession: true,
  running: false,
  activityReady: true,
  historyLoading: false,
  busy: false,
};

void test('ACP thread headers report working only for turns the status bar can list', () => {
  const cases: [string, Partial<AgentHeaderInput>, string][] = [
    ['idle thread', {}, 'ready'],
    ['agent process connecting', { connecting: true, busy: true }, 'connecting'],
    ['agent offline', { ready: false }, 'offline'],
    ['permission pending', { waiting: true, running: true, busy: true }, 'waiting'],
    [
      'first prompt creating a session',
      { sending: true, hasSession: false, busy: true },
      'connecting',
    ],
    ['prompt sent in an existing session', { sending: true, busy: true }, 'working'],
    ['history replay only', { historyLoading: true, busy: true }, 'connecting'],
    [
      'history replay of a running turn',
      { historyLoading: true, running: true, busy: true },
      'working',
    ],
    [
      'recovered turn before activity check',
      { running: true, activityReady: false, busy: true },
      'connecting',
    ],
    [
      'prompt sent before activity check',
      { sending: true, activityReady: false, busy: true },
      'connecting',
    ],
    ['running turn after activity check', { running: true, busy: true }, 'working'],
    ['other live work keeps working', { busy: true }, 'working'],
  ];
  for (const [name, overrides, expected] of cases)
    assert.equal(agentHeaderStatus({ ...idleHeader, ...overrides }), expected, name);
});

void test('the status bar counts a waiting thread before its Inbox request arrives', () => {
  const waiting = { key: JSON.stringify(['claude', '/repo', 's1']), status: 'waiting' as const };
  const working = { key: JSON.stringify(['claude', '/repo', 's2']), status: 'working' as const };
  const listed = new Set([JSON.stringify(['/repo', 'claude', 's1'])]);
  assert.equal(statusBarAttentionCount(0, [waiting, working], new Set()), 1);
  assert.equal(statusBarAttentionCount(1, [waiting, working], listed), 1);
  assert.equal(statusBarAttentionCount(2, [working], new Set()), 2);
  assert.equal(statusBarAttentionCount(0, [{ key: 'bad', status: 'waiting' }], new Set()), 0);
});

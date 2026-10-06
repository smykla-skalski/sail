import assert from 'node:assert/strict';
import test from 'node:test';
import { agentStatusCounts, buildAgentStatusItems, resetLabel } from '../src/lib/agent-status.ts';

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
    usage: { [keys[0]]: { context: 42 } },
    openCodeUsage: { '/work/two:waiting': 73 },
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
    openCodeUsage: {},
    rates: {},
  });
  assert.deepEqual(items, []);
  assert.equal(resetLabel(1_700_000_000_000 + 90 * 60_000, 1_700_000_000_000), '1h 30m');
  assert.equal(resetLabel(1_700_000_000_000, 1_700_000_000_000), null);
});

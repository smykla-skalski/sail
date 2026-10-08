import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acpScopeKey,
  migrateOpenCodeSettings,
  openCodeMigrationKey,
  type SettingsPort,
} from '../src/lib/opencode-migration.ts';
import { acpThreadId, openCodeSessionId, sameThreadId } from '../src/lib/thread-id.ts';

function store(initial: Record<string, string>): SettingsPort & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  };
}

const dir = '/work/alpha';
const nativeThread = {
  agent: 'opencode',
  directory: dir,
  sessionId: 'ses_1',
  title: 'Fix',
  updated: 5,
};

function legacy(): Record<string, string> {
  const thread = `opencode:ses_1`;
  return {
    'sai-recent-native-threads': JSON.stringify([nativeThread]),
    'sail-agent-threads': JSON.stringify([
      { agent: 'claude', directory: dir, sessionId: 'c1', title: 'C', updated: 1 },
    ]),
    [`sai-session:${dir}`]: 'ses_1',
    'sai-pane-layouts': JSON.stringify({
      [dir]: {
        id: 'root',
        direction: 'row',
        ratio: 0.5,
        first: { id: 'main', agent: null, thread: null },
        second: { id: 'p2', agent: 'opencode', thread: { ...nativeThread, agent: undefined } },
      },
    }),
    'sai-agent-spawn-receipts': JSON.stringify([
      { receiptId: 'r1', sourceId: thread, targetId: 'opencode:ses_2', provider: 'opencode' },
      { receiptId: 'r2', sourceId: 'acp:claude:x', targetId: null, provider: 'claude' },
    ]),
    'sai-ship-runs': JSON.stringify([
      {
        id: 'run',
        issues: [
          {
            id: 'i',
            threadId: thread,
            checkpointThreadIds: [thread, 'acp:codex:z'],
            contextPercentByThread: { [thread]: 40 },
            contextCompactions: { opencode: 2 },
            contextHandoffs: [{ fromThreadId: thread, toThreadId: null }],
          },
        ],
      },
    ]),
    'sai-coordination-messages': JSON.stringify([
      { id: 'm', target: `${dir}\0${thread}`, sender: 's', text: 't', created: 1 },
    ]),
    'sai-post-turn-history': JSON.stringify([
      {
        id: JSON.stringify([dir, thread, 't1', 'repository', 'npm test']),
        directory: dir,
        thread,
        turn: 't1',
        source: 'repository',
        command: 'npm test',
      },
    ]),
    'sai-inbox-seen': JSON.stringify({ 'opencode:permission:p1': 1, 'opencode:form:f1': 2 }),
    'sai-inbox-outcomes': JSON.stringify([{ key: 'check:c', sessionId: 'ses_1' }]),
    'sai-worktree-agent': 'opencode',
  };
}

void test('rewrites only native opencode ids', () => {
  assert.equal(acpThreadId('opencode:ses_1'), 'acp:opencode:ses_1');
  assert.equal(acpThreadId('acp:opencode:ses_1'), 'acp:opencode:ses_1');
  assert.equal(acpThreadId('acp:claude:x'), 'acp:claude:x');
  assert.ok(sameThreadId('opencode:ses_1', 'acp:opencode:ses_1'));
  assert.ok(!sameThreadId('acp:claude:ses_1', 'acp:opencode:ses_1'));
  assert.ok(!sameThreadId(null, 'acp:opencode:ses_1'));
  assert.equal(acpScopeKey('/d\0main\0opencode:new'), '/d\0main\0acp:opencode:new');
});

void test('reads the OpenCode session from either thread id form', () => {
  const cases: [string | null, string | null][] = [
    ['opencode:ses_1', 'ses_1'],
    ['acp:opencode:ses_1', 'ses_1'],
    ['acp:claude:ses_1', null],
    ['acp:opencode:', null],
    ['opencode:', null],
    [null, null],
  ];
  for (const [value, expected] of cases) assert.equal(openCodeSessionId(value), expected, value);
});

void test('migrates every saved reference to the ACP form', () => {
  const port = store(legacy());
  assert.equal(migrateOpenCodeSettings(port), true);
  const threads = JSON.parse(port.get('sail-agent-threads')!);
  assert.deepEqual(
    threads.map((thread: { sessionId: string }) => thread.sessionId),
    ['c1', 'ses_1'],
  );
  assert.equal(port.get('sai-recent-native-threads'), null);
  assert.equal(port.get(`sai-session:${dir}`), null);
  const layout = JSON.parse(port.get('sai-pane-layouts')!)[dir];
  assert.equal(layout.first.agent, 'opencode');
  assert.equal(layout.first.thread.sessionId, 'ses_1');
  assert.equal(layout.second.thread.agent, 'opencode');
  const receipts = JSON.parse(port.get('sai-agent-spawn-receipts')!);
  assert.equal(receipts[0].sourceId, 'acp:opencode:ses_1');
  assert.equal(receipts[0].targetId, 'acp:opencode:ses_2');
  assert.equal(receipts[0].provider, 'opencode');
  assert.equal(receipts[1].sourceId, 'acp:claude:x');
  const issue = JSON.parse(port.get('sai-ship-runs')!)[0].issues[0];
  assert.equal(issue.threadId, 'acp:opencode:ses_1');
  assert.deepEqual(issue.checkpointThreadIds, ['acp:opencode:ses_1', 'acp:codex:z']);
  assert.deepEqual(issue.contextPercentByThread, { 'acp:opencode:ses_1': 40 });
  assert.deepEqual(issue.contextCompactions, { opencode: 2 });
  assert.equal(issue.contextHandoffs[0].fromThreadId, 'acp:opencode:ses_1');
  assert.equal(
    JSON.parse(port.get('sai-coordination-messages')!)[0].target,
    `${dir}\0acp:opencode:ses_1`,
  );
  const check = JSON.parse(port.get('sai-post-turn-history')!)[0];
  assert.equal(check.thread, 'acp:opencode:ses_1');
  assert.equal(
    check.id,
    JSON.stringify([dir, 'acp:opencode:ses_1', 't1', 'repository', 'npm test']),
  );
  assert.deepEqual(JSON.parse(port.get('sai-inbox-seen')!), {
    'opencode:permission:p1': 1,
    'opencode:form:f1': 2,
  });
  assert.equal(port.get('sai-worktree-agent'), 'opencode');
  assert.equal(port.get(openCodeMigrationKey), '1');
});

void test('is idempotent', () => {
  const port = store(legacy());
  migrateOpenCodeSettings(port);
  const first = new Map(port.data);
  assert.equal(migrateOpenCodeSettings(port), false);
  assert.deepEqual(port.data, first);
  port.remove(openCodeMigrationKey);
  migrateOpenCodeSettings(port);
  assert.deepEqual(port.data, first);
});

void test('merges native threads without duplicating or losing newer activity', () => {
  const port = store({
    'sai-recent-native-threads': JSON.stringify([nativeThread, { bad: true }]),
    'sail-agent-threads': JSON.stringify([{ ...nativeThread, title: 'Renamed', updated: 3 }]),
  });
  migrateOpenCodeSettings(port);
  assert.deepEqual(JSON.parse(port.get('sail-agent-threads')!), [
    { ...nativeThread, title: 'Renamed', updated: 5 },
  ]);
});

void test('keeps empty main pane and non-agent leaves', () => {
  const layout = {
    [dir]: { id: 'main', agent: null, thread: null },
    '/b': { id: 'main', agent: null, thread: null, kind: 'terminal' },
  };
  const port = store({
    'sai-pane-layouts': JSON.stringify(layout),
    [`sai-main-pane-empty:${dir}`]: 'true',
  });
  migrateOpenCodeSettings(port);
  const migrated = JSON.parse(port.get('sai-pane-layouts')!);
  assert.deepEqual(migrated[dir], layout[dir]);
  assert.deepEqual(migrated['/b'], layout['/b']);
});

void test('survives corrupt and partial data', () => {
  const port = store({
    'sai-pane-layouts': '{nope',
    'sai-agent-spawn-receipts': '"text"',
    'sai-ship-runs': JSON.stringify([null, { issues: 'x' }, { issues: [null, { threadId: 4 }] }]),
    'sai-coordination-messages': JSON.stringify([{ target: 4 }, 'x']),
    'sai-post-turn-history': JSON.stringify([{ thread: 'opencode:s' }]),
    'sai-recent-native-threads': 'not json',
  });
  assert.equal(migrateOpenCodeSettings(port), true);
  assert.equal(port.get('sai-pane-layouts'), '{nope');
  assert.equal(port.get('sai-agent-spawn-receipts'), '"text"');
  assert.equal(JSON.parse(port.get('sai-post-turn-history')!)[0].thread, 'acp:opencode:s');
  assert.equal(port.get(openCodeMigrationKey), '1');
});

void test('does not overwrite corrupt agent threads or drop native ones', () => {
  const port = store({
    'sail-agent-threads': '{broken',
    'sai-recent-native-threads': JSON.stringify([nativeThread]),
  });
  migrateOpenCodeSettings(port);
  assert.equal(port.get('sail-agent-threads'), '{broken');
  assert.ok(port.get('sai-recent-native-threads'));
});

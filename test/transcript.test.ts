import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentDisplayEntry } from '../src/lib/acp.ts';
import type { ActivityHistoryEvent } from '../src/lib/activity-history.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import {
  buildTranscript,
  checkItems,
  currentToolGroup,
  hookItems,
  nativeItems,
  pendingCoordinationItems,
  queuedItems,
  shellItems,
  subagentItems,
  type TranscriptItem,
  jumpLabel,
  latestRevision,
  decisionItems,
} from '../src/lib/transcript.ts';
import {
  acpPermissionChoices,
  acpPermissionDetails,
  mayAlwaysAllow,
} from '../src/lib/permission-card.ts';
import type { PermissionPolicyDecision } from '../src/lib/capability-profiles.ts';

const receipt = (over: Partial<SpawnReceipt> = {}): SpawnReceipt => ({
  receiptId: 'r1',
  accessKey: 'k',
  requestId: 'q',
  project: '/p',
  sourceId: 'acp:claude:s',
  sourceDirectory: '/p',
  targetId: null,
  turnId: null,
  targetDirectory: null,
  worktreeId: null,
  provider: 'claude',
  prompt: null,
  state: 'working',
  created: 250,
  updated: 250,
  result: null,
  error: null,
  ...over,
});

const entries: AgentDisplayEntry[] = [
  { id: 'u1', type: 'user', text: 'hi', created: 100 },
  { id: 't1', type: 'thought', text: 'hmm', created: 150 },
  {
    id: 'tool-group:a',
    type: 'tool-group',
    created: 200,
    tools: [
      { id: 'a', type: 'tool', title: 'Read', status: 'completed', content: 'ok', terminalIds: [] },
    ],
  },
  { id: 'a1', type: 'assistant', text: 'done', created: 400 },
];
const host = {
  name: 'Claude',
  provider: 'claude',
  toolOutput: (tool: { content: string }) => tool.content,
};

await test('native entries keep one entry per type with the right role and author', () => {
  const items = nativeItems(entries, [], host);
  assert.deepEqual(
    items.map((item) => [
      item.kind,
      item.kind === 'message' ? `${item.role}:${item.author}` : item.id,
    ]),
    [
      ['message', 'user:You'],
      ['message', 'thought:Claude · thinking'],
      ['tools', 'tool-group:a'],
      ['message', 'assistant:Claude'],
    ],
  );
});

const check = (id: string, updated: number) => ({
  id,
  updated,
  directory: '/p',
  thread: 't',
  turn: 'turn1',
  source: 'repository' as const,
  command: id,
  status: 'passed' as const,
  output: '',
  code: 0,
});

await test('hooks, checks and subagents render in event order, one card per turn', () => {
  const base = nativeItems(entries, [], host);
  const hook = {
    id: 'h1',
    provider: 'claude',
    sessionId: 's',
    event: 'PreToolUse',
    source: 'x',
    outcome: 'blocked' as const,
    created: 180,
    diagnostics: null,
  };
  const items = buildTranscript({
    base,
    timed: [
      ...subagentItems([receipt({ created: 300 }), receipt({ receiptId: 'r2', created: 320 })]),
      ...checkItems([check('c1', 350), check('c2', 360)]),
      ...hookItems([hook]),
    ],
  });
  assert.deepEqual(
    items.map((item) => item.id),
    ['u1', 't1', 'hook:h1', 'tool-group:a', 'subagents', 'checks:turn1', 'a1'],
  );
  assert.equal(items.filter((item) => item.kind === 'subagents').length, 1);
  assert.equal(items.filter((item) => item.kind === 'checks').length, 1);
});

await test('untimed base items inherit the time before them and extras without a slot go last', () => {
  const base = nativeItems(
    [
      { id: 'a', type: 'user', text: 'a', created: 100 },
      { id: 'b', type: 'assistant', text: 'b' },
      { id: 'c', type: 'assistant', text: 'c', created: 500 },
    ],
    [],
    host,
  );
  const items = buildTranscript({
    base,
    timed: [
      ...subagentItems([receipt({ created: 300 })]),
      ...hookItems([
        {
          id: 'late',
          provider: 'claude',
          sessionId: 's',
          event: 'Stop',
          source: 'x',
          outcome: 'observed',
          created: 900,
          diagnostics: null,
        },
      ]),
    ],
  });
  assert.deepEqual(
    items.map((item) => item.id),
    ['a', 'b', 'subagents', 'c', 'hook:late'],
  );
});

await test('a settled-only subagent group trails and pending coordination keeps its queued label', () => {
  const items = buildTranscript({
    base: nativeItems(entries, [], host),
    timed: subagentItems([receipt({ state: 'completed', created: 120, updated: 130 })]),
    trailing: pendingCoordinationItems(
      [{ id: 'c', target: 't', sender: 'Ship', text: 'ping', created: 1 }],
      'claude',
    ),
  });
  assert.deepEqual(items.map((item) => item.id).slice(-3), ['a1', 'subagents', 'coordination:c']);
  const last = items.at(-1);
  assert.equal(last?.kind === 'message' && last.author, 'From Ship · queued');
});

await test('settled children interleave as spawn responses', () => {
  const items = nativeItems(entries, [receipt({ state: 'completed', updated: 300 })], host);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['message', 'message', 'tools', 'spawn-response', 'message'],
  );
});

await test('pending shell runs and queued messages trail the transcript', () => {
  const items = buildTranscript({
    base: nativeItems(entries, [], host),
    timed: shellItems([
      {
        id: 's',
        command: 'ls',
        status: 'running',
        code: null,
        output: '',
        directory: '/p',
        session: null,
        created: 220,
      },
    ]),
    trailing: queuedItems([{ author: 'You · queued', text: 'later' }], 'claude'),
  });
  assert.deepEqual(
    items.map((item) => item.id),
    ['u1', 't1', 'tool-group:a', 'shell:s', 'a1', 'queued:0'],
  );
});

await test('the latest action row follows the last conversation item or a running tool', () => {
  const items: TranscriptItem[] = nativeItems(entries.slice(0, 3), [], host);
  const group = items[2];
  assert.ok(group.kind === 'tools');
  assert.equal(currentToolGroup(group, items, true), true);
  assert.equal(currentToolGroup(group, items, false), false);
  assert.equal(
    currentToolGroup(group, [...items, ...nativeItems([entries[3]], [], host)], true),
    false,
  );
});

const policy = (
  risk: PermissionPolicyDecision['risk'],
  recommendation: PermissionPolicyDecision['recommendation'] = 'interactive',
): PermissionPolicyDecision => ({
  profile: 'build',
  risk,
  recommendation,
  reason: 'r',
  policyRevision: '1',
});
const options = [
  { optionId: 'o', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'a', name: 'Always', kind: 'allow_always' },
  { optionId: 'r', name: 'Reject', kind: 'reject_once' },
];

await test('Always is offered only for low and medium risk actions', () => {
  for (const risk of ['low', 'medium'] as const) {
    assert.equal(mayAlwaysAllow(policy(risk)), true);
    assert.deepEqual(
      acpPermissionChoices(options, policy(risk)).map((c) => c.id),
      ['o', 'a', 'r'],
    );
  }
  for (const risk of ['unknown', 'high'] as const) {
    assert.equal(mayAlwaysAllow(policy(risk)), false);
    assert.deepEqual(
      acpPermissionChoices(options, policy(risk)).map((c) => c.id),
      ['o', 'r'],
    );
  }
  assert.deepEqual(
    acpPermissionChoices(options, undefined).map((c) => c.id),
    ['o', 'r'],
  );
  assert.deepEqual(
    acpPermissionChoices(options, policy('low', 'deny')).map((c) => c.id),
    ['r'],
  );
});

await test('permission details show the exact command, files and tool call', () => {
  assert.deepEqual(
    acpPermissionDetails({
      toolCallId: 'tc',
      rawInput: { command: 'git status' },
      locations: [{ path: '/p/a.ts' }],
    }),
    { toolCallId: 'tc', command: 'git status', files: ['/p/a.ts'] },
  );
});

const growing = (text: string): TranscriptItem => ({
  kind: 'message',
  id: 'm1',
  role: 'assistant',
  author: 'Claude',
  text,
  provider: 'claude',
});

const running = (status: string, output: string): TranscriptItem => ({
  kind: 'tools',
  id: 't1',
  tools: [{ id: 'a', title: 'Run', status, output, error: '', source: 'claude', terminalIds: [] }],
});

void test('Jump to latest tells streaming growth apart from new items', () => {
  assert.equal(latestRevision([]), '');
  assert.notEqual(latestRevision([growing('Hel')]), latestRevision([growing('Hello')]));
  assert.notEqual(
    latestRevision([running('in_progress', '')]),
    latestRevision([running('in_progress', 'line')]),
  );
  assert.equal(
    latestRevision([running('in_progress', 'x')]),
    latestRevision([running('completed', 'x')]),
  );
  const note: TranscriptItem = {
    kind: 'decision',
    id: 'd1',
    created: 5,
    title: 'Format',
    outcome: 'allowed',
    reason: '',
  };
  assert.notEqual(latestRevision([growing('Hel'), note]), latestRevision([growing('Hello'), note]));
  assert.equal(latestRevision([growing('same')]), latestRevision([growing('same')]));
  assert.equal(jumpLabel(0, false), 'Jump to latest');
  assert.equal(jumpLabel(0, true), 'Jump to latest (new output)');
  assert.equal(jumpLabel(2, true), 'Jump to latest (2 new)');
});

void test('automatic permission decisions of one session become transcript notes', () => {
  const base = { workspace: '/repo', source: 'claude', sourceId: 's', title: 'Read .env' };
  const events: ActivityHistoryEvent[] = [
    {
      ...base,
      id: 'b',
      kind: 'decision',
      outcome: 'rejected',
      at: 20,
      agent: 'claude',
      sessionId: 'one',
      automatic: true,
      reason: 'Secrets stay private.',
    },
    {
      ...base,
      id: 'a',
      kind: 'decision',
      outcome: 'completed',
      at: 10,
      agent: 'claude',
      sessionId: 'one',
      automatic: true,
      reason: 'Read-only access.',
    },
    {
      ...base,
      id: 'c',
      kind: 'decision',
      outcome: 'completed',
      at: 30,
      agent: 'claude',
      sessionId: 'one',
    },
    {
      ...base,
      id: 'd',
      kind: 'decision',
      outcome: 'completed',
      at: 40,
      agent: 'claude',
      sessionId: 'two',
      automatic: true,
    },
    {
      ...base,
      id: 'e',
      kind: 'tool',
      outcome: 'completed',
      at: 50,
      agent: 'claude',
      sessionId: 'one',
      automatic: true,
    },
  ];
  const quoted = decisionItems(
    [
      {
        ...events[1],
        title: 'build · medium risk — Allowed by policy: Read-only access. — Read .env',
      },
    ],
    { agent: 'claude', directory: '/repo', sessionId: 'one' },
  );
  assert.equal(quoted[0].kind === 'decision' && quoted[0].reason, '');
  assert.deepEqual(
    decisionItems(events, { agent: 'claude', directory: '/repo', sessionId: 'one' }).map((item) =>
      item.kind === 'decision' ? [item.id, item.outcome, item.reason, item.created] : item.kind,
    ),
    [
      ['decision:a', 'allowed', 'Read-only access.', 10],
      ['decision:b', 'rejected', 'Secrets stay private.', 20],
    ],
  );
});

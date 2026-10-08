import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionMessageInfo } from '@opencode/client';
import type { AgentDisplayEntry } from '../src/lib/acp.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import {
  buildTranscript,
  checkItems,
  currentToolGroup,
  hookItems,
  nativeItems,
  pendingCoordinationItems,
  openCodeItems,
  queuedItems,
  shellItems,
  streamingItems,
  subagentItems,
  type TranscriptItem,
} from '../src/lib/transcript.ts';
import {
  acpPermissionChoices,
  acpPermissionDetails,
  mayAlwaysAllow,
  openCodePermissionChoices,
  openCodePermissionDetails,
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

type Assistant = Extract<SessionMessageInfo, { type: 'assistant' }>;
const assistant = (
  content: Assistant['content'],
  extra: Partial<Assistant> = {},
): SessionMessageInfo => ({
  id: 'm2',
  type: 'assistant',
  agent: 'build',
  model: { id: 'm', providerID: 'p' },
  time: { created: 200 },
  content,
  ...extra,
});
const tool = (id: string, failed: boolean): Assistant['content'][number] => ({
  type: 'tool',
  id,
  name: 'bash',
  time: { created: 200 },
  state: failed
    ? {
        status: 'error',
        error: { type: 'tool', message: 'bad' },
        input: { command: 'ls' },
        content: [{ type: 'text', text: 'out' }],
      }
    : {
        status: 'completed',
        input: { command: 'ls' },
        content: [{ type: 'text', text: 'out' }],
      },
});

await test('OpenCode messages group consecutive tools and keep text, thinking and tools in order', () => {
  const items = openCodeItems(
    [
      {
        id: 'm1',
        type: 'user',
        time: { created: 100 },
        text: 'go',
        files: [
          {
            name: 'a.txt',
            data: '',
            mime: 'text/plain',
            source: { type: 'uri', uri: 'file:///a' },
          },
        ],
      },
      { id: 'idle', type: 'idle', outcome: 'succeeded', time: { created: 120 } },
      assistant([
        { type: 'reasoning', text: 'plan' },
        { type: 'text', text: 'first' },
        tool('t1', false),
        tool('t2', true),
        { type: 'text', text: 'second' },
      ]),
    ],
    [],
    { liveText: { m2: { 1: 'live first' } } },
  );
  assert.deepEqual(
    items.map((item) => [
      item.kind,
      item.kind === 'message' ? item.role : '',
      item.kind === 'message' ? item.text : '',
    ]),
    [
      ['message', 'user', 'go'],
      ['message', 'thought', 'plan'],
      ['message', 'assistant', 'live first'],
      ['tools', '', ''],
      ['message', 'assistant', 'second'],
    ],
  );
  const group = items[3];
  assert.equal(group.kind === 'tools' && group.tools.length, 2);
  assert.deepEqual(items[0].kind === 'message' && items[0].files, ['a.txt']);
  assert.equal(group.kind === 'tools' && group.tools[0].id, 'm2:t1');
});

await test('OpenCode retry and error render as a status message and streaming text is labelled', () => {
  const items = openCodeItems(
    [
      assistant([], {
        retry: { attempt: 2, at: 1, error: { type: 'x', message: 'slow' } },
        error: { type: 'x', message: 'boom' },
      }),
    ],
    [],
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].kind === 'message' && [items[0].retry, items[0].error], [
    'Retry 2: slow',
    'boom',
  ]);
  const live = streamingItems([['x', { 1: 'b', 0: 'a' }]], 'build');
  assert.equal(live[0].kind === 'message' && live[0].text, 'a\nb');
  assert.equal(live[0].kind === 'message' && live[0].author, 'build · streaming');
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
    assert.ok(openCodePermissionChoices(policy(risk)).some((c) => c.always));
  }
  for (const risk of ['unknown', 'high'] as const) {
    assert.equal(mayAlwaysAllow(policy(risk)), false);
    assert.deepEqual(
      acpPermissionChoices(options, policy(risk)).map((c) => c.id),
      ['o', 'r'],
    );
    assert.deepEqual(
      openCodePermissionChoices(policy(risk)).map((c) => c.id),
      ['once', 'reject'],
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
  assert.deepEqual(
    openCodePermissionChoices(policy('medium', 'deny')).map((c) => c.id),
    ['reject'],
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
  assert.deepEqual(
    openCodePermissionDetails({
      action: 'bash',
      resources: ['rm -rf x', 'x'],
      source: { type: 'tool', messageID: 'm', id: 'p' },
    }),
    { toolCallId: 'm:p', command: 'rm -rf x', files: ['x'] },
  );
  assert.deepEqual(openCodePermissionDetails({ action: 'edit', resources: ['/p/a.ts'] }), {
    toolCallId: null,
    command: null,
    files: ['/p/a.ts'],
  });
});

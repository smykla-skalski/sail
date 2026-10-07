import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bufferBackgroundUpdate,
  forgetRecentTranscript,
  groupAgentEntries,
  invalidateBackgroundSession,
  liveSessionView,
  loadRecentTranscript,
  rememberSessionState,
  restoreEntryTimes,
  saveRecentTranscript,
  sessionState,
  takeBackgroundUpdates,
  trackBackgroundSession,
  updateEntries,
  updateEntriesBatch,
  updateEntriesInPlace,
  type AgentEntry,
  type AgentThread,
} from '../src/lib/acp.ts';
import { toolCommand } from '../src/lib/tool-display.ts';

const normalizeEntries = (entries: AgentEntry[]) =>
  entries.map((entry) => (entry.type === 'tool' ? entry : { ...entry, id: entry.type }));

void test('ACP chunks stream into one assistant message and tool updates keep their place', () => {
  const first = updateEntries([], {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello' },
  });
  const second = updateEntries(first, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' world' },
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].type === 'assistant' && second[0].text, 'Hello world');

  const withTool = updateEntries(second, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tool-1',
    title: 'Read file',
    status: 'pending',
  });
  const completed = updateEntries(withTool, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Done' } }],
  });
  assert.equal(completed.length, 2);
  assert.deepEqual(completed[1], {
    id: 'tool-1',
    type: 'tool',
    title: 'Read file',
    status: 'completed',
    content: 'Done',
    terminalIds: [],
  });
});

void test('ACP tool calls keep terminal references across updates', () => {
  const created = updateEntries([], {
    sessionUpdate: 'tool_call',
    toolCallId: 'run',
    title: 'Run tests',
    content: [{ type: 'terminal', terminalId: 'terminal-1' }],
  });
  const completed = updateEntries(created, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'run',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Finished' } }],
  });
  assert.deepEqual(completed[0]?.type === 'tool' && completed[0].terminalIds, ['terminal-1']);
});

void test('ACP tool calls keep structured command input across updates', () => {
  const started = updateEntries([], {
    sessionUpdate: 'tool_call',
    toolCallId: 'bash-1',
    title: 'Run checks',
    rawInput: { command: 'npm test', timeout: 120000 },
  });
  const completed = updateEntries(started, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-1',
    status: 'completed',
  });
  assert.deepEqual(completed[0]?.type === 'tool' && completed[0].input, {
    command: 'npm test',
    timeout: 120000,
  });
  const cleared = updateEntries(completed, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-1',
    rawInput: null,
  });
  assert.equal(cleared[0]?.type === 'tool' && cleared[0].input, null);
});

void test('ACP tool calls keep raw output across updates', () => {
  const started = updateEntries([], {
    sessionUpdate: 'tool_call',
    toolCallId: 'bash-2',
    title: 'Run checks',
    rawOutput: { stdout: 'All checks passed.' },
  });
  const completed = updateEntries(started, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-2',
    status: 'completed',
  });
  assert.deepEqual(completed[0]?.type === 'tool' && completed[0].output, {
    stdout: 'All checks passed.',
  });
  const cleared = updateEntries(completed, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-2',
    rawOutput: null,
  });
  assert.equal(cleared[0]?.type === 'tool' && cleared[0].output, null);
});

void test('batched and replayed ACP updates preserve transcript order and content', () => {
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Plan' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'check.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', status: 'pending' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Found file' } }],
    },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
    { sessionUpdate: 'unknown' },
  ];
  const seed = updateEntries([], updates[0]);
  const snapshot = structuredClone(seed);
  const expected = updates.slice(1).reduce(updateEntries, seed);
  const batched = updateEntriesBatch(seed, updates.slice(1));
  const splitBatches = updateEntriesBatch(
    updateEntriesBatch(seed, updates.slice(1, 4)),
    updates.slice(4),
  );
  const replayed = structuredClone(seed);
  for (const update of updates.slice(1)) updateEntriesInPlace(replayed, update);
  assert.deepEqual(normalizeEntries(batched), normalizeEntries(expected));
  assert.deepEqual(normalizeEntries(splitBatches), normalizeEntries(expected));
  assert.deepEqual(normalizeEntries(replayed), normalizeEntries(expected));
  assert.deepEqual(seed, snapshot);
  assert.equal(updateEntriesBatch(seed, [{ sessionUpdate: 'unknown' }]), seed);
  assert.equal(updateEntriesBatch([], updates, 1234)[0]?.created, 1234);
});

void test('history replay keeps recent message times for subagent order', () => {
  const history: AgentEntry[] = [
    { id: 'replay-old', type: 'user', text: 'Old' },
    { id: 'replay-reply', type: 'assistant', text: 'Child done' },
    { id: 'replay-next', type: 'user', text: 'Next task' },
  ];
  const recent: AgentEntry[] = [
    { id: 'cached-reply', type: 'assistant', text: 'Child done', created: 10 },
    { id: 'cached-next', type: 'user', text: 'Next task', created: 30 },
  ];
  assert.deepEqual(
    restoreEntryTimes(history, recent).map((entry) => entry.created),
    [undefined, 10, 30],
  );
});

void test('recent transcript cache keeps the latest entries within a size budget', () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
  try {
    const thread: AgentThread = {
      agent: 'codex',
      directory: '/repo',
      sessionId: 'old',
      title: 'Old',
      updated: 0,
    };
    const entries = Array.from({ length: 60 }, (_, index) => ({
      id: String(index),
      type: 'assistant' as const,
      text: String(index).padEnd(100, 'x'),
    }));
    saveRecentTranscript(thread, entries);
    const saved = loadRecentTranscript(thread);
    assert.equal(saved.length, 50);
    assert.equal(saved[0]?.id, '10');
    assert.equal(saved.at(-1)?.id, '59');

    saveRecentTranscript(thread, [{ id: 'large', type: 'assistant', text: 'x'.repeat(500_000) }]);
    assert.ok((values.get('sai-agent-transcript-cache')?.length ?? 0) < 130_000);
    assert.equal(loadRecentTranscript(thread).at(-1)?.id, 'large');
    saveRecentTranscript(thread, [
      { id: 'x'.repeat(200_000), type: 'assistant', text: 'oversized' },
      { id: 'small', type: 'assistant', text: 'kept' },
    ]);
    assert.deepEqual(
      loadRecentTranscript(thread).map((entry) => entry.id),
      ['small'],
    );
    assert.ok((values.get('sai-agent-transcript-cache')?.length ?? 0) <= 128 * 1024);
    saveRecentTranscript(thread, [
      {
        id: 'large-input',
        type: 'tool',
        title: 'Run command',
        status: 'completed',
        content: 'Done',
        input: { command: 'x'.repeat(130_000) },
        output: { stdout: 'y'.repeat(130_000) },
        terminalIds: [],
      },
    ]);
    const cachedTool = loadRecentTranscript(thread)[0];
    assert.equal(cachedTool?.id, 'large-input');
    assert.equal(cachedTool?.type === 'tool' && cachedTool.content, 'Done');
    assert.equal(cachedTool?.type === 'tool' && toolCommand(cachedTool.input)?.length, 1024);
    assert.equal(
      cachedTool?.type === 'tool' && cachedTool.output,
      'Output omitted from transcript cache (too large)',
    );
    saveRecentTranscript(thread, [
      {
        id: 'tool',
        type: 'tool',
        title: 'x'.repeat(200_000),
        status: 'completed',
        content: '',
        terminalIds: [],
      },
    ]);
    assert.deepEqual(loadRecentTranscript(thread), []);
    assert.ok((values.get('sai-agent-transcript-cache')?.length ?? 0) <= 128 * 1024);
    saveRecentTranscript(thread, [
      {
        id: 'unicode',
        type: 'tool',
        title: '😀'.repeat(40_000),
        status: 'completed',
        content: '',
        terminalIds: [],
      },
      { id: 'after', type: 'assistant', text: 'kept' },
    ]);
    assert.deepEqual(
      loadRecentTranscript(thread).map((entry) => entry.id),
      ['after'],
    );
    assert.ok(
      new TextEncoder().encode(values.get('sai-agent-transcript-cache') ?? '').length <= 128 * 1024,
    );
    forgetRecentTranscript(thread);
    assert.deepEqual(loadRecentTranscript(thread), []);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

void test('consecutive ACP tools form a stable group between visible messages', () => {
  const entries: AgentEntry[] = [
    { id: 'message-1', type: 'assistant', text: 'Checking files.' },
    {
      id: 'read',
      type: 'tool',
      title: 'Read files',
      status: 'completed',
      content: '',
      terminalIds: [],
    },
    {
      id: 'test',
      type: 'tool',
      title: 'Run tests',
      status: 'in_progress',
      content: '',
      terminalIds: [],
    },
    { id: 'message-2', type: 'assistant', text: 'I found the issue.' },
  ];
  const grouped = groupAgentEntries(entries);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped[0], entries[0]);
  assert.deepEqual(grouped[1], {
    id: 'tool-group:read',
    type: 'tool-group',
    tools: [entries[1], entries[2]],
  });
  assert.deepEqual(grouped[2], entries[3]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['message-1', 'read', 'test', 'message-2'],
  );
});

void test('switching back to a running session rebuilds it from the buffered updates', () => {
  const cached: AgentEntry[] = [{ id: 'a', type: 'assistant', text: 'Working on' }];
  trackBackgroundSession('claude', 'live');
  bufferBackgroundUpdate('claude', 'live', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' it' },
  });
  bufferBackgroundUpdate('claude', 'live', {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'echo of the prompt' },
  });
  bufferBackgroundUpdate('claude', 'live', {
    sessionUpdate: 'tool_call',
    toolCallId: 'read',
    title: 'Read file',
    status: 'in_progress',
  });
  bufferBackgroundUpdate('claude', 'untracked', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'ignored' },
  });
  const configOptions = [
    {
      id: 'model',
      name: 'Model',
      type: 'select' as const,
      currentValue: 'opus',
      options: [{ value: 'opus', name: 'Opus' }],
    },
  ];
  rememberSessionState('claude', 'live', { configOptions });
  const view = liveSessionView(
    cached,
    takeBackgroundUpdates('claude', 'live'),
    sessionState('claude', 'live'),
    5,
  );
  assert.ok(view);
  assert.deepEqual(
    view.entries.map((entry) => (entry.type === 'tool' ? entry.title : entry.text)),
    ['Working on it', 'Read file'],
  );
  assert.equal(view.configOptions, configOptions);
  assert.equal(takeBackgroundUpdates('claude', 'live'), null);
  assert.equal(takeBackgroundUpdates('claude', 'untracked'), null);
});

void test('a running session without a complete buffer keeps its cached transcript', () => {
  const cached: AgentEntry[] = [{ id: 'a', type: 'assistant', text: 'Cached' }];
  rememberSessionState('claude', 'busy', { configOptions: [] });
  trackBackgroundSession('claude', 'busy');
  for (let index = 0; index <= 2000; index += 1)
    bufferBackgroundUpdate('claude', 'busy', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '.' },
    });
  const overflowed = takeBackgroundUpdates('claude', 'busy');
  assert.equal(overflowed, null);
  assert.equal(
    liveSessionView(cached, overflowed, sessionState('claude', 'busy'))?.entries,
    cached,
  );
  trackBackgroundSession('claude', 'replayed');
  invalidateBackgroundSession('claude', 'replayed');
  assert.equal(takeBackgroundUpdates('claude', 'replayed'), null);
  trackBackgroundSession('claude', 'unknown-state');
  assert.equal(
    liveSessionView(
      [],
      takeBackgroundUpdates('claude', 'unknown-state'),
      sessionState('claude', 'unknown-state'),
    ),
    null,
  );
});

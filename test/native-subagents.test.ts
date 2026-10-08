import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from '../src/lib/acp.ts';
import {
  disconnectNativeSubagents,
  finalizeNativeSubagentRestore,
  nativeSubagentCounts,
  nativeSubagentReceipts,
  reconcileNativeSubagents,
  setNativeSubagentWaiting,
  updateNativeSubagents,
} from '../src/lib/native-subagents.ts';

await test('backend snapshot exposes a child before its queued frontend event runs', () => {
  const store = reconcileNativeSubagents(
    {},
    [
      {
        agent: 'codex',
        sessionId: 'late-child',
        parentSessionId: 'owner',
        directory: '/worktree',
        outcome: 'working',
      },
    ],
    10,
  );

  const receipts = nativeSubagentReceipts(store);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].sourceId, 'acp:codex:owner');
  assert.equal(receipts[0].targetId, 'acp:codex:late-child');
  assert.equal(receipts[0].state, 'working');
});

function event(sessionId: string, update: Record<string, unknown>): AgentEvent {
  return {
    agent: 'codex',
    message: { method: 'session/update', params: { sessionId, update } },
  };
}

await test('native lifecycle keeps nested sessions and transcripts distinct', () => {
  let store = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'child',
      name: 'explore',
      task: 'Map the code',
      prompt: 'Inspect files',
      capabilities: {},
    }),
    '/repo',
    1,
  );
  store = updateNativeSubagents(
    store,
    event('child', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'grandchild',
      name: 'reader',
      task: 'Read tests',
      capabilities: {},
    }),
    '/repo',
    2,
  );
  store = updateNativeSubagents(
    store,
    event('child', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Child output' },
    }),
    '/repo',
    3,
  );

  assert.equal(store['codex:child'].rootSessionId, 'parent');
  assert.equal(store['codex:grandchild'].parentSessionId, 'child');
  assert.equal(store['codex:grandchild'].rootSessionId, 'parent');
  assert.equal(store['codex:child'].transcript.at(-1)?.type, 'assistant');
  assert.equal(store['codex:grandchild'].transcript.length, 0);
  assert.equal(nativeSubagentReceipts(store)[0].result, null);
  assert.deepEqual(nativeSubagentCounts(store, 'codex', 'parent'), { active: 1, waiting: 0 });
});

await test('replayed lifecycle deduplicates and unfinished history disconnects', () => {
  const spawn = event('parent', {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'child',
    name: 'worker',
    task: 'Task',
    capabilities: {},
  });
  let store = updateNativeSubagents({}, spawn, '/repo', 1, true);
  store = updateNativeSubagents(store, spawn, '/repo', 2, true);
  assert.equal(Object.keys(store).length, 1);
  assert.equal(store['codex:child'].created, 1);

  store = finalizeNativeSubagentRestore(store, 'codex', 'parent', 3);
  assert.equal(store['codex:child'].outcome, 'unknown');
  assert.equal(nativeSubagentReceipts(store)[0].state, 'unavailable');
});

await test('terminal outcomes stay distinct and disconnect only affects live children', () => {
  let store = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'done',
      name: 'worker',
      task: 'Task',
      capabilities: {},
    }),
    '/repo',
    1,
  );
  store = updateNativeSubagents(
    store,
    event('parent', {
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'done',
      state: 'cancelled',
    }),
    '/repo',
    2,
  );
  store = updateNativeSubagents(
    store,
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'live',
      name: 'worker',
      task: 'Task',
      capabilities: {},
    }),
    '/repo',
    3,
  );
  store = disconnectNativeSubagents(store, 'codex', 4);
  assert.equal(store['codex:done'].outcome, 'interrupted');
  assert.equal(store['codex:live'].outcome, 'unknown');
});

await test('late and duplicate events cannot revive a terminal child', () => {
  const spawn = event('parent', {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'done',
    name: 'worker',
    task: 'Task',
    capabilities: {},
  });
  let store = updateNativeSubagents({}, spawn, '/repo', 1);
  store = updateNativeSubagents(
    store,
    event('parent', {
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'done',
      state: 'completed',
    }),
    '/repo',
    2,
  );
  store = updateNativeSubagents(
    store,
    event('done', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Late output' },
    }),
    '/repo',
    3,
  );
  store = updateNativeSubagents(store, spawn, '/repo', 4);

  assert.equal(store['codex:done'].outcome, 'completed');
  assert.equal(store['codex:done'].transcript.at(-1)?.text, 'Late output');
  assert.equal(nativeSubagentReceipts(store)[0].result, 'Completed');
});

await test('native child completion reflects its final interruption message', () => {
  let store = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'child',
      name: 'worker',
      task: 'Task',
      capabilities: {},
    }),
    '/repo',
    1,
  );
  store = updateNativeSubagents(
    store,
    event('parent', {
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'child',
      state: 'completed',
    }),
    '/repo',
    2,
  );
  for (const update of [
    { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', status: 'in_progress' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Step inter' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'rupted' } },
  ])
    store = updateNativeSubagents(store, event('child', update), '/repo', 3);
  assert.equal(nativeSubagentReceipts(store)[0].state, 'interrupted');
  assert.equal(nativeSubagentReceipts(store)[0].result, 'Interrupted');
  store = updateNativeSubagents(
    store,
    event('child', {
      sessionUpdate: 'tool_call',
      toolCallId: 'next',
      title: 'Continue',
      status: 'completed',
    }),
    '/repo',
    4,
  );
  assert.equal(nativeSubagentReceipts(store)[0].state, 'completed');
});

await test('resolved child permission clears its waiting activity', () => {
  let store = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'child',
      name: 'worker',
      task: 'Task',
      capabilities: {},
    }),
    '/repo',
    1,
  );
  store = setNativeSubagentWaiting(store, 'codex', 'child', true, 2);
  assert.equal(store['codex:child'].activity, 'Needs permission');
  store = setNativeSubagentWaiting(store, 'codex', 'child', false, 3);
  assert.equal(store['codex:child'].outcome, 'working');
  assert.equal(store['codex:child'].activity, 'Working…');
});

await test('malformed and self-referential lifecycle events leave parents intact', () => {
  const store = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'parent',
      name: 42,
    }),
    '/repo',
  );
  assert.deepEqual(store, {});

  const restored = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'broken-child',
      name: 42,
      capabilities: {},
    }),
    '/repo',
    1,
    true,
  );
  assert.equal(restored['codex:broken-child'].error, 'Incomplete subagent history');
});

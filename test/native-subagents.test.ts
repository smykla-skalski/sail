import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from '../src/lib/acp.ts';
import { automaticPermissionPolicy } from '../src/lib/capability-profiles.ts';
import {
  disconnectNativeSubagents,
  finalizeNativeSubagentRestore,
  nativeMessageLimit,
  nativeSubagentCounts,
  nativeSubagentReceipts,
  nativeSubagentThreads,
  nativeTranscriptLimit,
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
        capabilityProfile: 'review',
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
  assert.equal(store['codex:late-child'].capabilityProfile, 'review');
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
    false,
    'review',
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
    false,
    'build',
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
  assert.equal(store['codex:child'].capabilityProfile, 'review');
  assert.equal(store['codex:grandchild'].capabilityProfile, 'review');
  assert.equal(
    nativeSubagentThreads(store).find((thread) => thread.sessionId === 'grandchild')
      ?.capabilityProfile,
    'review',
  );
  assert.equal(store['codex:child'].transcript.at(-1)?.type, 'assistant');
  assert.equal(store['codex:grandchild'].transcript.length, 0);
  assert.equal(nativeSubagentReceipts(store)[0].result, null);
  assert.deepEqual(nativeSubagentCounts(store, 'codex', 'parent'), { active: 1, waiting: 0 });
});

await test('a long-running child keeps its prompt and the newest bounded transcript', () => {
  let store = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'child',
      name: 'worker',
      task: 'Task',
      prompt: 'Start here',
      capabilities: {},
    }),
    '/repo',
    1,
  );
  const steps = nativeTranscriptLimit + 20;
  for (let index = 0; index < steps; index++)
    store = updateNativeSubagents(
      store,
      event('child', {
        sessionUpdate: 'tool_call',
        toolCallId: `tool-${index}`,
        title: `Step ${index}`,
        status: 'completed',
      }),
      '/repo',
      index + 2,
    );
  for (const text of ['x'.repeat(nativeMessageLimit), 'y'.repeat(10), 'END'])
    store = updateNativeSubagents(
      store,
      event('child', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
      '/repo',
      steps + 2,
    );

  const transcript = store['codex:child'].transcript;
  assert.equal(transcript.length, nativeTranscriptLimit);
  assert.deepEqual(transcript[0], {
    id: 'codex:child:prompt',
    type: 'user',
    text: 'Start here',
    created: 1,
  });
  assert.equal(transcript[1].id, `tool-${steps - nativeTranscriptLimit + 2}`);
  const last = transcript.at(-1);
  assert.ok(last?.type === 'assistant');
  assert.equal(last.text.length, nativeMessageLimit);
  assert.ok(last.text.startsWith('…x'));
  assert.ok(last.text.endsWith(`${'y'.repeat(10)}END`));
  assert.equal(nativeSubagentCounts(store, 'codex', 'parent').active, 1);
});

await test('a capped message never starts inside a surrogate pair', () => {
  for (const text of ['😀'.repeat(30_000), `${'😀'.repeat(30_000)}!`]) {
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
      event('child', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
      '/repo',
      2,
    );
    const last = store['codex:child'].transcript.at(-1);
    assert.ok(last?.type === 'assistant');
    assert.ok(last.text.isWellFormed());
    assert.ok(last.text.length <= nativeMessageLimit);
    assert.ok(last.text.length >= nativeMessageLimit - 1);
    assert.ok(text.endsWith(last.text.slice(1)));
  }
});

await test('an update that changes nothing leaves a long spawn prompt whole', () => {
  const prompt = 'P'.repeat(nativeMessageLimit + 10_000);
  let store = updateNativeSubagents(
    {},
    event('parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'child',
      name: 'worker',
      task: 'Task',
      prompt,
      capabilities: {},
    }),
    '/repo',
    1,
  );
  for (const update of [
    { sessionUpdate: 'usage_update', used: 10, size: 100 },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } },
  ])
    store = updateNativeSubagents(store, event('child', update), '/repo', 2);

  assert.deepEqual(
    store['codex:child'].transcript.map((entry) => [entry.type, 'text' in entry && entry.text]),
    [
      ['user', prompt],
      ['assistant', 'Working'],
    ],
  );
});

await test('replayed lifecycle deduplicates and unfinished history disconnects', () => {
  const spawn = event('parent', {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'parent:replay-subagent:child',
    name: 'worker',
    task: 'Task',
    capabilities: {},
  });
  let store = updateNativeSubagents({}, spawn, '/repo', 1, true);
  store = updateNativeSubagents(store, spawn, '/repo', 2, true);
  assert.equal(Object.keys(store).length, 1);
  assert.equal(store['codex:parent:replay-subagent:child'].created, 1);

  store = finalizeNativeSubagentRestore(store, 'codex', 'parent', 3);
  assert.equal(store['codex:parent:replay-subagent:child'].outcome, 'unknown');
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
  store = disconnectNativeSubagents(store, 'codex', ['live'], 4);
  assert.equal(store['codex:done'].outcome, 'interrupted');
  assert.equal(store['codex:live'].outcome, 'unknown');
});

await test('disconnect leaves children from another capability connection live', () => {
  let store = updateNativeSubagents(
    {},
    event('review-parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'review-child',
      name: 'reviewer',
      task: 'Review changes',
    }),
    '/repo',
    1,
    false,
    'review',
  );
  store = updateNativeSubagents(
    store,
    event('build-parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'build-child',
      name: 'builder',
      task: 'Implement changes',
    }),
    '/repo',
    2,
    false,
    'build',
  );

  store = disconnectNativeSubagents(store, 'codex', ['review-parent', 'review-child'], 3);

  assert.equal(store['codex:review-child'].outcome, 'unknown');
  assert.equal(store['codex:build-child'].outcome, 'working');
});

await test('review native child keeps medium-risk actions denied', () => {
  const store = updateNativeSubagents(
    {},
    event('review-parent', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'review-child',
      name: 'reviewer',
      task: 'Review changes',
    }),
    '/repo',
    1,
    false,
    'review',
  );
  const thread = nativeSubagentThreads(store)[0];

  const decision = automaticPermissionPolicy({
    profile: thread.capabilityProfile ?? 'build',
    workspace: thread.directory,
    title: 'Edit file',
    toolCall: { command: 'apply_patch' },
    options: [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'deny', kind: 'reject_once' },
    ],
  });

  assert.equal(decision.profile, 'review');
  assert.equal(decision.risk, 'medium');
  assert.equal(decision.recommendation, 'deny');
  assert.equal(decision.optionId, 'deny');
});

await test('review replay replaces a cached build profile before permission policy runs', () => {
  const spawn = event('parent', {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'child',
    name: 'reviewer',
    task: 'Review changes',
  });
  let store = updateNativeSubagents({}, spawn, '/repo', 1, false, 'build');

  store = updateNativeSubagents(store, spawn, '/repo', 2, true, 'review');
  const thread = nativeSubagentThreads(store)[0];
  const decision = automaticPermissionPolicy({
    profile: thread.capabilityProfile ?? 'build',
    workspace: thread.directory,
    title: 'Edit file',
    toolCall: { command: 'apply_patch' },
    options: [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'deny', kind: 'reject_once' },
    ],
  });

  assert.equal(thread.capabilityProfile, 'review');
  assert.equal(decision.recommendation, 'deny');
  assert.equal(decision.optionId, 'deny');
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
      subagentSessionId: 'parent:replay-subagent:broken',
      name: 42,
      capabilities: {},
    }),
    '/repo',
    1,
    true,
  );
  assert.equal(
    restored['codex:parent:replay-subagent:broken'].error,
    'Incomplete subagent history',
  );
});

function spawnEvent(parent: string, child: string): AgentEvent {
  return event(parent, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: child,
    name: 'explore',
    task: 'Map the code',
    capabilities: {},
  });
}

await test('a replay of a live session does not duplicate its live children', () => {
  const live = updateNativeSubagents({}, spawnEvent('root', 'task-1'), '/repo', 1);
  const replayed = updateNativeSubagents(
    live,
    spawnEvent('root', 'root:replay-subagent:toolu_1'),
    '/repo',
    2,
    true,
  );
  assert.equal(replayed, live);
  const nested = updateNativeSubagents(
    replayed,
    spawnEvent('root:replay-subagent:toolu_1', 'root:replay-subagent:toolu_2'),
    '/repo',
    3,
    false,
  );
  assert.equal(nested, live);
  const finalized = finalizeNativeSubagentRestore(nested, 'codex', 'root', 4);
  assert.deepEqual(
    Object.values(finalized).map((child) => [child.sessionId, child.outcome]),
    [['task-1', 'working']],
  );
});

await test('a claude child spawned while its session replays stays live', () => {
  const live = { ...spawnEvent('root', 'root:live-child'), agent: 'claude' as const };
  const store = updateNativeSubagents({}, live, '/repo', 1, true);
  const child = store['claude:root:live-child'];
  assert.equal(child?.restored, false);
  assert.equal(child?.outcome, 'working');
  assert.equal(finalizeNativeSubagentRestore(store, 'claude', 'root', 2), store);
});

await test('an adapter without replay markers still restores its children', () => {
  const store = updateNativeSubagents({}, spawnEvent('root', 'thread-7'), '/repo', 1, true);
  assert.equal(store['codex:thread-7']?.restored, true);
  const finalized = finalizeNativeSubagentRestore(store, 'codex', 'root', 2);
  assert.equal(finalized['codex:thread-7']?.outcome, 'unknown');
  assert.equal(finalized['codex:thread-7']?.activity, 'Disconnected');
});

await test('a first replay still restores historical children', () => {
  const restored = updateNativeSubagents(
    {},
    event('root', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'root:replay-subagent:toolu_1',
      name: 'explore',
      task: 'Map the code',
      capabilities: {},
    }),
    '/repo',
    1,
    true,
  );
  const child = restored['codex:root:replay-subagent:toolu_1'];
  assert.equal(child?.restored, true);
  assert.equal(child?.rootSessionId, 'root');
});

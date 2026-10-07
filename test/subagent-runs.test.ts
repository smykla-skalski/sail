import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEntry, AgentEvent } from '../src/lib/acp.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import {
  nativeSubagentReceipts,
  updateNativeSubagents,
  type NativeSubagentStore,
} from '../src/lib/native-subagents.ts';
import type { SessionInfo } from '../src/lib/opencode.ts';
import { subagentRuns, taskNotificationSessionIds } from '../src/lib/subagent-runs.ts';

function update(sessionId: string, value: Record<string, unknown>): AgentEvent {
  return {
    agent: 'claude',
    message: { method: 'session/update', params: { sessionId, update: value } },
  };
}

function spawned(child: string, parent = 'root', name = 'explore'): AgentEvent {
  return update(parent, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: child,
    name,
    task: `Task for ${child}`,
    capabilities: {},
  });
}

function settled(child: string, state: string, parent = 'root'): AgentEvent {
  return update(parent, {
    sessionUpdate: 'subagent_state_update',
    subagentSessionId: child,
    state,
  });
}

function nativeStore(...events: AgentEvent[]): NativeSubagentStore {
  return events.reduce<NativeSubagentStore>(
    (store, event, index) => updateNativeSubagents(store, event, '/repo', index + 1),
    {},
  );
}

function notification(taskId: string, status: string, summary: string, usage = ''): string {
  return `<task-notification><task-id>${taskId}</task-id><status>${status}</status><summary>${summary}</summary>${usage}</task-notification>`;
}

function transcript(...texts: string[]) {
  const entries: AgentEntry[] = texts.map((text, index) => ({
    id: `entry-${index}`,
    type: 'user',
    text,
    created: 100 + index,
  }));
  return [{ agent: 'claude', sessionId: 'root', directory: '/repo', entries }];
}

function receipt(changes: Partial<SpawnReceipt> = {}): SpawnReceipt {
  return {
    receiptId: 'mcp-1',
    accessKey: 'key',
    requestId: 'request-1',
    project: '/repo',
    sourceId: 'acp:claude:root',
    sourceDirectory: '/repo',
    targetId: 'acp:claude:task-1',
    turnId: 'turn-1',
    targetDirectory: '/repo',
    worktreeId: null,
    provider: 'claude',
    prompt: 'Review the change',
    state: 'completed',
    created: 1,
    updated: 50,
    result: null,
    error: null,
    model: 'opus',
    ...changes,
  };
}

function openCodeChild(changes: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'ses-child',
    parentID: 'ses-parent',
    projectID: 'project',
    agent: 'general',
    model: { id: 'model-a', providerID: 'provider-a' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 10, updated: 20 },
    title: 'Search the docs',
    location: { directory: '/repo' },
    ...changes,
  };
}

await test('one child reported natively and by a task notification yields one run', () => {
  const runs = subagentRuns({
    native: nativeStore(spawned('task-1'), settled('task-1', 'completed')),
    transcripts: transcript(
      notification(
        'task-1',
        'completed',
        'Agent "explore" finished',
        '<usage><subagent_tokens>1200</subagent_tokens><tool_uses>4</tool_uses><duration_ms>9000</duration_ms></usage>',
      ),
    ),
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'acp:claude:task-1');
  assert.deepEqual(runs[0].sources, ['native', 'task-notification']);
  assert.equal(runs[0].name, 'explore');
  assert.equal(runs[0].parentId, 'acp:claude:root');
  assert.deepEqual(runs[0].usage, { tokens: 1200, toolUses: 4, durationMs: 9000 });
});

await test('one child reported natively and by an MCP receipt yields one run', () => {
  const runs = subagentRuns({
    native: nativeStore(spawned('task-1')),
    receipts: [receipt()],
  });

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].sources, ['native', 'mcp']);
  assert.equal(runs[0].receiptId, 'native:claude:task-1');
});

await test('the higher-precedence source sets the state and others fill missing fields', () => {
  const cases = [
    {
      name: 'live native beats an MCP receipt',
      sources: { native: nativeStore(spawned('task-1')), receipts: [receipt()] },
      source: 'native',
      state: 'working',
      model: 'opus',
      result: null,
    },
    {
      name: 'an MCP receipt beats a task notification',
      sources: {
        receipts: [receipt({ state: 'working' })],
        transcripts: transcript(notification('task-1', 'failed', 'Agent crashed')),
      },
      source: 'mcp',
      state: 'working',
      model: 'opus',
      result: 'Agent crashed',
    },
    {
      name: 'live native beats a task notification',
      sources: {
        native: nativeStore(spawned('task-1')),
        transcripts: transcript(notification('task-1', 'killed', 'Agent stopped')),
      },
      source: 'native',
      state: 'working',
      model: null,
      result: 'Agent stopped',
    },
    {
      name: 'all three sources resolve to native',
      sources: {
        native: nativeStore(spawned('task-1'), settled('task-1', 'failed')),
        receipts: [receipt({ state: 'working' })],
        transcripts: transcript(notification('task-1', 'completed', 'Done')),
      },
      source: 'native',
      state: 'failed',
      model: 'opus',
      result: 'Done',
    },
  ];
  for (const item of cases) {
    const runs = subagentRuns(item.sources);
    assert.equal(runs.length, 1, item.name);
    assert.equal(runs[0].source, item.source, item.name);
    assert.equal(runs[0].state, item.state, item.name);
    assert.equal(runs[0].model, item.model, item.name);
    assert.equal(runs[0].result, item.result, item.name);
  }
});

await test('task notifications join generation 1 by task id and later generations by suffix', () => {
  assert.deepEqual(taskNotificationSessionIds(['a', 'b', 'a', 'a']), [
    'a',
    'b',
    'a:generation:2',
    'a:generation:3',
  ]);

  const runs = subagentRuns({
    native: nativeStore(
      spawned('task-1'),
      settled('task-1', 'completed'),
      spawned('task-1:generation:2'),
      settled('task-1:generation:2', 'completed'),
    ),
    transcripts: transcript(
      notification('task-1', 'completed', 'First pass done'),
      notification('task-1', 'completed', 'Second pass done'),
    ),
  });

  assert.deepEqual(
    runs.map((run) => [run.sessionId, run.sources, run.result]),
    [
      ['task-1', ['native', 'task-notification'], 'First pass done'],
      ['task-1:generation:2', ['native', 'task-notification'], 'Second pass done'],
    ],
  );
});

await test('a task notification without a known child stays its own read-only run', () => {
  const runs = subagentRuns({
    transcripts: transcript(notification('task-9', 'stopped', 'Agent stopped')),
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'acp:claude:task-9');
  assert.equal(runs[0].state, 'interrupted');
  assert.deepEqual(runs[0].controls, { prompt: false, cancel: false });
});

await test('native receipts in the receipt list do not add a second run', () => {
  const native = nativeStore(spawned('task-1'));
  const runs = subagentRuns({ native, receipts: nativeSubagentReceipts(native) });

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].sources, ['native']);
});

await test('receipts for the same child thread keep the latest one', () => {
  const runs = subagentRuns({
    receipts: [
      receipt({ receiptId: 'old', state: 'completed', updated: 10 }),
      receipt({ receiptId: 'new', state: 'working', updated: 20 }),
    ],
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].receiptId, 'new');
  assert.equal(runs[0].state, 'working');
});

await test('MCP children are keyed by their thread and ship workers need no adapter', () => {
  const runs = subagentRuns({
    receipts: [
      receipt({ receiptId: 'pending', targetId: null, targetDirectory: null, created: 1 }),
      receipt({
        receiptId: 'ship:worker',
        requestId: 'ship:/repo:12',
        provider: 'opencode',
        targetId: 'opencode:ses-worker',
        targetDirectory: '/repo/issue-12',
        created: 2,
      }),
    ],
  });

  assert.deepEqual(
    runs.map((run) => [run.id, run.sessionId, run.directory, run.controls]),
    [
      ['receipt:pending', null, null, { prompt: false, cancel: false }],
      ['opencode:ses-worker', 'ses-worker', '/repo/issue-12', { prompt: true, cancel: true }],
    ],
  );
});

await test('native children are read-only because the adapter accepts no child prompt', () => {
  const [run] = subagentRuns({ native: nativeStore(spawned('task-1')) });

  assert.deepEqual(run.controls, { prompt: false, cancel: false });
});

await test('OpenCode children are keyed by session id with live state', () => {
  const runs = subagentRuns({
    openCode: [
      {
        parentSessionId: 'ses-parent',
        directory: '/repo',
        children: [
          openCodeChild({ id: 'ses-a', time: { created: 1, updated: 5 } }),
          openCodeChild({ id: 'ses-b', outcome: 'succeeded', time: { created: 2, updated: 5 } }),
          openCodeChild({ id: 'ses-c', outcome: 'failed', time: { created: 3, updated: 5 } }),
          openCodeChild({ id: 'ses-d', time: { created: 4, updated: 5 } }),
        ],
        active: ['ses-a'],
      },
    ],
  });

  assert.deepEqual(
    runs.map((run) => [run.id, run.state]),
    [
      ['opencode:ses-a', 'working'],
      ['opencode:ses-b', 'completed'],
      ['opencode:ses-c', 'failed'],
      ['opencode:ses-d', 'unavailable'],
    ],
  );
  assert.equal(runs[0].parentId, 'opencode:ses-parent');
  assert.equal(runs[0].name, 'general');
  assert.equal(runs[0].task, 'Search the docs');
  assert.equal(runs[0].model, 'provider-a/model-a');
});

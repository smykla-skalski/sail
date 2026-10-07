import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityHistoryWithoutLiveItems,
  workspaceActivityItems,
} from '../src/lib/workspace-activity.ts';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';

function child(index: number, state: SpawnReceipt['state'] = 'working'): SpawnReceipt {
  return {
    receiptId: `child-${index}`,
    accessKey: 'key',
    requestId: `request-${index}`,
    project: '/repo',
    sourceId: 'opencode:parent',
    sourceDirectory: '/repo',
    targetId: `acp:codex:child-${index}`,
    turnId: 'turn',
    targetDirectory: `/repo/child-${index}`,
    worktreeId: `/repo/child-${index}`,
    provider: 'codex',
    prompt: `Child task ${index}`,
    state,
    created: index,
    updated: index,
    result: null,
    error: null,
    activity: `Working on child ${index}`,
  };
}

await test('workspace activity separates live, blocked, and recent real state', () => {
  const items = workspaceActivityItems({
    tools: [
      { id: 'running', title: 'Run tests', status: 'in_progress', updated: 20 },
      { id: 'queued', title: 'Queue tests', status: 'pending', updated: 15 },
      { id: 'done', title: 'Read file', status: 'completed', updated: 10 },
    ],
    children: [child(1), child(2, 'waiting')],
    decisions: [{ id: 'permission', title: 'Allow command?', detail: 'Permission' }],
    checks: [
      {
        id: 'check',
        updated: 30,
        directory: '/repo',
        thread: 'opencode:parent',
        turn: 'turn',
        source: 'repository',
        command: 'npm test',
        status: 'failed',
        output: 'failed',
        code: 1,
      },
    ],
  });

  assert.deepEqual(
    items.filter((item) => item.section === 'now').map((item) => item.id),
    ['tool:running', 'tool:queued', 'child:child-1'],
  );
  assert.deepEqual(
    items.filter((item) => item.section === 'needs-input').map((item) => item.id),
    ['decision:permission', 'check:check', 'child:child-2'],
  );
  assert.equal(items.find((item) => item.id === 'tool:queued')?.status, 'queued');
  assert.deepEqual(
    items.filter((item) => item.section === 'recent').map((item) => item.id),
    ['tool:done'],
  );
});

await test('workspace activity keeps ten children readable and bounds only recent history', () => {
  const items = workspaceActivityItems({
    children: Array.from({ length: 10 }, (_, index) => child(index)),
    tools: Array.from({ length: 20 }, (_, index) => ({
      id: `done-${index}`,
      title: `Completed ${index}`,
      status: 'completed',
      updated: index,
    })),
    recentLimit: 4,
  });

  assert.equal(items.filter((item) => item.section === 'now').length, 10);
  assert.equal(items.filter((item) => item.section === 'recent').length, 4);
});

await test('workspace activity preserves an unavailable child as an explicit source', () => {
  const missing = { ...child(1, 'starting'), targetId: null, targetDirectory: null, updated: 1e20 };
  const [item] = workspaceActivityItems({ children: [missing] });

  assert.equal(item.sourceId, 'child-1');
  assert.equal(item.detail, 'Thread target not confirmed');
  assert.equal(item.updated, 1e20);
});

await test('workspace activity preserves input order when tool timestamps are absent', () => {
  const items = workspaceActivityItems({
    tools: Array.from({ length: 15 }, (_, index) => ({
      id: `tool-${index}`,
      title: `Tool ${index}`,
      status: 'completed',
    })),
    recentLimit: 4,
  });

  assert.deepEqual(
    items.map((item) => item.sourceId),
    ['tool-14', 'tool-13', 'tool-12', 'tool-11'],
  );
});

await test('durable history excludes sources already shown as live activity', () => {
  const items = workspaceActivityItems({
    children: [child(1)],
    tools: [{ id: 'tool', title: 'Read file', status: 'completed', updated: 2 }],
  });
  const events = [
    {
      id: 'child-history',
      workspace: '/repo',
      kind: 'subagent' as const,
      source: 'codex',
      sourceId: 'child-1',
      title: 'Child task 1',
      outcome: 'working',
      at: 2,
    },
    {
      id: 'tool-history',
      workspace: '/repo',
      kind: 'tool' as const,
      source: 'codex',
      sourceId: 'tool',
      title: 'Read file',
      outcome: 'completed',
      at: 2,
    },
    {
      id: 'parent-history',
      workspace: '/repo',
      kind: 'parent' as const,
      source: 'codex',
      sourceId: 'parent',
      title: 'Parent task',
      outcome: 'completed',
      at: 1,
    },
  ];

  assert.deepEqual(
    activityHistoryWithoutLiveItems(items, events).map((event) => event.id),
    ['parent-history'],
  );
});

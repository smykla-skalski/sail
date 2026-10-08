import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import type { InboxItem } from '../src/lib/inbox.ts';
import {
  childPermissions,
  permissionAlreadyAnswered,
  stoppableSubagents,
  subagentStop,
} from '../src/lib/subagent-control.ts';

function receipt(id: string, overrides: Partial<SpawnReceipt> = {}): SpawnReceipt {
  return {
    receiptId: id,
    accessKey: '',
    requestId: id,
    project: '/a',
    sourceId: 'acp:claude:parent',
    sourceDirectory: '/a',
    targetId: `acp:codex:${id}`,
    turnId: null,
    targetDirectory: '/a',
    worktreeId: null,
    provider: 'codex',
    prompt: id,
    state: 'working',
    created: 1,
    updated: 1,
    result: null,
    error: null,
    ...overrides,
  };
}

function permission(sessionId: string, agentId = 'codex'): InboxItem {
  return {
    key: `acp:${agentId}:${sessionId}:1`,
    kind: 'acp-permission',
    agent: agentId,
    agentId,
    sessionId,
    requestId: 1,
    text: 'Run',
    receivedAt: 1,
    directory: '/a',
    project: '/a',
    worktree: null,
  };
}

void test('native children cannot be stopped alone', () => {
  assert.equal(subagentStop(receipt('native:claude:x')), 'parent-turn');
});

void test('Ship gates and Ship workers are managed by Stop run', () => {
  assert.equal(
    subagentStop(
      receipt('gate', { validation: { gate: 'code-adversary', requestedModel: 'default' } }),
    ),
    'ship-managed',
  );
  assert.equal(subagentStop(receipt('worker'), new Set(['acp:codex:worker'])), 'ship-managed');
});

void test('MCP and OpenCode children stop individually', () => {
  assert.equal(subagentStop(receipt('mcp')), 'stop');
  assert.equal(subagentStop(receipt('oc', { targetId: 'opencode:oc' })), 'stop');
  assert.equal(subagentStop(receipt('none', { targetId: null })), 'none');
});

void test('stop all skips native, Ship-managed and settled children', () => {
  const receipts = [
    receipt('a'),
    receipt('native:claude:b'),
    receipt('c', { state: 'completed' }),
    receipt('d'),
  ];
  assert.deepEqual(
    stoppableSubagents(receipts, new Set(['acp:codex:d'])).map((item) => item.receiptId),
    ['a'],
  );
});

void test('child permissions match by agent, session and directory', () => {
  const control = {
    permissions: [permission('a'), permission('b'), permission('a', 'claude')],
    answered: [{ key: 'k', agentId: 'codex', sessionId: 'a', title: 'Run' }],
  };
  const found = childPermissions(control, receipt('a'));
  assert.equal(found.pending.length, 1);
  assert.equal(found.answered.length, 1);
  assert.deepEqual(childPermissions(control, receipt('z')), { pending: [], answered: [] });
});

void test('a request that is no longer pending counts as answered', () => {
  assert.equal(
    permissionAlreadyAnswered(new Error('Permission request is no longer pending.')),
    true,
  );
  assert.equal(permissionAlreadyAnswered('Agent session is not connected.'), false);
});

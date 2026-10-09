import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import type { InboxItem } from '../src/lib/inbox.ts';
import {
  answeredPermissionKey,
  childPermissions,
  permissionAlreadyAnswered,
  permissionResolution,
  permissionResolutionLabel,
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
    answered: [{ key: 'k', agentId: 'codex', sessionId: 'a', title: 'Run', outcome: 'answered' }],
  };
  const found = childPermissions(control, receipt('a'));
  assert.equal(found.pending.length, 1);
  assert.equal(found.answered.length, 1);
  assert.deepEqual(childPermissions(control, receipt('z')), { pending: [], answered: [] });
});

void test('a request that is no longer pending is recognised as settled', () => {
  assert.equal(
    permissionAlreadyAnswered(new Error('Permission request is no longer pending.')),
    true,
  );
  assert.equal(permissionAlreadyAnswered('Agent session is not connected.'), false);
});

await test('a cancelled request does not read as answered', () => {
  const cases: [Record<string, unknown> | undefined, string][] = [
    [{ sailPermissionOutcome: 'cancelled' }, 'Cancelled'],
    [{ sailPermissionOutcome: 'selected' }, 'Answered'],
    [{}, 'Answered'],
    [undefined, 'Answered'],
  ];
  for (const [params, label] of cases)
    assert.equal(permissionResolutionLabel(permissionResolution(params)), label);
});

await test('a reused request id gets its own note per request instance', () => {
  const first = { sailPermissionGeneration: 1, sailPermissionFingerprint: 'a' };
  const reconnected = { sailPermissionGeneration: 1, sailPermissionFingerprint: 'b' };
  assert.notEqual(
    answeredPermissionKey('codex', 'child', 7, first),
    answeredPermissionKey('codex', 'child', 7, reconnected),
  );
  assert.notEqual(
    answeredPermissionKey('codex', 'child', 7, { sailPermissionGeneration: 1 }),
    answeredPermissionKey('codex', 'child', 7, { sailPermissionGeneration: 2 }),
  );
  assert.equal(
    answeredPermissionKey('codex', 'child', 7, {}),
    answeredPermissionKey('codex', 'child', 7, undefined),
  );
});

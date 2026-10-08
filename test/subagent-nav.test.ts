import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import { subagentNavigation } from '../src/lib/subagent-nav.ts';

function receipt(
  child: string,
  created: number,
  overrides: Partial<SpawnReceipt> = {},
): SpawnReceipt {
  return {
    receiptId: `r:${child}`,
    accessKey: '',
    requestId: child,
    project: '/a',
    sourceId: 'acp:claude:parent',
    sourceDirectory: '/a',
    targetId: `acp:claude:${child}`,
    turnId: null,
    targetDirectory: '/a',
    worktreeId: null,
    provider: 'claude',
    prompt: child,
    state: 'working',
    created,
    updated: created,
    result: null,
    error: null,
    ...overrides,
  };
}

void test('a child finds its parent and ordered siblings', () => {
  const receipts = [receipt('b', 2), receipt('a', 1), receipt('c', 3)];
  const nav = subagentNavigation(receipts, { agent: 'claude', sessionId: 'b', directory: '/a' });
  assert.deepEqual(nav?.parent, { directory: '/a', threadId: 'acp:claude:parent' });
  assert.deepEqual(nav?.previous, { directory: '/a', threadId: 'acp:claude:a' });
  assert.deepEqual(nav?.next, { directory: '/a', threadId: 'acp:claude:c' });
  assert.equal(nav?.index, 1);
});

void test('first and last children have no outer sibling', () => {
  const receipts = [receipt('a', 1), receipt('b', 2)];
  assert.equal(
    subagentNavigation(receipts, { agent: 'claude', sessionId: 'a', directory: '/a' })?.previous,
    null,
  );
  assert.equal(
    subagentNavigation(receipts, { agent: 'claude', sessionId: 'b', directory: '/a' })?.next,
    null,
  );
});

void test('a parent thread and unknown threads have no navigation', () => {
  const receipts = [receipt('a', 1)];
  assert.equal(
    subagentNavigation(receipts, { agent: 'claude', sessionId: 'parent', directory: '/a' }),
    null,
  );
  assert.equal(subagentNavigation(receipts, null), null);
});

void test('a child in another worktree navigates back to its parent', () => {
  const receipts = [
    receipt('a', 1, { targetDirectory: '/b' }),
    receipt('b', 2, { targetDirectory: '/b' }),
  ];
  const nav = subagentNavigation(receipts, { agent: 'claude', sessionId: 'a', directory: '/b' });
  assert.deepEqual(nav?.parent, { directory: '/a', threadId: 'acp:claude:parent' });
  assert.deepEqual(nav?.next, { directory: '/b', threadId: 'acp:claude:b' });
});

void test('OpenCode children use the opencode id form', () => {
  const receipts = [
    receipt('x', 1, { sourceId: 'opencode:p', targetId: 'opencode:x', provider: 'opencode' }),
  ];
  const nav = subagentNavigation(receipts, { agent: 'opencode', sessionId: 'x', directory: '/a' });
  assert.equal(nav?.parent.threadId, 'opencode:p');
});

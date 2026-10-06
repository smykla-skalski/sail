import assert from 'node:assert/strict';
import test from 'node:test';
import { needsChildSummary } from '../src/lib/opencode-subagent-summary.ts';

void test('refreshes only new, updated, or active child summaries', () => {
  const child = { id: 'child', time: { updated: 12 } };
  assert.equal(needsChildSummary(child, [], new Map()), true);
  assert.equal(needsChildSummary(child, [], new Map([['child', 11]])), true);
  assert.equal(needsChildSummary(child, ['child'], new Map([['child', 12]])), true);
  assert.equal(needsChildSummary(child, [], new Map([['child', 12]])), false);
});

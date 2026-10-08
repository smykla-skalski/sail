import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpawnReceipt } from '../src/lib/agent-results.ts';
import {
  lastSignalAge,
  stateAnnouncement,
  subagentDurationMs,
  subagentType,
  toolCountLabel,
} from '../src/lib/subagent-display.ts';

const receipt: SpawnReceipt = {
  receiptId: 'native:claude:child',
  accessKey: '',
  requestId: 'native:child',
  project: '/repo',
  sourceId: 'acp:claude:parent',
  sourceDirectory: '/repo',
  targetId: 'acp:claude:child',
  turnId: null,
  targetDirectory: '/repo',
  worktreeId: null,
  provider: 'claude',
  prompt: 'Map the code',
  state: 'completed',
  created: 10_000,
  updated: 75_000,
  result: null,
  error: null,
};

await test('the agent type comes from the name and falls back to the provider', () => {
  assert.equal(subagentType({ ...receipt, name: 'Explore' }), 'Explore');
  assert.equal(subagentType({ ...receipt, name: ' Plan ' }), 'Plan');
  assert.equal(subagentType({ ...receipt, name: 'Subagent' }), 'Claude');
  assert.equal(subagentType({ ...receipt, name: '  ' }), 'Claude');
  assert.equal(subagentType({ ...receipt, provider: 'codex' }), 'Codex');
  assert.equal(subagentType({ ...receipt, provider: 'opencode' }), 'OpenCode');
});

await test('a settled child ran until its last update and a live one until now', () => {
  assert.equal(subagentDurationMs(receipt, 999_999), 65_000);
  assert.equal(subagentDurationMs({ ...receipt, state: 'working' }, 40_000), 30_000);
});

await test('unknown or sub-second runs have no duration', () => {
  assert.equal(subagentDurationMs({ ...receipt, updated: 10_400 }, 0), null);
  assert.equal(subagentDurationMs({ ...receipt, created: 0 }, 0), null);
  assert.equal(subagentDurationMs({ ...receipt, created: Number.NaN }, 0), null);
  assert.equal(subagentDurationMs({ ...receipt, state: 'working' }, 5_000), null);
});

await test('staleness reads as time since the last signal', () => {
  assert.equal(lastSignalAge({ updated: 10_000 }, 10_400), 'just now');
  assert.equal(lastSignalAge({ updated: 10_000 }, 17_000), '7s ago');
  assert.equal(lastSignalAge({ updated: 10_000 }, 85_000), '1m 15s ago');
  assert.equal(lastSignalAge({ updated: 10_000 }, 5_000), 'just now');
  assert.equal(lastSignalAge({ updated: 0 }, 5_000), null);
  assert.equal(lastSignalAge({ updated: 1e20 }, 5_000), 'just now');
});

await test('tool counts and announcements name what changed', () => {
  assert.equal(toolCountLabel(1), '1 tool use');
  assert.equal(toolCountLabel(0), '0 tool uses');
  assert.equal(
    stateAnnouncement({ ...receipt, name: 'Explore', state: 'failed' }),
    'Explore subagent Map the code: Failed',
  );
  assert.equal(stateAnnouncement({ ...receipt, prompt: null }), 'Claude subagent: Completed');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { activityState } from '../src/lib/activity-state.ts';

void test('normalizes provider states into shared visible states', () => {
  const cases = [
    ['running', 'working', 'Working', '●'],
    ['in-progress', 'working', 'Working', '●'],
    ['stopping', 'working', 'Working', '●'],
    ['needs input', 'waiting', 'Needs input', '!'],
    ['pending', 'queued', 'Queued', '◷'],
    ['done', 'completed', 'Completed', '✓'],
    ['error', 'failed', 'Failed', '×'],
    ['killed', 'failed', 'Failed', '×'],
    ['rejected', 'failed', 'Failed', '×'],
    ['cancelled', 'interrupted', 'Interrupted', '■'],
    ['stopped', 'interrupted', 'Interrupted', '■'],
    ['unavailable', 'offline', 'Offline', '○'],
  ] as const;

  for (const [input, state, label, icon] of cases)
    assert.deepEqual(activityState(input), { state, label, icon });
});

void test('uses an explicit unknown state for absent and unrecognized values', () => {
  assert.deepEqual(activityState(null), { state: 'unknown', label: 'Unknown', icon: '?' });
  assert.deepEqual(activityState('provider-mystery'), {
    state: 'unknown',
    label: 'Unknown',
    icon: '?',
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { activityForSession, parseHookActivity } from '../src/lib/hook-activity.ts';

const event = (sessionId: string) => ({
  id: crypto.randomUUID(),
  provider: 'Claude',
  sessionId,
  event: 'PreToolUse',
  source: 'Sail-managed project hook',
  outcome: 'observed',
  action: 'Bash',
  reason: 'Policy denied it',
  created: Date.now(),
  diagnostics: { tool_input: { command: 'secret' } },
});

void test('runtime hook events stay attached to their provider session', () => {
  const parent = parseHookActivity(event('parent'))!;
  const child = parseHookActivity(event('child'))!;
  assert.deepEqual(activityForSession([parent, child], 'parent'), [parent]);
  assert.deepEqual(activityForSession([parent, child], 'child'), [child]);
});

void test('runtime hook parser rejects fabricated and malformed outcomes', () => {
  assert.equal(parseHookActivity({ ...event('s'), outcome: 'configured' }), null);
  assert.equal(parseHookActivity({ ...event('s'), sessionId: null }), null);
});

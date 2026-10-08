import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

void test('every alias maps to its canonical state, hyphenated and spaced spellings included', () => {
  const aliases: Record<string, string> = {
    working: 'working',
    running: 'working',
    in_progress: 'working',
    stopping: 'working',
    fixing: 'fixing',
    stalled: 'stalled',
    waiting: 'waiting',
    needs_input: 'waiting',
    blocked: 'waiting',
    queued: 'queued',
    pending: 'queued',
    starting: 'queued',
    completed: 'completed',
    complete: 'completed',
    done: 'completed',
    succeeded: 'completed',
    success: 'completed',
    failed: 'failed',
    failure: 'failed',
    error: 'failed',
    killed: 'failed',
    rejected: 'failed',
    interrupted: 'interrupted',
    stopped: 'interrupted',
    cancelled: 'interrupted',
    canceled: 'interrupted',
    unavailable: 'offline',
    offline: 'offline',
    disconnected: 'offline',
    unknown: 'unknown',
    connecting: 'connecting',
    ready: 'ready',
  };
  for (const [alias, state] of Object.entries(aliases)) {
    for (const spelling of [
      alias,
      alias.replaceAll('_', '-'),
      alias.replaceAll('_', ' '),
      alias.toUpperCase(),
      ` ${alias} `,
    ])
      assert.equal(activityState(spelling).state, state, JSON.stringify(spelling));
  }
});

void test('fixing and stalled are visible states with their own labels', () => {
  assert.deepEqual(activityState('fixing'), { state: 'fixing', label: 'Fixing', icon: '↻' });
  assert.deepEqual(activityState('stalled'), { state: 'stalled', label: 'Stalled', icon: '‖' });
  assert.equal(activityState('blocked').label, 'Needs input');
  assert.equal(activityState('done').state, 'completed');
});

void test('every activity state has a color token and a data-state style', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const component = readFileSync(new URL('../src/ActivityStatus.svelte', import.meta.url), 'utf8');
  for (const state of ['fixing', 'stalled'])
    assert.match(css, new RegExp(`--activity-${state}: #`), state);
  for (const state of ['working', 'fixing', 'stalled', 'waiting', 'completed', 'failed'])
    assert.match(component, new RegExp(`data-state='${state}'`), state);
});

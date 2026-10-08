import assert from 'node:assert/strict';
import test from 'node:test';
import { nativePlanUpdate, replayNativePlan } from '../src/lib/native-plan.ts';

await test('tracks Codex plan_update progress', () => {
  const plan = nativePlanUpdate('codex', {
    sessionUpdate: 'plan_update',
    plan: { markdown: '# Plan\n\n- inspect', steps: [{ title: 'Inspect', status: 'completed' }] },
  });
  assert.deepEqual(plan?.tasks, [{ title: 'Inspect', status: 'completed' }]);
});

await test('uses Claude ExitPlanMode instead of its task stream', () => {
  const task = nativePlanUpdate('claude', {
    sessionUpdate: 'plan_update',
    plan: '# not authoritative',
  });
  const plan = nativePlanUpdate('claude', {
    sessionUpdate: 'tool_call',
    title: 'ExitPlanMode',
    input: { plan: '# Implementation plan' },
  });
  assert.equal(task, null);
  assert.equal(plan?.markdown, '# Implementation plan');
});

await test('replays the latest native plan', () => {
  const plan = replayNativePlan('codex', [
    { sessionUpdate: 'plan_update', plan: '# First' },
    { sessionUpdate: 'plan_update', plan: '# Latest' },
  ]);
  assert.equal(plan?.markdown, '# Latest');
});

await test('maps OpenCode ACP plan entries and ignores Codex-only updates', () => {
  const plan = nativePlanUpdate('opencode', {
    sessionUpdate: 'plan',
    entries: [
      { content: 'Inspect', priority: 'high', status: 'completed' },
      { content: 'Edit', priority: 'medium', status: 'pending' },
    ],
  });
  assert.equal(plan?.provider, 'opencode');
  assert.equal(plan?.markdown, '- [x] Inspect\n- [ ] Edit');
  assert.deepEqual(plan?.tasks, [
    { title: 'Inspect', status: 'completed' },
    { title: 'Edit', status: 'pending' },
  ]);
  assert.equal(nativePlanUpdate('opencode', { sessionUpdate: 'plan', entries: [] }, plan), plan);
  assert.equal(nativePlanUpdate('opencode', { sessionUpdate: 'plan_update', plan: '# x' }), null);
  assert.equal(
    nativePlanUpdate('codex', { sessionUpdate: 'plan', entries: [{ content: 'x' }] }),
    null,
  );
});

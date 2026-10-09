import assert from 'node:assert/strict';
import test from 'node:test';
import { canExecutePlan, executionSummary, skippedSteps, type Plan } from '../src/lib/plan.ts';

const plan: Plan = {
  title: 'Plan',
  summary: 'Summary',
  steps: [
    {
      id: 's1',
      title: 'First',
      detail: 'Detail',
      files: [],
      risk: 'low',
      status: 'proposed',
      origin: 'plan',
      touched: [],
    },
    {
      id: 's2',
      title: 'Second',
      detail: 'Detail',
      files: [],
      risk: 'low',
      status: 'proposed',
      origin: 'plan',
      touched: [],
    },
    {
      id: 's3',
      title: 'Completed',
      detail: 'Detail',
      files: [],
      risk: 'low',
      status: 'done',
      origin: 'plan',
      touched: [],
    },
  ],
  sessionID: 'session',
  version: 2,
  state: 'review',
  reviewReason: 'plan',
  outside: [],
  createdAt: 1,
};

await test('execution requires unfinished approved work and lists skipped steps', () => {
  assert.equal(canExecutePlan(plan, {}), false);
  const decisions = { s1: { stepID: 's1', edit: { title: 'Changed' } } };
  assert.equal(canExecutePlan(plan, decisions), true);
  assert.deepEqual(skippedSteps(plan, decisions), ['s2']);
  assert.equal(canExecutePlan(plan, { s1: { stepID: 's1', verdict: 'reject' } }), false);
});

await test('execution summary keeps blocked work and failed checks visible after restart', () => {
  const run: Plan = {
    ...plan,
    state: 'executing',
    outside: ['unexpected.ts', 'unexpected.ts'],
    steps: [
      {
        ...plan.steps[0],
        status: 'done',
        files: ['a.ts'],
        touched: ['a.ts'],
        check: { outcome: 'fail', summary: 'lint failed' },
      },
      {
        ...plan.steps[1],
        status: 'blocked',
        files: ['src/**'],
        touched: ['src/b.ts', 'b.ts'],
        note: 'waiting for input',
      },
      { ...plan.steps[2], status: 'skipped' },
    ],
  };

  const summary = executionSummary(run, '/repo');
  assert.equal(summary.progress, 67);
  assert.deepEqual([summary.done, summary.skipped, summary.total], [1, 1, 3]);
  assert.deepEqual(
    summary.blocked.map((step) => step.id),
    ['s2'],
  );
  assert.deepEqual(
    summary.failed.map((step) => step.id),
    ['s1'],
  );
  assert.deepEqual(summary.touched, ['a.ts', 'src/b.ts', 'b.ts']);
  assert.deepEqual(summary.drift, [{ step: 'Second', file: 'b.ts' }]);
  assert.deepEqual(summary.unattributed, ['unexpected.ts']);
});

await test('completed run counts excluded steps and identifies absolute-path drift', () => {
  const run: Plan = {
    ...plan,
    state: 'done',
    steps: [
      {
        ...plan.steps[0],
        status: 'done',
        files: ['src'],
        touched: ['/repo/src/a.ts', '/repo/other.ts'],
      },
      { ...plan.steps[1], status: 'rejected' },
    ],
  };
  const summary = executionSummary(run, '/repo');
  assert.equal(summary.progress, 100);
  assert.equal(summary.excluded, 1);
  assert.deepEqual(summary.drift, [{ step: 'First', file: '/repo/other.ts' }]);
});

await test('step file coverage recognizes Windows paths', () => {
  const run: Plan = {
    ...plan,
    steps: [
      {
        ...plan.steps[0],
        files: ['src'],
        touched: ['c:\\repo\\src\\a.ts', 'C:\\repo\\other.ts'],
      },
    ],
  };
  assert.deepEqual(executionSummary(run, 'C:\\Repo').drift, [
    { step: 'First', file: 'C:\\repo\\other.ts' },
  ]);
});

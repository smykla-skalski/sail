import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveAllSteps,
  canExecutePlan,
  coveredFile,
  executionSummary,
  skippedSteps,
  type Plan,
  type PlanDecision,
} from '../src/lib/plan.ts';
import { review } from '../src/lib/plan-engine.ts';

await test('approved paths retain their worktree identity', () => {
  const directory = '/worktrees/benchee';
  const approved = ['/worktrees/cairn/services/proxy/src/store.rs'];
  assert.equal(coveredFile(approved[0], approved, directory), true);
  assert.equal(
    coveredFile('/worktrees/other/services/proxy/src/store.rs', approved, directory),
    false,
  );
  assert.equal(coveredFile(approved[0], ['services/proxy/src/store.rs'], directory), false);
  assert.equal(coveredFile('/worktrees/benchee/src/main.rs', ['src/main.rs'], directory), true);
  assert.equal(coveredFile('src/main.rs', ['/worktrees/benchee/src/main.rs'], directory), true);
});

await test('approved external directories and globs remain bounded', () => {
  const directory = '/worktrees/benchee';
  for (const approved of [['/worktrees/cairn/src'], ['/worktrees/cairn/src/**']]) {
    assert.equal(coveredFile('/worktrees/cairn/src/routes/cache.rs', approved, directory), true);
    assert.equal(coveredFile('/worktrees/cairn/src-other/cache.rs', approved, directory), false);
    assert.equal(coveredFile('/worktrees/cairn/src/../../secret', approved, directory), false);
    assert.equal(coveredFile('/worktrees/other/src/cache.rs', approved, directory), false);
  }
});

await test('path aliases normalize before comparing approved files', () => {
  assert.equal(coveredFile('/repo/src/./main.rs', ['src/main.rs'], '/repo/'), true);
  assert.equal(coveredFile('src/../secret', ['src/**'], '/repo'), false);
  assert.equal(coveredFile('/other/src/main.rs', ['/other//src/./main.rs'], '/repo'), true);
  assert.equal(coveredFile('C:\\Other\\src\\MAIN.rs', ['c:/other/src/main.rs'], 'C:/Repo'), true);
  assert.equal(coveredFile('D:/other/src/main.rs', ['C:/other/src/main.rs'], 'C:/Repo'), false);
});

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

await test('accepting all starts every unfinished step and preserves review feedback', () => {
  const draft: Record<string, PlanDecision> = {
    s1: { stepID: 's1', verdict: 'revise', comment: 'Keep this note' },
    s2: { stepID: 's2', verdict: 'reject', edit: { title: 'Edited second' } },
    s3: { stepID: 's3', comment: 'Already complete' },
  };

  const decisions = approveAllSteps(plan, draft);
  const result = review(plan, {
    version: plan.version,
    action: 'execute',
    decisions: Object.values(decisions),
  });

  assert.equal(canExecutePlan(plan, decisions), true);
  assert.deepEqual(skippedSteps(plan, decisions), []);
  assert.deepEqual(decisions, {
    s1: { stepID: 's1', verdict: 'approve', comment: 'Keep this note' },
    s2: { stepID: 's2', verdict: 'approve', edit: { title: 'Edited second' } },
    s3: { stepID: 's3', comment: 'Already complete' },
  });
  assert.equal(draft.s1.verdict, 'revise');
  assert.equal(draft.s2.verdict, 'reject');
  assert.ok(result.ok);
  assert.equal(result.value.state, 'executing');
  assert.deepEqual(
    result.value.steps.map((step) => step.status),
    ['approved', 'approved', 'done'],
  );
  assert.equal(result.value.steps[1].title, 'Edited second');
});

await test('accepting all leaves completed and skipped work settled', () => {
  const settled: Plan = {
    ...plan,
    steps: [
      { ...plan.steps[0], status: 'done' },
      { ...plan.steps[1], status: 'skipped' },
    ],
  };

  const decisions = approveAllSteps(settled, {});

  assert.equal(canExecutePlan(settled, decisions), false);
  assert.deepEqual(skippedSteps(settled, decisions), []);
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

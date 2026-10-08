import assert from 'node:assert/strict';
import test from 'node:test';
import type { Plan } from '../src/lib/plan.ts';
import {
  AmendSchema,
  ProposeInputSchema,
  StepUpdateSchema,
  amend,
  createEditTracker,
  modeAfterPlan,
  outsideWarning,
  propose,
  recordTouch,
  review,
  reviewMessage,
  updateStep,
} from '../src/lib/plan-engine.ts';

const directory = '/repo';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Add stats',
    summary: ['Record command usage.'],
    sequence: ['User->>CLI: demo greet', 'CLI-->>User: Hello'],
    overview: ['CLI[bin/demo.ts] --> Stats[src/stats.ts]'],
    steps: [
      { id: 's1', title: 'Add stats module', detail: 'Create it.', files: ['src/stats.ts'] },
      {
        id: 's2',
        title: 'Wire the CLI',
        detail: 'Call it.',
        files: ['bin/demo.ts'],
        risk: 'high',
      },
    ],
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}) {
  return ProposeInputSchema.parse(proposal(overrides));
}

function proposed(overrides: Record<string, unknown> = {}): Plan {
  const result = propose(undefined, parsed(overrides), 'session', 1);
  assert.ok(result.ok);
  return result.value;
}

function executing(): Plan {
  const plan = proposed();
  const result = review(plan, {
    sessionID: 'session',
    version: 1,
    action: 'execute',
    decisions: [
      { stepID: 's1', verdict: 'approve' },
      { stepID: 's2', verdict: 'approve' },
    ],
  });
  assert.ok(result.ok);
  return result.value;
}

await test('propose normalizes diagrams and tolerates stringified lists', () => {
  const input = ProposeInputSchema.parse(
    proposal({ steps: JSON.stringify(proposal().steps), overview: ['A --> B'] }),
  );
  assert.equal(input.diagram, 'flowchart TD\nA --> B');
  assert.equal(input.steps.length, 2);
  assert.equal(input.steps[0].risk, 'low');
});

await test('propose rejects prose where mermaid is required', () => {
  assert.equal(ProposeInputSchema.safeParse(proposal({ sequence: ['just words'] })).success, false);
  assert.equal(ProposeInputSchema.safeParse(proposal({ overview: ['just words'] })).success, false);
  assert.equal(ProposeInputSchema.safeParse(proposal({ steps: '{broken' })).success, false);
});

await test('a revised proposal keeps settled steps that did not change', () => {
  const plan = executing();
  const done = updateStep(plan, {
    stepID: 's1',
    status: 'done',
    check: { outcome: 'pass', summary: 'ok' },
  });
  assert.ok(done.ok);
  const next = propose(done.value, parsed(), 'session', 2);
  assert.ok(next.ok);
  assert.equal(next.value.version, 2);
  assert.equal(next.value.steps[0].status, 'done');
  assert.equal(next.value.steps[0].check?.outcome, 'pass');
  assert.equal(next.value.steps[1].status, 'approved');
  assert.equal(next.value.state, 'review');
});

await test('a changed step returns to review while unrelated ones stay', () => {
  const plan = executing();
  const changed = parsed({
    steps: [
      { id: 's1', title: 'Add stats module', detail: 'Different.', files: ['src/stats.ts'] },
      { id: 's2', title: 'Wire the CLI', detail: 'Call it.', files: ['bin/demo.ts'] },
    ],
  });
  const next = propose(plan, changed, 'session', 2);
  assert.ok(next.ok);
  assert.equal(next.value.steps[0].status, 'proposed');
  assert.equal(next.value.steps[1].status, 'approved');
});

await test('propose rejects duplicate ids and unknown dependencies', () => {
  const duplicate = parsed({
    steps: [
      { id: 's1', title: 'a', detail: '' },
      { id: 's1', title: 'b', detail: '' },
    ],
  });
  assert.deepEqual(propose(undefined, duplicate, 's', 1), {
    ok: false,
    error: 'Duplicate step id "s1". Step ids must be unique.',
  });
  const dangling = parsed({ steps: [{ id: 's1', title: 'a', detail: '', dependsOn: ['s9'] }] });
  const result = propose(undefined, dangling, 's', 1);
  assert.equal(result.ok, false);
});

await test('review applies verdicts, edits and refuses stale or empty executions', () => {
  const plan = proposed();
  const stale = review(plan, { sessionID: 'session', version: 2, action: 'revise', decisions: [] });
  assert.equal(stale.ok, false);

  const none = review(plan, {
    sessionID: 'session',
    version: 1,
    action: 'execute',
    decisions: [{ stepID: 's1', verdict: 'reject' }],
  });
  assert.deepEqual(none, {
    ok: false,
    error: 'Nothing to execute: approve at least one step that is not finished.',
  });

  const edited = review(plan, {
    sessionID: 'session',
    version: 1,
    action: 'execute',
    decisions: [{ stepID: 's1', edit: { title: 'Renamed' }, comment: 'ok' }],
  });
  assert.ok(edited.ok);
  assert.equal(edited.value.state, 'executing');
  assert.equal(edited.value.steps[0].status, 'approved');
  assert.equal(edited.value.steps[0].title, 'Renamed');
  assert.equal(edited.value.steps[1].status, 'proposed');

  const unknown = review(plan, {
    sessionID: 'session',
    version: 1,
    action: 'revise',
    decisions: [{ stepID: 'nope', verdict: 'approve' }],
  });
  assert.equal(unknown.ok, false);
});

await test('amendments inside approved files continue; new files pause the plan', () => {
  const plan = executing();
  const routine = amend(
    plan,
    AmendSchema.parse({
      reason: 'missed',
      steps: [{ id: 's3', title: 'Tweak', detail: '', files: ['src/stats.ts'] }],
    }),
    directory,
  );
  assert.ok(routine.ok);
  assert.equal(routine.value.paused, false);
  assert.equal(routine.value.plan.steps[2].status, 'approved');
  assert.equal(routine.value.plan.steps[2].origin, 'amendment');

  const wider = amend(
    plan,
    AmendSchema.parse({
      reason: 'missed',
      steps: [{ id: 's3', title: 'New area', detail: '', files: ['src/other.ts'] }],
    }),
    directory,
  );
  assert.ok(wider.ok);
  assert.equal(wider.value.paused, true);
  assert.equal(wider.value.plan.state, 'review');
  assert.equal(wider.value.plan.reviewReason, 'amendment');
  assert.equal(wider.value.plan.version, 2);

  const reused = amend(
    plan,
    AmendSchema.parse({ reason: 'x', steps: [{ id: 's1', title: 't', detail: '' }] }),
    directory,
  );
  assert.equal(reused.ok, false);

  const early = amend(
    proposed(),
    AmendSchema.parse({ reason: 'x', steps: [{ id: 's3', title: 't', detail: '' }] }),
    directory,
  );
  assert.equal(early.ok, false);
});

await test('step updates need a check to finish and pause on risky work', () => {
  const plan = executing();
  const noCheck = updateStep(plan, StepUpdateSchema.parse({ stepID: 's1', status: 'done' }));
  assert.equal(noCheck.ok, false);

  const started = updateStep(plan, { stepID: 's1', status: 'in_progress' });
  assert.ok(started.ok);
  assert.equal(started.value.state, 'executing');

  const risky = updateStep(plan, {
    stepID: 's2',
    status: 'done',
    check: { outcome: 'pass', summary: 'ok' },
  });
  assert.ok(risky.ok);
  assert.equal(risky.value.state, 'review');
  assert.equal(risky.value.reviewReason, 'checkpoint');

  const unapproved = updateStep(proposed(), { stepID: 's1', status: 'in_progress' });
  assert.equal(unapproved.ok, false);
});

await test('finishing every step ends the plan, but a failing check pauses it', () => {
  let plan = executing();
  for (const stepID of ['s1', 's2']) {
    const next = updateStep(
      plan,
      { stepID, status: 'done', check: { outcome: 'pass', summary: 'ok' } },
      'off',
    );
    assert.ok(next.ok);
    plan = next.value;
  }
  assert.equal(plan.state, 'done');

  const skipped = updateStep(executing(), { stepID: 's1', status: 'skipped' }, 'off');
  assert.ok(skipped.ok);
  const failing = updateStep(
    skipped.value,
    { stepID: 's2', status: 'done', check: { outcome: 'fail', summary: 'red' } },
    'risky',
  );
  assert.ok(failing.ok);
  assert.equal(failing.value.state, 'review');
});

await test('edits are attributed to the active step; the warning separates unapproved files', () => {
  const started = updateStep(executing(), { stepID: 's1', status: 'in_progress' });
  assert.ok(started.ok);
  const touched = recordTouch(started.value, ['/repo/src/stats.ts', '/repo/README.md'], directory);
  assert.deepEqual(touched.steps[0].touched, ['src/stats.ts', 'README.md']);
  assert.deepEqual(touched.outside, []);
  const unapproved = outsideWarning(touched, directory);
  assert.match(unapproved, /outside the approved files: README\.md\./);
  assert.doesNotMatch(unapproved, /src\/stats\.ts/);

  const idle = recordTouch(executing(), ['/repo/src/stats.ts'], directory);
  assert.deepEqual(idle.outside, ['src/stats.ts']);
  const note = outsideWarning(idle, directory);
  assert.doesNotMatch(note, /outside the approved files/);
  assert.match(note, /src\/stats\.ts changed while no step was in_progress/);
});

await test('the execute message carries the approved steps and the advisory gate', () => {
  const plan = executing();
  const message = reviewMessage(plan, {
    sessionID: 'session',
    version: 1,
    action: 'execute',
    decisions: [{ stepID: 's1', comment: 'looks fine' }],
    note: 'ship it',
  });
  assert.match(message.text, /<plan-review version="1" reason="plan" action="execute">/);
  assert.match(message.text, /> looks fine/);
  assert.match(message.text, /<approved-plan>/);
  assert.match(message.text, /sail_plan_step/);
  assert.match(message.text, /does not block edits/);
  assert.match(message.description, /→ execute/);

  const revise = reviewMessage(proposed(), {
    sessionID: 'session',
    version: 1,
    action: 'revise',
    decisions: [],
  });
  assert.doesNotMatch(revise.text, /<approved-plan>/);
  assert.match(revise.text, /sail_plan_propose/);
});

await test('leaving plan mode picks the remembered or a conventional working mode', () => {
  const option = {
    currentValue: 'plan',
    options: [{ value: 'plan' }, { value: 'default' }, { value: 'acceptEdits' }],
  };
  assert.equal(modeAfterPlan(option, 'acceptEdits'), 'acceptEdits');
  assert.equal(modeAfterPlan(option, 'gone'), 'default');
  assert.equal(modeAfterPlan(option, null), 'default');
  assert.equal(modeAfterPlan({ ...option, currentValue: 'default' }, null), null);
  assert.equal(modeAfterPlan({ currentValue: 'plan', options: [{ value: 'plan' }] }, null), null);
  assert.equal(
    modeAfterPlan({ currentValue: 'plan', options: [{ value: 'plan' }, { value: 'x' }] }, null),
    'x',
  );
});

await test('the edit tracker reports files once, after an edit completes', () => {
  const tracker = createEditTracker();
  assert.deepEqual(
    tracker.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'a',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: '/repo/src/a.ts' }],
    }),
    [],
  );
  assert.deepEqual(
    tracker.observe({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      status: 'completed',
      content: [{ type: 'diff', path: '/repo/src/b.ts' }],
    }),
    ['/repo/src/a.ts', '/repo/src/b.ts'],
  );
  assert.deepEqual(
    tracker.observe({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' }),
    [],
  );
  assert.deepEqual(
    tracker.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'r',
      kind: 'read',
      status: 'completed',
      locations: [{ path: '/repo/src/a.ts' }],
    }),
    [],
  );
  assert.deepEqual(
    tracker.observe({
      sessionUpdate: 'tool_call',
      toolCallId: 'f',
      kind: 'edit',
      status: 'failed',
      locations: [{ path: '/repo/src/a.ts' }],
    }),
    [],
  );
});

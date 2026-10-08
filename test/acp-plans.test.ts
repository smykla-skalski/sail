import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acpPlanBackend,
  createPlanStore,
  planKey,
  type PlanChange,
  type PlanScope,
  type PlanStorage,
} from '../src/lib/acp-plans.ts';

const scope: PlanScope = { agent: 'claude', directory: '/repo', sessionId: 's-1' };

function memory(initial: string | null = null): PlanStorage & { value: string | null } {
  const storage = {
    value: initial,
    read: () => storage.value,
    write: (value: string) => {
      storage.value = value;
    },
  };
  return storage;
}

function ticking() {
  let now = 1_000;
  return () => ++now;
}

const proposal = {
  title: 'Add stats',
  summary: 'Record command usage.',
  sequence: ['User->>CLI: demo greet', 'CLI-->>User: Hello'],
  overview: ['CLI[bin/demo.ts] --> Stats[src/stats.ts]'],
  steps: [
    { id: 's1', title: 'Add stats module', detail: 'Create it.', files: ['src/stats.ts'] },
    { id: 's2', title: 'Wire the CLI', detail: 'Call it.', files: ['bin/demo.ts'] },
  ],
};

const approveAll = [
  { stepID: 's1', verdict: 'approve' as const },
  { stepID: 's2', verdict: 'approve' as const },
];

await test('proposing stores a reviewable plan and tells the agent to stop', () => {
  const store = createPlanStore(memory(), ticking());
  const text = store.runTool(scope, 'sail_plan_propose', proposal);
  assert.match(text, /Plan v1 is in the user's review panel/);
  const { plan, questions } = store.snapshot(scope);
  assert.equal(plan?.version, 1);
  assert.equal(plan?.state, 'review');
  assert.equal(plan?.sessionID, 's-1');
  assert.equal(questions, null);
  assert.deepEqual(
    store.history(scope).map((item) => [item.reason, item.version]),
    [['proposed', 1]],
  );
});

await test('an invalid proposal explains the problem and stores nothing', () => {
  const store = createPlanStore(memory(), ticking());
  const text = store.runTool(scope, 'sail_plan_propose', { ...proposal, sequence: ['prose'] });
  assert.match(text, /^Plan rejected: sequence/);
  assert.equal(store.snapshot(scope).plan, null);
  assert.match(store.runTool(scope, 'sail_plan_step', { stepID: 's1', status: 'done' }), /no plan/);
  assert.match(store.runTool(scope, 'unknown', {}), /Unknown plan tool/);
});

await test('plan state and history survive a restart', () => {
  const storage = memory();
  const first = createPlanStore(storage, ticking());
  first.runTool(scope, 'sail_plan_propose', proposal);
  first.runTool(scope, 'sail_plan_ask', {
    questions: [
      { id: 'q1', question: 'Which?', kind: 'single', options: [{ value: 'a', label: 'A' }] },
    ],
  });

  const second = createPlanStore(storage, ticking());
  assert.equal(second.snapshot(scope).plan?.title, 'Add stats');
  assert.equal(second.snapshot(scope).questions?.questions[0].id, 'q1');
  assert.equal(second.history(scope).length, 1);
  assert.deepEqual(second.snapshot({ ...scope, sessionId: 'other' }), {
    plan: null,
    questions: null,
  });
});

await test('unreadable saved state is ignored instead of breaking startup', () => {
  assert.equal(createPlanStore(memory('{nope'), ticking()).snapshot(scope).plan, null);
  assert.equal(createPlanStore(memory('[{"scope":1}]'), ticking()).snapshot(scope).plan, null);
});

await test('questions are answered once and need options for choices', () => {
  const store = createPlanStore(memory(), ticking());
  assert.match(
    store.runTool(scope, 'sail_plan_ask', {
      questions: [{ id: 'q1', question: 'Which?', kind: 'single' }],
    }),
    /need options/,
  );
  store.runTool(scope, 'sail_plan_ask', {
    questions: [
      { id: 'q1', question: 'Which?', kind: 'single', options: [{ value: 'a', label: 'Alpha' }] },
    ],
  });
  const pending = store.snapshot(scope).questions;
  assert.ok(pending);
  const answered = store.applyAnswers(scope, {
    sessionID: 's-1',
    id: pending.id,
    answers: { q1: ['a'] },
  });
  assert.ok(answered.ok);
  assert.match(answered.value.text, /Which\?\n {2}→ Alpha/);
  assert.equal(store.snapshot(scope).questions, null);
  const again = store.applyAnswers(scope, { sessionID: 's-1', id: pending.id, answers: {} });
  assert.deepEqual(again, { ok: false, error: 'These questions are no longer pending.' });
});

await test('a new proposal replaces pending questions', () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_ask', {
    questions: [{ id: 'q1', question: 'Why?', kind: 'text' }],
  });
  store.runTool(scope, 'sail_plan_propose', proposal);
  assert.equal(store.snapshot(scope).questions, null);
});

await test('executing a plan follows steps, checkpoints and a final digest', () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  const reviewed = store.applyReview(scope, {
    sessionID: 's-1',
    version: 1,
    action: 'execute',
    decisions: approveAll,
  });
  assert.ok(reviewed.ok);
  assert.equal(reviewed.value.plan.state, 'executing');

  assert.equal(
    store.runTool(scope, 'sail_plan_step', { stepID: 's1', status: 'in_progress' }),
    's1 → in_progress',
  );
  assert.match(
    store.runTool(scope, 'sail_plan_step', { stepID: 's1', status: 'done' }),
    /done with check/,
  );
  store.runTool(scope, 'sail_plan_step', {
    stepID: 's1',
    status: 'done',
    check: JSON.stringify({ outcome: 'pass', summary: 'tests pass' }),
  });
  const last = store.runTool(scope, 'sail_plan_step', {
    stepID: 's2',
    status: 'done',
    check: { outcome: 'pass', summary: 'ok' },
  });
  assert.match(last, /All approved steps are finished/);
  assert.equal(store.snapshot(scope).plan?.state, 'done');
  assert.deepEqual(
    store.history(scope).map((item) => item.reason),
    ['proposed', 'reviewed', 'step', 'step', 'done'],
  );
  const review = store.history(scope)[1].review;
  assert.equal(review?.action, 'execute');
});

await test('amendments that need approval pause the plan and bump the version', () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  store.applyReview(scope, {
    sessionID: 's-1',
    version: 1,
    action: 'execute',
    decisions: approveAll,
  });
  const paused = store.runTool(scope, 'sail_plan_amend', {
    reason: 'Found a gap',
    steps: [{ id: 's3', title: 'Docs', detail: 'Write them.', files: ['README.md'] }],
  });
  assert.match(paused, /need the user's approval/);
  assert.equal(store.snapshot(scope).plan?.version, 2);
  assert.equal(store.snapshot(scope).plan?.reviewReason, 'amendment');
  assert.match(
    store.runTool(scope, 'sail_plan_step', { stepID: 's1', status: 'in_progress' }),
    /not executing/,
  );
});

await test('completed edits are flagged to the agent and kept for the user', () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  store.applyReview(scope, {
    sessionID: 's-1',
    version: 1,
    action: 'execute',
    decisions: approveAll,
  });
  store.runTool(scope, 'sail_plan_step', { stepID: 's1', status: 'in_progress' });

  const changes: PlanChange[] = [];
  store.subscribe((change) => changes.push(change));
  store.observe(scope, {
    sessionUpdate: 'tool_call',
    toolCallId: 'e1',
    kind: 'edit',
    status: 'completed',
    locations: [{ path: '/repo/src/stats.ts' }, { path: '/repo/package.json' }],
  });
  const plan = store.snapshot(scope).plan;
  assert.deepEqual(plan?.steps[0].touched, ['src/stats.ts', 'package.json']);
  assert.equal(changes.length, 1);

  const result = store.runTool(scope, 'sail_plan_step', {
    stepID: 's1',
    status: 'blocked',
    note: 'x',
  });
  assert.match(result, /Warning: edited outside the approved files: package\.json/);
  assert.doesNotMatch(result, /src\/stats\.ts/);
  assert.match(result, /Sail does not block edits/);
});

await test('edits are ignored unless the plan is executing', () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  store.observe(scope, {
    sessionUpdate: 'tool_call',
    toolCallId: 'e1',
    kind: 'edit',
    status: 'completed',
    locations: [{ path: '/repo/src/stats.ts' }],
  });
  assert.deepEqual(store.snapshot(scope).plan?.outside, []);
});

await test('the panel backend reviews through the store and resumes the session', async () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  const sent: { text: string; leavePlanMode: boolean }[] = [];
  const backend = acpPlanBackend(store, scope, {
    send: async (text, options) => {
      sent.push({ text, ...options });
    },
  });
  const plan = (await backend.latest(scope.sessionId)).plan;
  assert.ok(plan);
  await backend.review(plan, 'revise', [{ stepID: 's1', verdict: 'revise', comment: 'split it' }]);
  assert.equal(sent[0].leavePlanMode, false);
  assert.match(sent[0].text, /action="revise"/);
  assert.match(sent[0].text, /> split it/);

  store.runTool(scope, 'sail_plan_propose', proposal);
  const next = store.snapshot(scope).plan;
  assert.ok(next);
  await backend.review(next, 'execute', approveAll);
  assert.equal(sent[1].leavePlanMode, true);
  assert.match(sent[1].text, /<approved-plan>/);
  assert.equal(store.snapshot(scope).plan?.state, 'executing');
});

await test('a review the agent never received is rolled back for another try', async () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  const backend = acpPlanBackend(store, scope, {
    send: async () => {
      throw new Error('Wait for the current agent turn.');
    },
  });
  const plan = store.snapshot(scope).plan;
  assert.ok(plan);
  await assert.rejects(
    backend.review(plan, 'execute', approveAll),
    /Wait for the current agent turn/,
  );
  assert.equal(store.snapshot(scope).plan?.state, 'review');
  assert.equal(store.snapshot(scope).plan?.steps[0].status, 'proposed');
  assert.deepEqual(
    store.history(scope).map((item) => item.reason),
    ['proposed'],
  );

  store.runTool(scope, 'sail_plan_ask', {
    questions: [{ id: 'q1', question: 'Why?', kind: 'text' }],
  });
  const questions = store.snapshot(scope).questions;
  assert.ok(questions);
  await assert.rejects(backend.answer(scope.sessionId, questions.id, { q1: ['because'] }), /Wait/);
  assert.equal(store.snapshot(scope).questions?.id, questions.id);
});

await test('a review the agent already acted on is not rolled back when the turn is cut short', async () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  const backend = acpPlanBackend(store, scope, {
    send: async () => {
      store.runTool(scope, 'sail_plan_step', { stepID: 's1', status: 'in_progress' });
      throw new Error('Agent turn was cancelled.');
    },
  });
  const plan = store.snapshot(scope).plan;
  assert.ok(plan);
  await assert.rejects(backend.review(plan, 'execute', approveAll), /cancelled/);
  const kept = store.snapshot(scope).plan;
  assert.equal(kept?.state, 'executing');
  assert.equal(kept?.steps[0].status, 'in_progress');
});

await test('a failed answer keeps earlier history entries', async () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  const ok = acpPlanBackend(store, scope, { send: async () => {} });
  const plan = store.snapshot(scope).plan;
  assert.ok(plan);
  await ok.review(plan, 'revise', []);
  store.runTool(scope, 'sail_plan_ask', {
    questions: [{ id: 'q1', question: 'Why?', kind: 'text' }],
  });
  const questions = store.snapshot(scope).questions;
  assert.ok(questions);
  const failing = acpPlanBackend(store, scope, {
    send: async () => {
      throw new Error('Wait for the current agent turn.');
    },
  });
  await assert.rejects(failing.answer(scope.sessionId, questions.id, { q1: ['x'] }), /Wait/);
  assert.deepEqual(
    store.history(scope).map((item) => item.reason),
    ['proposed', 'reviewed'],
  );
});

await test('stale reviews are refused', async () => {
  const store = createPlanStore(memory(), ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  const backend = acpPlanBackend(store, scope, { send: async () => {} });
  const first = store.snapshot(scope).plan;
  assert.ok(first);
  store.runTool(scope, 'sail_plan_propose', proposal);
  await assert.rejects(backend.review(first, 'revise', []), /plan is at v2/);
});

await test('only the newest sessions are kept and forgetting removes one', () => {
  const storage = memory();
  const store = createPlanStore(storage, ticking());
  for (let index = 0; index < 55; index += 1)
    store.runTool({ ...scope, sessionId: `s-${index}` }, 'sail_plan_propose', proposal);
  assert.equal(JSON.parse(storage.value ?? '[]').length, 50);
  assert.equal(store.snapshot({ ...scope, sessionId: 's-0' }).plan, null);
  assert.ok(store.snapshot({ ...scope, sessionId: 's-54' }).plan);
  store.forget({ ...scope, sessionId: 's-54' });
  assert.equal(store.snapshot({ ...scope, sessionId: 's-54' }).plan, null);
  assert.notEqual(planKey(scope), planKey({ ...scope, agent: 'codex' }));
});

await test('saved state stays small enough for the settings quota', () => {
  const storage = memory();
  const store = createPlanStore(storage, ticking());
  const big = {
    ...proposal,
    steps: Array.from({ length: 8 }, (_, index) => ({
      id: `s${index}`,
      title: `Step ${index}`,
      detail: 'x'.repeat(600),
      files: [`src/f${index}.ts`],
    })),
  };
  for (let session = 0; session < 40; session += 1) {
    const where = { ...scope, sessionId: `big-${session}` };
    store.runTool(where, 'sail_plan_propose', big);
    store.applyReview(where, {
      sessionID: where.sessionId,
      version: 1,
      action: 'execute',
      decisions: big.steps.map((step) => ({ stepID: step.id, verdict: 'approve' as const })),
    });
    for (const step of big.steps) {
      store.runTool(where, 'sail_plan_step', { stepID: step.id, status: 'in_progress' });
      store.runTool(where, 'sail_plan_step', {
        stepID: step.id,
        status: 'done',
        check: { outcome: 'pass', summary: 'ok' },
      });
    }
  }
  assert.ok((storage.value ?? '').length <= 400_000);
  const newest = { ...scope, sessionId: 'big-39' };
  assert.equal(store.snapshot(newest).plan?.state, 'done');
  assert.ok(store.history(newest).length > 0);
});

await test('a failing storage write falls back to a smaller value', () => {
  let attempts = 0;
  const storage: PlanStorage = {
    read: () => null,
    write: (value) => {
      attempts += 1;
      if (attempts === 1) throw new Error('QuotaExceededError');
      assert.ok(value.length > 0);
    },
  };
  const store = createPlanStore(storage, ticking());
  store.runTool(scope, 'sail_plan_propose', proposal);
  assert.equal(attempts, 2);
  assert.ok(store.snapshot(scope).plan);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasPendingPlanReview,
  revealsNativePlanReview,
  revealsPlanReview,
} from '../src/lib/details-plan.ts';
import type { NativePlan } from '../src/lib/native-plan.ts';
import { createPlanStore } from '../src/lib/acp-plans.ts';

void test('restored structured reviews remain discoverable without a live event', () => {
  let saved: string | null = null;
  const storage = {
    read: () => saved,
    write: (value: string) => {
      saved = value;
    },
  };
  const scope = { agent: 'codex', directory: '/repo', sessionId: 'existing-thread' };
  const store = createPlanStore(storage);
  assert.equal(hasPendingPlanReview(store.snapshot(scope)), false);
  store.runTool(scope, 'sail_plan_propose', {
    title: 'Replacement plan',
    summary: 'Resume work',
    sequence: ['User->>Agent: Resume', 'Agent-->>User: Plan'],
    overview: ['Review --> Execute'],
    steps: [{ id: 'resume', title: 'Resume', detail: 'Continue', files: [] }],
  });
  assert.equal(hasPendingPlanReview(createPlanStore(storage).snapshot(scope)), true);
  store.applyReview(scope, {
    sessionID: scope.sessionId,
    version: 1,
    action: 'execute',
    decisions: [{ stepID: 'resume', verdict: 'approve' }],
  });
  assert.equal(hasPendingPlanReview(createPlanStore(storage).snapshot(scope)), false);
  store.runTool(scope, 'sail_plan_ask', {
    questions: [{ id: 'q', question: 'Continue?', kind: 'confirm' }],
  });
  assert.equal(hasPendingPlanReview(createPlanStore(storage).snapshot(scope)), true);
  assert.equal(
    hasPendingPlanReview(
      createPlanStore(storage).snapshot({ ...scope, sessionId: 'other-thread' }),
    ),
    false,
  );
});

void test('plan progress and completion preserve the selected details tab', () => {
  assert.equal(revealsPlanReview('step'), false);
  assert.equal(revealsPlanReview('done'), false);
  assert.equal(revealsPlanReview('reviewed'), false);
  assert.equal(revealsPlanReview('answered'), false);
});

void test('required plan decisions reveal the review panel', () => {
  assert.equal(revealsPlanReview('proposed'), true);
  assert.equal(revealsPlanReview('questions'), true);
  assert.equal(revealsPlanReview('amended'), true);
  assert.equal(revealsPlanReview('checkpoint'), true);
});

void test('native progress and restored plans preserve manual selection', () => {
  const plan: NativePlan = { provider: 'codex', markdown: 'Step 1', tasks: [], updated: 1 };
  assert.equal(revealsNativePlanReview(plan, null, true), false);
  assert.equal(revealsNativePlanReview({ ...plan, provider: 'opencode' }, null, true), false);
  assert.equal(revealsNativePlanReview({ ...plan, provider: 'claude' }, null, false), false);
});

void test('live Claude plan review reveals each newly submitted plan', () => {
  const plan: NativePlan = { provider: 'claude', markdown: 'Initial plan', tasks: [], updated: 1 };
  assert.equal(revealsNativePlanReview(plan, null, true), true);
  assert.equal(revealsNativePlanReview({ ...plan, updated: 2 }, plan, true), false);
  assert.equal(revealsNativePlanReview({ ...plan, markdown: 'Revised plan' }, plan, true), true);
});

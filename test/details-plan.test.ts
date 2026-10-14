import assert from 'node:assert/strict';
import test from 'node:test';
import { revealsNativePlanReview, revealsPlanReview } from '../src/lib/details-plan.ts';
import type { NativePlan } from '../src/lib/native-plan.ts';

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

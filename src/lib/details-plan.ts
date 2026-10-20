import type { PlanChange } from './acp-plans';
import type { NativePlan } from './native-plan';
import type { PlanSnapshot } from './plan';

export function hasPendingPlanReview(snapshot: PlanSnapshot): boolean {
  return !!snapshot.questions || snapshot.plan?.state === 'review';
}

export function revealsPlanReview(reason: PlanChange['reason']): boolean {
  return ['proposed', 'questions', 'amended', 'checkpoint'].includes(reason);
}

export function revealsNativePlanReview(
  plan: NativePlan | null,
  previous: NativePlan | null,
  live: boolean,
): boolean {
  return live && plan?.provider === 'claude' && plan.markdown !== previous?.markdown;
}

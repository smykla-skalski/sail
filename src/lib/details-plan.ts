import type { PlanChange } from './acp-plans';
import type { NativePlan } from './native-plan';

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

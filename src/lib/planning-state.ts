import { getSetting, setSetting } from './settings.ts';
import type { NativePlan } from './native-plan.ts';

const storageKey = 'sai-planning-state';
const limit = 100;

export type PlanningStateScope = {
  agent: string;
  directory: string;
  sessionId: string;
};

type SavedNativePlan = PlanningStateScope & { plan: NativePlan };

function id(scope: PlanningStateScope): string {
  return JSON.stringify([scope.agent, scope.directory, scope.sessionId]);
}

function savedPlans(): SavedNativePlan[] {
  try {
    const parsed: unknown = JSON.parse(getSetting(storageKey) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedNativePlan =>
        !!item &&
        typeof item === 'object' &&
        typeof item.agent === 'string' &&
        typeof item.directory === 'string' &&
        typeof item.sessionId === 'string' &&
        !!item.plan &&
        typeof item.plan === 'object' &&
        (item.plan.provider === 'claude' || item.plan.provider === 'codex') &&
        typeof item.plan.markdown === 'string' &&
        typeof item.plan.updated === 'number' &&
        Array.isArray(item.plan.tasks),
    );
  } catch {
    return [];
  }
}

function save(plans: SavedNativePlan[]): void {
  setSetting(storageKey, JSON.stringify(plans.slice(-limit)));
}

export function loadNativePlan(scope: PlanningStateScope): NativePlan | null {
  return savedPlans().find((item) => id(item) === id(scope))?.plan ?? null;
}

export function saveNativePlan(scope: PlanningStateScope, plan: NativePlan | null): void {
  const plans = savedPlans().filter((item) => id(item) !== id(scope));
  if (plan) plans.push({ ...scope, plan });
  save(plans);
}

export function forgetPlanningState(scope: PlanningStateScope): void {
  save(savedPlans().filter((item) => id(item) !== id(scope)));
}

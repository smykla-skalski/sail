import { getSetting, setSetting } from './settings.ts';
import type { NativePlan } from './native-plan.ts';

const storageKey = 'sai-planning-state';
const limit = 100;

export type PlanningStateScope = {
  agent: string;
  directory: string;
  sessionId: string;
};

export type StructuredQuestion = {
  id: string | number;
  sessionId: string;
  message: string;
  schema: Record<string, unknown>;
};

type SavedPlanningState = PlanningStateScope & {
  plan?: NativePlan;
  questions?: StructuredQuestion[];
};

function id(scope: PlanningStateScope): string {
  return JSON.stringify([scope.agent, scope.directory, scope.sessionId]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function savedStates(): SavedPlanningState[] {
  try {
    const parsed: unknown = JSON.parse(getSetting(storageKey) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedPlanningState =>
        !!item &&
        typeof item === 'object' &&
        typeof item.agent === 'string' &&
        typeof item.directory === 'string' &&
        typeof item.sessionId === 'string' &&
        (!item.plan || validPlan(item.plan)) &&
        (!item.questions || item.questions.every(validQuestion)),
    );
  } catch {
    return [];
  }
}

function validPlan(plan: unknown): plan is NativePlan {
  const value = record(plan);
  return (
    !!value &&
    (value.provider === 'claude' || value.provider === 'codex' || value.provider === 'opencode') &&
    typeof value.markdown === 'string' &&
    typeof value.updated === 'number' &&
    Array.isArray(value.tasks)
  );
}

function validQuestion(question: unknown): question is StructuredQuestion {
  const value = record(question);
  return (
    !!value &&
    (typeof value.id === 'string' || typeof value.id === 'number') &&
    typeof value.sessionId === 'string' &&
    typeof value.message === 'string' &&
    !!record(value.schema)
  );
}

function save(states: SavedPlanningState[]): void {
  setSetting(storageKey, JSON.stringify(states.slice(-limit)));
}

function stateFor(scope: PlanningStateScope): SavedPlanningState | undefined {
  return savedStates().find((item) => id(item) === id(scope));
}

function update(scope: PlanningStateScope, changes: Partial<SavedPlanningState>): void {
  const states = savedStates().filter((item) => id(item) !== id(scope));
  const next = { ...stateFor(scope), ...scope, ...changes };
  if (next.plan || next.questions?.length) states.push(next);
  save(states);
}

export function loadNativePlan(scope: PlanningStateScope): NativePlan | null {
  return stateFor(scope)?.plan ?? null;
}

export function saveNativePlan(scope: PlanningStateScope, plan: NativePlan | null): void {
  update(scope, { plan: plan ?? undefined });
}

export function loadStructuredQuestions(scope: PlanningStateScope): StructuredQuestion[] {
  return stateFor(scope)?.questions ?? [];
}

export function saveStructuredQuestions(
  scope: PlanningStateScope,
  questions: StructuredQuestion[],
): void {
  update(scope, { questions });
}

export function removeStructuredQuestion(agent: string, requestID: string | number): void {
  const states = savedStates().flatMap((state) => {
    if (
      state.agent !== agent ||
      !state.questions?.some((item) => String(item.id) === String(requestID))
    )
      return [state];
    const questions = state.questions.filter((item) => String(item.id) !== String(requestID));
    return state.plan || questions.length ? [{ ...state, questions }] : [];
  });
  save(states);
}

export function clearStructuredQuestions(agent: string, sessionId: string): void {
  const states = savedStates().flatMap((state) => {
    if (state.agent !== agent || state.sessionId !== sessionId) return [state];
    return state.plan ? [{ ...state, questions: [] }] : [];
  });
  save(states);
}

export function forgetPlanningState(scope: PlanningStateScope): void {
  save(savedStates().filter((item) => id(item) !== id(scope)));
}

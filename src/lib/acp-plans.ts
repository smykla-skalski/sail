import { z } from 'zod';
import { getSetting, setSetting } from './settings.ts';
import {
  HistoryEntrySchema,
  PlanQuestionsSchema,
  PlanSchema,
  type HistoryEntry,
  type Plan,
  type PlanBackend,
  type PlanSnapshot,
} from './plan.ts';
import {
  AmendSchema,
  PLAN_TOOLS,
  ProposeInputSchema,
  QuestionsInputSchema,
  StepUpdateSchema,
  amend,
  answersMessage,
  createEditTracker,
  describeIssues,
  digestMarkdown,
  outsideWarning,
  planMarkdown,
  propose,
  recordTouch,
  review,
  reviewMessage,
  updateStep,
  type PlanAnswers,
  type PlanReview,
  type Result,
} from './plan-engine.ts';

/** Plan state for ACP agents, persisted per session so a pending review survives a restart. */

export type PlanScope = { agent: string; directory: string; sessionId: string };

export type PlanChange = {
  scope: PlanScope;
  reason:
    'proposed' | 'reviewed' | 'step' | 'questions' | 'answered' | 'amended' | 'checkpoint' | 'done';
};

export interface PlanStorage {
  read(): string | null;
  write(value: string): void;
}

const storageKey = 'sai-acp-plans';
const sessionLimit = 50;
const historyLimit = 200;
const storageBudget = 400_000;
const PAUSED = "The plan is paused for the user's review. End your turn now.";

const SavedSchema = z.object({
  scope: z.object({ agent: z.string(), directory: z.string(), sessionId: z.string() }),
  plan: PlanSchema.nullable(),
  questions: PlanQuestionsSchema.nullable(),
  history: z.array(HistoryEntrySchema),
  nextHistoryId: z.number().int().positive(),
  updated: z.number(),
});

type Saved = z.infer<typeof SavedSchema>;

export function planKey(scope: PlanScope): string {
  return JSON.stringify([scope.agent, scope.directory, scope.sessionId]);
}

export const settingsPlanStorage: PlanStorage = {
  read: () => getSetting(storageKey),
  write: (value) => setSetting(storageKey, value),
};

function load(storage: PlanStorage): Map<string, Saved> {
  const sessions = new Map<string, Saved>();
  try {
    const parsed: unknown = JSON.parse(storage.read() ?? '[]');
    if (!Array.isArray(parsed)) return sessions;
    for (const item of parsed) {
      const saved = SavedSchema.safeParse(item);
      if (saved.success) sessions.set(planKey(saved.data.scope), saved.data);
    }
  } catch {
    return sessions;
  }
  return sessions;
}

const empty = (scope: PlanScope, now: number): Saved => ({
  scope,
  plan: null,
  questions: null,
  history: [],
  nextHistoryId: 1,
  updated: now,
});

const size = (items: Saved[]) => JSON.stringify(items).length;

/**
 * Settings are mirrored in localStorage, whose quota is a few megabytes shared with every other
 * setting; an oversized value makes the next startup fail to load them all. Older history goes
 * first, then older sessions, and the newest session always keeps its plan.
 */
function fitBudget(items: Saved[], budget = storageBudget): Saved[] {
  let fitted = items;
  for (let index = fitted.length - 1; index >= 0 && size(fitted) > budget; index -= 1) {
    fitted = fitted.map((item, at) =>
      at === index ? { ...item, history: item.history.slice(-3) } : item,
    );
  }
  while (fitted.length > 1 && size(fitted) > budget) fitted = fitted.slice(0, -1);
  if (size(fitted) > budget)
    fitted = fitted.map((item) => ({ ...item, history: item.history.slice(-1) }));
  return fitted;
}

export function createPlanStore(storage: PlanStorage, clock: () => number = Date.now) {
  const sessions = load(storage);
  const listeners = new Set<(change: PlanChange) => void>();
  const trackers = new Map<string, ReturnType<typeof createEditTracker>>();

  function persist() {
    let newest = [...sessions.values()]
      .filter((item) => item.plan || item.questions)
      .toSorted((a, b) => b.updated - a.updated)
      .slice(0, sessionLimit);
    newest = fitBudget(newest);
    sessions.clear();
    for (const item of newest) sessions.set(planKey(item.scope), item);
    try {
      storage.write(JSON.stringify(newest));
    } catch {
      storage.write(JSON.stringify(fitBudget(newest, storageBudget / 4)));
    }
  }

  function entry(scope: PlanScope): Saved {
    return sessions.get(planKey(scope)) ?? empty(scope, clock());
  }

  function announce(scope: PlanScope, reason: PlanChange['reason']) {
    for (const listener of listeners) listener({ scope, reason });
  }

  function save(
    saved: Saved,
    reason: PlanChange['reason'],
    record?: HistoryEntry['review'],
  ): number | null {
    const now = clock();
    const recorded = saved.plan && reason !== 'questions' && reason !== 'answered';
    const history =
      recorded && saved.plan
        ? [
            ...saved.history,
            {
              id: saved.nextHistoryId,
              at: now,
              reason: historyReason(reason),
              version: saved.plan.version,
              plan: saved.plan,
              ...(record ? { review: record } : {}),
            } satisfies HistoryEntry,
          ].slice(-historyLimit)
        : saved.history;
    sessions.set(planKey(saved.scope), {
      ...saved,
      history,
      nextHistoryId: recorded ? saved.nextHistoryId + 1 : saved.nextHistoryId,
      updated: now,
    });
    persist();
    announce(saved.scope, reason);
    return recorded ? saved.nextHistoryId : null;
  }

  const snapshot = (scope: PlanScope): PlanSnapshot => {
    const saved = sessions.get(planKey(scope));
    return { plan: saved?.plan ?? null, questions: saved?.questions ?? null };
  };

  function proposeTool(scope: PlanScope, saved: Saved, args: unknown): string {
    const input = ProposeInputSchema.safeParse(args);
    if (!input.success) return `Plan rejected: ${describeIssues(input.error)}`;
    const next = propose(saved.plan ?? undefined, input.data, scope.sessionId, clock());
    if (!next.ok) return `Plan rejected: ${next.error}`;
    save({ ...saved, plan: next.value, questions: null }, 'proposed');
    return `${planMarkdown(next.value)}\n\nPlan v${next.value.version} is in the user's review panel. End your turn now.`;
  }

  function askTool(scope: PlanScope, saved: Saved, args: unknown): string {
    const input = QuestionsInputSchema.safeParse(args);
    if (!input.success) return `Questions rejected: ${describeIssues(input.error)}`;
    const invalid = input.data.questions.filter(
      (question) =>
        question.kind !== 'text' && question.kind !== 'confirm' && !question.options?.length,
    );
    if (invalid.length)
      return `Questions ${invalid.map((question) => question.id).join(', ')} need options.`;
    save(
      {
        ...saved,
        questions: {
          questions: input.data.questions,
          id: `q${clock()}`,
          sessionID: scope.sessionId,
        },
      },
      'questions',
    );
    return "The questions are in the user's review panel. End your turn and wait for <plan-answers>.";
  }

  function stepTool(scope: PlanScope, saved: Saved, args: unknown): string {
    const input = StepUpdateSchema.safeParse(args);
    if (!input.success) return `Step update rejected: ${describeIssues(input.error)}`;
    if (!saved.plan) return 'There is no plan in this session.';
    const next = updateStep(saved.plan, input.data);
    if (!next.ok) return next.error;
    const plan = next.value;
    save(
      { ...saved, plan },
      plan.state === 'done' ? 'done' : plan.state === 'review' ? 'checkpoint' : 'step',
    );
    const warning = outsideWarning(plan, scope.directory);
    const suffix = warning ? `\n\n${warning}` : '';
    if (plan.state === 'done')
      return `All approved steps are finished.\n\n${digestMarkdown(plan, scope.directory)}${suffix}`;
    const status = `${input.data.stepID} → ${input.data.status}`;
    return plan.state === 'review'
      ? `${status}. Checkpoint: ${PAUSED}${suffix}`
      : `${status}${suffix}`;
  }

  function amendTool(scope: PlanScope, saved: Saved, args: unknown): string {
    const input = AmendSchema.safeParse(args);
    if (!input.success) return `Amendment rejected: ${describeIssues(input.error)}`;
    if (!saved.plan) return `There is no plan in this session; use ${PLAN_TOOLS.propose}.`;
    const next = amend(saved.plan, input.data, scope.directory);
    if (!next.ok) return next.error;
    save({ ...saved, plan: next.value.plan }, next.value.paused ? 'amended' : 'step');
    const ids = input.data.steps.map((added) => added.id).join(', ');
    return next.value.paused
      ? `Added ${ids}; some need the user's approval. ${PAUSED}`
      : `Added ${ids}, approved automatically because they stay within approved files. Continue.`;
  }

  /** Runs one agent tool call and returns the text the agent reads. */
  function runTool(scope: PlanScope, name: string, args: unknown): string {
    const saved = entry(scope);
    if (name === PLAN_TOOLS.propose) return proposeTool(scope, saved, args);
    if (name === PLAN_TOOLS.ask) return askTool(scope, saved, args);
    if (name === PLAN_TOOLS.step) return stepTool(scope, saved, args);
    if (name === PLAN_TOOLS.amend) return amendTool(scope, saved, args);
    return `Unknown plan tool ${name}.`;
  }

  /** Applies the user's review and returns the message that resumes the agent. */
  function applyReview(
    scope: PlanScope,
    input: PlanReview,
  ): Result<{ plan: Plan; historyId: number | null; text: string; description: string }> {
    const saved = entry(scope);
    if (!saved.plan) return { ok: false, error: 'No plan for this session.' };
    const next = review(saved.plan, input);
    if (!next.ok) return next;
    const historyId = save({ ...saved, plan: next.value }, 'reviewed', input);
    return {
      ok: true,
      value: { plan: next.value, historyId, ...reviewMessage(next.value, input) },
    };
  }

  function applyAnswers(
    scope: PlanScope,
    input: PlanAnswers,
  ): Result<{ text: string; description: string }> {
    const saved = entry(scope);
    if (!saved.questions || saved.questions.id !== input.id)
      return { ok: false, error: 'These questions are no longer pending.' };
    const message = answersMessage(saved.questions, input);
    save({ ...saved, questions: null }, 'answered');
    return { ok: true, value: message };
  }

  /**
   * Puts back the state from before a review whose prompt failed. Once the agent has acted on the
   * review, its own tool calls changed the state and nothing is rolled back.
   */
  function revert(
    scope: PlanScope,
    before: PlanSnapshot,
    applied: PlanSnapshot,
    historyId: number | null,
  ) {
    if (JSON.stringify(snapshot(scope)) !== JSON.stringify(applied)) return;
    const saved = entry(scope);
    sessions.set(planKey(scope), {
      ...saved,
      plan: before.plan,
      questions: before.questions,
      history: saved.history.filter((item) => item.id !== historyId),
      updated: clock(),
    });
    persist();
    announce(scope, 'step');
  }

  /** Feeds ACP session updates; completed edits are recorded against the executing plan. */
  function observe(scope: PlanScope, update: unknown) {
    const key = planKey(scope);
    const tracker = trackers.get(key) ?? createEditTracker();
    trackers.set(key, tracker);
    const files = tracker.observe(update);
    const saved = sessions.get(key);
    if (!files.length || saved?.plan?.state !== 'executing') return;
    const plan = recordTouch(saved.plan, files, scope.directory);
    if (JSON.stringify(plan) === JSON.stringify(saved.plan)) return;
    sessions.set(key, { ...saved, plan, updated: clock() });
    persist();
    announce(scope, 'step');
  }

  return {
    snapshot,
    history: (scope: PlanScope): HistoryEntry[] => sessions.get(planKey(scope))?.history ?? [],
    runTool,
    applyReview,
    applyAnswers,
    revert,
    observe,
    forget(scope: PlanScope) {
      trackers.delete(planKey(scope));
      if (sessions.delete(planKey(scope))) persist();
    },
    subscribe(listener: (change: PlanChange) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function historyReason(reason: PlanChange['reason']): HistoryEntry['reason'] {
  switch (reason) {
    case 'proposed':
    case 'reviewed':
    case 'amended':
    case 'checkpoint':
    case 'done':
      return reason;
    default:
      return 'step';
  }
}

export type PlanStore = ReturnType<typeof createPlanStore>;

let shared: PlanStore | undefined;

/** The app-wide store, created on first use so the settings are loaded by then. */
export function acpPlans(): PlanStore {
  shared ??= createPlanStore(settingsPlanStorage);
  return shared;
}

export interface PlanDelivery {
  /** Sends the text to the agent session as a prompt; `leavePlanMode` first switches the session out of plan mode. */
  send(text: string, options: { leavePlanMode: boolean }): Promise<void>;
}

/** The plan panel's route to an ACP agent: state in the store, resumption by a prompt to the session. */
export function acpPlanBackend(
  store: PlanStore,
  scope: PlanScope,
  delivery: PlanDelivery,
): PlanBackend {
  return {
    latest: async () => store.snapshot(scope),
    review: async (plan, action, decisions, note) => {
      const before = store.snapshot(scope);
      const result = store.applyReview(scope, {
        sessionID: plan.sessionID,
        version: plan.version,
        action,
        decisions,
        ...(note === undefined ? {} : { note }),
      });
      if (!result.ok) throw new Error(result.error);
      const applied = store.snapshot(scope);
      try {
        await delivery.send(result.value.text, { leavePlanMode: action === 'execute' });
      } catch (cause) {
        store.revert(scope, before, applied, result.value.historyId);
        throw cause;
      }
    },
    answer: async (_sessionID, id, answers) => {
      const before = store.snapshot(scope);
      const result = store.applyAnswers(scope, { sessionID: scope.sessionId, id, answers });
      if (!result.ok) throw new Error(result.error);
      const applied = store.snapshot(scope);
      try {
        await delivery.send(result.value.text, { leavePlanMode: false });
      } catch (cause) {
        store.revert(scope, before, applied, null);
        throw cause;
      }
    },
  };
}

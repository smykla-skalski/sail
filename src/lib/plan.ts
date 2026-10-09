import { z } from 'zod';

const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  rationale: z.string().optional(),
  files: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
  dependsOn: z.array(z.string()).optional(),
  diagram: z.string().optional(),
  needsYou: z.string().optional(),
  status: z.enum([
    'proposed',
    'approved',
    'rejected',
    'revise',
    'in_progress',
    'done',
    'blocked',
    'skipped',
  ]),
  comment: z.string().optional(),
  note: z.string().optional(),
  origin: z.enum(['plan', 'amendment']).default('plan'),
  touched: z.array(z.string()).default([]),
  check: z
    .object({
      outcome: z.enum(['pass', 'fail', 'none']),
      summary: z.string(),
      command: z.string().optional(),
    })
    .optional(),
});

export const PlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  diagram: z.string().optional(),
  sequence: z.string().optional(),
  diagrams: z.array(z.object({ title: z.string(), source: z.string() })).optional(),
  alternatives: z
    .array(
      z.object({
        name: z.string(),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
        chosen: z.boolean(),
      }),
    )
    .optional(),
  steps: z.array(PlanStepSchema),
  sessionID: z.string(),
  version: z.number(),
  state: z.enum(['review', 'executing', 'done']),
  reviewReason: z.enum(['plan', 'amendment', 'checkpoint']).default('plan'),
  outside: z.array(z.string()).default([]),
  createdAt: z.number(),
});

const PlanQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  kind: z.enum(['text', 'single', 'multi', 'confirm']),
  options: z
    .array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  recommended: z.array(z.string()).optional(),
});

export const PlanQuestionsSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  questions: z.array(PlanQuestionSchema),
});

export const HistoryEntrySchema = z.object({
  id: z.number().int().positive(),
  at: z.number(),
  reason: z.enum(['proposed', 'reviewed', 'amended', 'step', 'checkpoint', 'done', 'touch']),
  version: z.number().int().positive(),
  plan: PlanSchema,
  review: z
    .object({
      sessionID: z.string(),
      version: z.number(),
      action: z.enum(['revise', 'execute']),
      decisions: z.array(
        z.object({
          stepID: z.string(),
          verdict: z.enum(['approve', 'reject', 'revise']).optional(),
          comment: z.string().optional(),
          edit: z
            .object({ title: z.string().optional(), detail: z.string().optional() })
            .optional(),
        }),
      ),
      note: z.string().optional(),
    })
    .optional(),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;
export type PlanQuestions = z.infer<typeof PlanQuestionsSchema>;
export type PlanSnapshot = { plan: Plan | null; questions: PlanQuestions | null };
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

function relativeFile(file: string, directory: string): string {
  const target = file.replaceAll('\\', '/').replaceAll(/\/+/g, '/');
  const root = directory.replaceAll('\\', '/').replaceAll(/\/+/g, '/').replace(/\/$/, '');
  if (target.startsWith('/') || /^[A-Za-z]:\//.test(target)) {
    const windows = /^[A-Za-z]:\//.test(target);
    const matches = windows
      ? target.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      : target.startsWith(`${root}/`);
    return matches ? target.slice(root.length + 1) : '../outside';
  }
  return target.replace(/^\.\//, '');
}

function escapePattern(value: string) {
  return value.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function coveredFile(file: string, approved: string[], directory: string): boolean {
  const target = relativeFile(file, directory);
  if (target.startsWith('../')) return false;
  return approved.some((entry) => {
    const listed = relativeFile(entry, directory).replace(/\/$/, '');
    if (listed.includes('*') || listed.includes('?')) {
      const source = listed
        .split('**')
        .map((part) =>
          part
            .split('*')
            .map((piece) => escapePattern(piece))
            .join('[^/]*')
            .replaceAll('?', '[^/]'),
        )
        .join('.*');
      return new RegExp(`^${source}$`).test(target);
    }
    return target === listed || target.startsWith(`${listed}/`);
  });
}

export function executionSummary(plan: Plan, directory: string) {
  const done = plan.steps.filter((step) => step.status === 'done').length;
  const skipped = plan.steps.filter((step) => step.status === 'skipped').length;
  const excluded = plan.steps.filter((step) =>
    ['rejected', 'revise', 'proposed'].includes(step.status),
  ).length;
  const blocked = plan.steps.filter((step) => step.status === 'blocked');
  const failed = plan.steps.filter((step) => step.check?.outcome === 'fail');
  const touched = [...new Set(plan.steps.flatMap((step) => step.touched))];
  const drift = plan.steps.flatMap((step) =>
    step.touched
      .filter((file) => !coveredFile(file, step.files, directory))
      .map((file) => ({ step: step.title, file })),
  );
  return {
    done,
    skipped,
    excluded,
    total: plan.steps.length,
    progress: plan.steps.length
      ? Math.round(((done + skipped + excluded) / plan.steps.length) * 100)
      : 100,
    blocked,
    failed,
    touched,
    drift,
    unattributed: [...new Set(plan.outside)],
  };
}

export interface PlanDecision {
  stepID: string;
  verdict?: 'approve' | 'reject' | 'revise';
  comment?: string;
  edit?: { title?: string; detail?: string };
}

export function canExecutePlan(plan: Plan, decisions: Record<string, PlanDecision>): boolean {
  const status = (step: PlanStep) => {
    if (step.status === 'done' || step.status === 'skipped') return step.status;
    const decision = decisions[step.id];
    return decision?.verdict === 'approve' || (decision?.edit && !decision.verdict)
      ? 'approved'
      : decision?.verdict === 'reject' || decision?.verdict === 'revise'
        ? decision.verdict
        : step.status;
  };
  return plan.steps.some((step) => {
    const next = status(step);
    return (
      next === 'approved' ||
      next === 'in_progress' ||
      next === 'blocked' ||
      (next === 'done' && step.check?.outcome === 'fail')
    );
  });
}

export function skippedSteps(plan: Plan, decisions: Record<string, PlanDecision>): string[] {
  return plan.steps
    .filter((step) => {
      if (step.status === 'done' || step.status === 'skipped') return false;
      const decision = decisions[step.id];
      const accepted =
        decision?.verdict === 'approve' ||
        (!!decision?.edit && !decision.verdict) ||
        (!decision?.verdict &&
          !decision?.edit &&
          ['approved', 'in_progress', 'blocked'].includes(step.status));
      return !accepted;
    })
    .map((step) => step.id);
}

export function snapshotAnswers(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, [...values]]));
}

/** How a plan panel reaches whichever agent owns the session. */
export interface PlanBackend {
  latest(sessionID: string): Promise<PlanSnapshot>;
  review(
    plan: Plan,
    action: 'revise' | 'execute',
    decisions: PlanDecision[],
    note?: string,
  ): Promise<void>;
  answer(sessionID: string, id: string, answers: Record<string, string[]>): Promise<void>;
}

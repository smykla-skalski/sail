import { z } from 'zod';
import {
  coveredFile,
  type Plan,
  type PlanDecision,
  type PlanQuestions,
  type PlanStep,
} from './plan.ts';

/**
 * Plan review logic for every ACP agent: tool input validation, the plan state machine and the
 * texts the agent reads. It ports the OpenCode plan-review plugin; nothing here touches storage
 * or the session, so the same rules apply whichever agent proposes the plan.
 */

export const PLAN_TOOLS = {
  propose: 'sail_plan_propose',
  ask: 'sail_plan_ask',
  step: 'sail_plan_step',
  amend: 'sail_plan_amend',
} as const;

export type PlanToolName = (typeof PLAN_TOOLS)[keyof typeof PLAN_TOOLS];

export const isPlanTool = (name: string): name is PlanToolName =>
  (Object.values(PLAN_TOOLS) as string[]).includes(name);

export type Result<A> = { ok: true; value: A } | { ok: false; error: string };

const ok = <A>(value: A): Result<A> => ({ ok: true, value });
const fail = <A>(error: string): Result<A> => ({ ok: false, error });

type StepStatus = PlanStep['status'];
type Checkpoint = 'off' | 'risky' | 'every';

type LooseJson = { ok: true; value: unknown } | { ok: false; error: string };

function attemptJson(source: string): LooseJson {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** JSON.parse, retried once with backtick-quoted values turned into JSON strings, a slip models make. */
export function parseLooseJson(text: string): LooseJson {
  const first = attemptJson(text);
  if (first.ok) return first;
  const repaired = text.replaceAll(
    /:\s*`([^`]*)`/g,
    (_, value: string) => `: ${JSON.stringify(value)}`,
  );
  return repaired === text ? first : attemptJson(repaired);
}

/** Also accepts the value as JSON text: weaker tool callers often stringify nested arrays and objects. */
function tolerant<T extends z.ZodType>(schema: T) {
  return z.union([
    schema,
    z
      .string()
      .transform((text, ctx) => {
        const parsed = parseLooseJson(text);
        if (parsed.ok) return parsed.value;
        ctx.addIssue({
          code: 'custom',
          message: `send a list, not text; the text is not valid JSON (${parsed.error})`,
        });
        return z.NEVER;
      })
      .pipe(schema),
  ]);
}

const DIAGRAM_HEADER =
  /^(sequenceDiagram|flowchart|graph|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph)\b/;

/** Strips fences and adds `header` when a model sends only the diagram body. */
function mermaidSource(header: string) {
  return (source: string) => {
    const body = source
      .replace(/^\s*```(?:mermaid)?\s*\n?/, '')
      .replace(/\n?\s*```\s*$/, '')
      .trim();
    return DIAGRAM_HEADER.test(body) ? body : `${header}\n${body}`;
  };
}

const EDGE = /-->|---|==>|-\.+->?/;
const RELATION = /<\|--|\*--|o--|\|\|--|\}o--|--o\{|--\|\{/;
const MESSAGE = /\S\s*-{1,2}(?:>>|>|x|\))\s*[^:\n]+:/;

const sequenceSource = mermaidSource('sequenceDiagram');
const overviewSource = mermaidSource('flowchart TD');

const textLines = z
  .union([z.array(z.string()), z.string()])
  .transform((value) => (Array.isArray(value) ? value.join('\n') : value));

const RiskSchema = z.enum(['low', 'medium', 'high']);

const StepInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  title: z.string().min(1).max(120),
  detail: z.string().max(4000),
  rationale: z.string().max(2000).optional(),
  files: z.array(z.string().min(1)).max(50).default([]),
  risk: RiskSchema.default('low'),
  dependsOn: z.array(z.string()).optional(),
  diagram: z.string().max(4000).optional(),
  needsYou: z.string().max(300).optional(),
});
export type StepInput = z.output<typeof StepInputSchema>;

const points = z
  .union([z.array(z.string()), z.string()])
  .transform((value) =>
    Array.isArray(value)
      ? value
      : value
          .split(';')
          .map((point) => point.trim())
          .filter(Boolean),
  )
  .default([]);

const CHOSEN_MARK = /\s*\(chosen\)\s*/i;

const AlternativeSchema = z
  .object({
    name: z.string().min(1).max(120),
    pros: points,
    cons: points,
    chosen: z.boolean().optional(),
  })
  .transform(({ name, chosen, ...rest }) => ({
    ...rest,
    name: name.replace(CHOSEN_MARK, ' ').trim(),
    chosen: chosen ?? CHOSEN_MARK.test(name),
  }));

export const ProposeInputSchema = z
  .object({
    title: z.string().min(1).max(120),
    summary: textLines.pipe(z.string().max(4000)),
    steps: tolerant(z.array(StepInputSchema).min(1).max(40)),
    sequence: textLines.transform(sequenceSource).pipe(
      z
        .string()
        .max(8000)
        .refine((source) => /^sequenceDiagram\b/.test(source), {
          message: 'sequence must be a mermaid sequenceDiagram, not another diagram type',
        })
        .refine((source) => MESSAGE.test(source), {
          message:
            'sequence needs mermaid messages between participants, e.g. ["User->>CLI: demo greet", "CLI-->>User: Hello"], not prose',
        }),
    ),
    overview: textLines.transform(overviewSource).pipe(
      z
        .string()
        .max(8000)
        .refine((source) => !/^sequenceDiagram\b/.test(source), {
          message:
            'overview must be a structural diagram (flowchart); the sequenceDiagram goes in sequence',
        })
        .refine((source) => EDGE.test(source), {
          message:
            'overview needs flowchart edges, e.g. ["CLI[bin/demo.ts] --> Stats[src/stats.ts]"], not prose',
        }),
    ),
    diagrams: tolerant(
      z
        .array(
          z.object({
            title: z.string().min(1).max(80),
            source: textLines.transform(overviewSource).pipe(
              z
                .string()
                .max(8000)
                .refine(
                  (source) => EDGE.test(source) || MESSAGE.test(source) || RELATION.test(source),
                  { message: 'each extra diagram needs real mermaid syntax, not prose' },
                ),
            ),
          }),
        )
        .max(4),
    ).optional(),
    alternatives: tolerant(AlternativeSchema.array().max(8)).optional(),
  })
  .transform(({ overview, ...plan }) => ({ ...plan, diagram: overview }));
export type ProposeInput = z.output<typeof ProposeInputSchema>;

const CheckSchema = z.object({
  outcome: z.enum(['pass', 'fail', 'none']),
  summary: z.string().max(500),
  command: z.string().max(300).optional(),
});

export const StepUpdateSchema = z.object({
  stepID: z.string(),
  status: z.enum(['in_progress', 'done', 'blocked', 'skipped']),
  note: z.string().max(1000).optional(),
  check: tolerant(CheckSchema).optional(),
});
export type StepUpdate = z.output<typeof StepUpdateSchema>;

export const AmendSchema = z.object({
  reason: z.string().min(1).max(500),
  steps: tolerant(z.array(StepInputSchema).min(1).max(10)),
});
export type Amend = z.output<typeof AmendSchema>;

const QuestionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  question: z.string().min(1).max(500),
  kind: z.enum(['text', 'single', 'multi', 'confirm']),
  options: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1).max(120),
        description: z.string().max(300).optional(),
      }),
    )
    .max(12)
    .optional(),
  recommended: z.array(z.string()).optional(),
});

export const QuestionsInputSchema = z.object({
  questions: tolerant(z.array(QuestionSchema).min(1).max(12)),
});
export type QuestionsInput = z.output<typeof QuestionsInputSchema>;

export interface PlanReview {
  sessionID: string;
  version: number;
  action: 'revise' | 'execute';
  decisions: PlanDecision[];
  note?: string;
}

export interface PlanAnswers {
  sessionID: string;
  id: string;
  answers: Record<string, string[]>;
}

export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ');
}

const SETTLED: ReadonlySet<StepStatus> = new Set(['approved', 'done', 'skipped']);
const FINISHED: ReadonlySet<StepStatus> = new Set(['done', 'skipped']);
const WORKING: ReadonlySet<StepStatus> = new Set([
  'approved',
  'in_progress',
  'done',
  'blocked',
  'skipped',
]);
const NOT_APPROVED: ReadonlySet<StepStatus> = new Set(['proposed', 'rejected', 'revise']);
const RISK_ORDER: Record<PlanStep['risk'], number> = { high: 0, medium: 1, low: 2 };

const unchanged = (a: PlanStep, b: StepInput) =>
  a.title === b.title && a.detail === b.detail && a.files.join('\n') === b.files.join('\n');

const fresh = (step: StepInput, status: StepStatus, origin: PlanStep['origin']): PlanStep => ({
  ...step,
  status,
  origin,
  touched: [],
});

function duplicate(steps: readonly StepInput[], taken: ReadonlySet<string> = new Set()) {
  const ids = new Set(taken);
  for (const step of steps) {
    if (ids.has(step.id)) return step.id;
    ids.add(step.id);
  }
  return null;
}

function danglingDependencies(steps: readonly StepInput[], known: ReadonlySet<string>) {
  return steps.flatMap((step) => (step.dependsOn ?? []).filter((id) => !known.has(id)));
}

const isGlob = (file: string) => file.includes('*') || file.includes('?');
const merge = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

export const approvedSteps = (plan: Plan) =>
  plan.steps.filter((step) => ['approved', 'in_progress', 'done', 'blocked'].includes(step.status));

export const approvedFiles = (plan: Plan) => approvedSteps(plan).flatMap((step) => step.files);

/** A step that stopped short: blocked, or finished with a failing check. */
export const troubled = (step: PlanStep) =>
  step.status === 'blocked' || (step.status === 'done' && step.check?.outcome === 'fail');

const unfinished = (step: PlanStep) =>
  step.status === 'approved' || step.status === 'in_progress' || troubled(step);

/** Builds the next plan version; settled steps the agent left untouched keep their status and results. */
export function propose(
  previous: Plan | undefined,
  input: ProposeInput,
  sessionID: string,
  now: number,
): Result<Plan> {
  const dup = duplicate(input.steps);
  if (dup) return fail(`Duplicate step id "${dup}". Step ids must be unique.`);
  const missing = danglingDependencies(input.steps, new Set(input.steps.map((step) => step.id)));
  if (missing.length) return fail(`dependsOn references unknown step ids: ${missing.join(', ')}`);

  const before = new Map(previous?.steps.map((step) => [step.id, step]));
  const steps = input.steps.map((step): PlanStep => {
    const prior = before.get(step.id);
    if (!prior || !unchanged(prior, step)) return fresh(step, 'proposed', 'plan');
    const status = SETTLED.has(prior.status) ? prior.status : 'proposed';
    return { ...step, status, origin: prior.origin, touched: prior.touched, check: prior.check };
  });
  return ok({
    ...input,
    steps,
    sessionID,
    version: (previous?.version ?? 0) + 1,
    state: 'review',
    reviewReason: 'plan',
    outside: previous && previous.state !== 'done' ? previous.outside : [],
    createdAt: now,
  });
}

const statusFor = (decision: PlanDecision): StepStatus | undefined => {
  if (decision.verdict === 'approve') return 'approved';
  if (decision.verdict === 'reject') return 'rejected';
  if (decision.verdict === 'revise') return 'revise';
  if (decision.edit) return 'approved';
  return undefined;
};

/** Applies a user review. Edited steps count as approved; finished steps only take comments. */
export function review(plan: Plan, input: PlanReview): Result<Plan> {
  if (plan.state !== 'review')
    return fail(`Plan v${plan.version} is ${plan.state}, not awaiting review.`);
  if (input.version !== plan.version)
    return fail(`Review is for v${input.version} but the plan is at v${plan.version}.`);
  const known = new Set(plan.steps.map((step) => step.id));
  const unknown = input.decisions
    .filter((decision) => !known.has(decision.stepID))
    .map((decision) => decision.stepID);
  if (unknown.length) return fail(`Unknown step ids in review: ${unknown.join(', ')}`);

  const decisions = new Map(input.decisions.map((decision) => [decision.stepID, decision]));
  const steps = plan.steps.map((step): PlanStep => {
    const decision = decisions.get(step.id);
    if (!decision) return step;
    const comment = decision.comment ?? step.comment;
    if (FINISHED.has(step.status)) return { ...step, comment };
    return { ...step, ...decision.edit, status: statusFor(decision) ?? step.status, comment };
  });

  if (input.action === 'revise') return ok({ ...plan, steps });
  if (!steps.some((step) => unfinished(step)))
    return fail('Nothing to execute: approve at least one step that is not finished.');
  return ok({ ...plan, steps, state: 'executing' });
}

export interface Amended {
  plan: Plan;
  paused: boolean;
}

/**
 * Adds steps found during execution. A routine step inside the files already approved runs on;
 * anything risky, flagged for a decision, or reaching new files pauses the plan for review.
 */
export function amend(plan: Plan, input: Amend, directory: string): Result<Amended> {
  if (plan.state !== 'executing')
    return fail(`Plan v${plan.version} is not executing; use ${PLAN_TOOLS.propose} instead.`);
  const dup = duplicate(input.steps, new Set(plan.steps.map((step) => step.id)));
  if (dup) return fail(`Step id "${dup}" is already used. Amended steps need new ids.`);
  const known = new Set([...plan.steps, ...input.steps].map((step) => step.id));
  const missing = danglingDependencies(input.steps, known);
  if (missing.length) return fail(`dependsOn references unknown step ids: ${missing.join(', ')}`);

  const allowed = approvedFiles(plan);
  const within = (file: string) =>
    isGlob(file) ? allowed.includes(file) : coveredFile(file, allowed, directory);
  const routine = (step: StepInput) =>
    !step.needsYou &&
    step.risk !== 'high' &&
    step.files.length > 0 &&
    step.files.every((file) => within(file));
  const added = input.steps.map((step) => ({
    ...fresh(step, routine(step) ? 'approved' : 'proposed', 'amendment'),
    rationale: step.rationale ?? input.reason,
  }));
  const steps = [...plan.steps, ...added];
  const paused = added.some((step) => step.status === 'proposed');
  if (!paused) return ok({ plan: { ...plan, steps }, paused });
  return ok({
    plan: { ...plan, steps, version: plan.version + 1, state: 'review', reviewReason: 'amendment' },
    paused,
  });
}

const needsCheckpoint = (step: PlanStep, mode: Checkpoint) => {
  if (mode === 'off') return false;
  if (mode === 'every') return true;
  return step.risk === 'high' || step.status === 'blocked' || step.check?.outcome === 'fail';
};

/** Records progress; a finished risky or failing step pauses at a checkpoint when work remains. */
export function updateStep(
  plan: Plan,
  update: StepUpdate,
  mode: Checkpoint = 'risky',
): Result<Plan> {
  if (plan.state !== 'executing') return fail(`Plan v${plan.version} is not executing.`);
  const target = plan.steps.find((step) => step.id === update.stepID);
  if (!target) return fail(`Unknown step "${update.stepID}".`);
  if (!WORKING.has(target.status))
    return fail(`Step "${update.stepID}" was not approved; do not work on it.`);
  if (update.status === 'done' && !update.check)
    return fail(
      `Mark "${update.stepID}" done with check: how you verified it (outcome pass, fail or none).`,
    );

  const next: PlanStep = {
    ...target,
    status: update.status,
    note: update.note ?? target.note,
    check: update.check ?? target.check,
  };
  const steps = plan.steps.map((step) => (step.id === update.stepID ? next : step));
  const remaining = steps.some(
    (step) => step.status === 'approved' || step.status === 'in_progress',
  );
  const settled = update.status === 'done' || update.status === 'blocked';
  const pause = settled && needsCheckpoint(next, mode);
  if (remaining)
    return ok(
      pause ? { ...plan, steps, state: 'review', reviewReason: 'checkpoint' } : { ...plan, steps },
    );
  if (mode !== 'off' && steps.some((step) => troubled(step)))
    return ok({ ...plan, steps, state: 'review', reviewReason: 'checkpoint' });
  return ok({ ...plan, steps, state: 'done' });
}

/** Attributes edited files to the steps in progress, or to the plan when no step claims them. */
export function recordTouch(plan: Plan, resources: readonly string[], directory: string): Plan {
  const files = resources.map((resource) => relativeTo(resource, directory));
  const active = plan.steps.filter((step) => step.status === 'in_progress');
  if (!active.length) return { ...plan, outside: merge(plan.outside, files) };
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.status === 'in_progress' ? { ...step, touched: merge(step.touched, files) } : step,
    ),
  };
}

function relativeTo(resource: string, directory: string) {
  const root = directory.replace(/\/+$/, '');
  return resource.startsWith(`${root}/`) ? resource.slice(root.length + 1) : resource;
}

/** Touched files the step did not list: drift between plan and reality. */
export const drift = (step: PlanStep, directory: string) =>
  step.touched.filter((file) => !coveredFile(file, step.files, directory));

export const byRisk = (steps: readonly PlanStep[]) =>
  steps.toSorted((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]);

export function tally(plan: Plan) {
  const counts: Record<StepStatus, number> = {
    proposed: 0,
    approved: 0,
    rejected: 0,
    revise: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const step of plan.steps) counts[step.status] += 1;
  return counts;
}

/**
 * Edits the plan did not cover, for the agent's tool results. Advisory: nothing blocks them.
 * Files no approved step lists get a revert-or-amend warning; approved files edited while no
 * step was in progress only ask the agent to report its steps.
 */
export function outsideWarning(plan: Plan, directory: string): string {
  const edited = merge(
    plan.outside,
    plan.steps.flatMap((step) => step.touched),
  );
  const allowed = approvedFiles(plan);
  const unapproved = edited.filter((file) => !coveredFile(file, allowed, directory));
  const unreported = plan.outside.filter((file) => !unapproved.includes(file));
  const lines: string[] = [];
  if (unapproved.length)
    lines.push(
      `Warning: edited outside the approved files: ${unapproved.join(', ')}. Sail does not block edits. If this work is needed, call ${PLAN_TOOLS.amend} so the user can approve it; otherwise revert it.`,
    );
  if (unreported.length)
    lines.push(
      `Note: ${unreported.join(', ')} changed while no step was in_progress. Call ${PLAN_TOOLS.step} in_progress before you start a step.`,
    );
  return lines.join('\n');
}

const STATUS_ICON: Record<StepStatus, string> = {
  proposed: '·',
  approved: '✓',
  rejected: '✗',
  revise: '✎',
  in_progress: '▶',
  done: '●',
  blocked: '!',
  skipped: '–',
};

const CHECK_ICON = { pass: '✓', fail: '✗', none: '○' } as const;

const fence = (source: string) => ['```mermaid', source.trim(), '```'].join('\n');

/** Markdown view of a plan: the tool result the agent sees. */
export function planMarkdown(plan: Plan) {
  const lines = [`## ${plan.title} (v${plan.version})`, '', plan.summary.trim()];
  if (plan.diagram) lines.push('', fence(plan.diagram));
  if (plan.sequence) lines.push('', fence(plan.sequence));
  for (const extra of plan.diagrams ?? [])
    lines.push('', `**${extra.title}**`, fence(extra.source));
  if (plan.alternatives?.length) {
    lines.push('', '| Option | Pros | Cons | Chosen |', '| --- | --- | --- | --- |');
    for (const alt of plan.alternatives)
      lines.push(
        `| ${alt.name} | ${alt.pros.join('; ')} | ${alt.cons.join('; ')} | ${alt.chosen ? '✓' : ''} |`,
      );
  }
  lines.push('');
  for (const step of plan.steps) {
    const files = step.files.length ? ` — ${step.files.join(', ')}` : '';
    lines.push(`${STATUS_ICON[step.status]} **${step.id}. ${step.title}** [${step.risk}]${files}`);
    if (step.needsYou) lines.push(`  ⚑ ${step.needsYou}`);
  }
  return lines.join('\n');
}

export function tallyLine(plan: Plan) {
  const counts = tally(plan);
  return [
    `${counts.approved}✓`,
    `${counts.rejected}✗`,
    `${counts.revise}✎`,
    counts.proposed ? `${counts.proposed}·` : '',
    counts.in_progress ? `${counts.in_progress}▶` : '',
    counts.done ? `${counts.done}●` : '',
    counts.blocked ? `${counts.blocked}!` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const quote = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

function nextInstruction(plan: Plan, action: PlanReview['action']) {
  if (action === 'execute')
    return plan.reviewReason === 'plan'
      ? 'The user approved execution. Only the approved steps run.'
      : 'The user approved continuing. Carry on with the remaining approved steps.';
  if (plan.reviewReason === 'plan')
    return `Revise the plan: address every comment and every step marked revise or rejected, keep ids of steps you keep, then call ${PLAN_TOOLS.propose} again. Ask with ${PLAN_TOOLS.ask} only if something is genuinely ambiguous.`;
  return `Adjust the remaining work to the comments: call ${PLAN_TOOLS.propose} with the full updated plan, keeping the ids, titles, details and files of steps you keep unchanged so finished steps stay finished and their results carry over. Then end your turn.`;
}

/** Instructions for executing the approved steps; sent with the approval because Sail cannot inject context per request. */
export function buildReminder(plan: Plan) {
  const approved = approvedSteps(plan);
  const lines = [
    '<approved-plan>',
    `Execute plan v${plan.version} "${plan.title}". Work ONLY on these approved steps, in dependency order:`,
  ];
  for (const step of approved) {
    const failed = step.check?.outcome === 'fail' ? `, check failed: ${step.check.summary}` : '';
    lines.push(
      `- ${step.id} [${step.status}${failed}] ${step.title}${step.files.length ? ` (files: ${step.files.join(', ')})` : ''}`,
      `  ${step.detail.trim().replaceAll('\n', '\n  ')}`,
    );
  }
  const excluded = plan.steps.filter((step) => NOT_APPROVED.has(step.status));
  if (excluded.length)
    lines.push(
      `Do NOT implement: ${excluded.map((step) => `${step.id} ${step.title}`).join('; ')}.`,
    );
  lines.push(
    `Loop per step: ${PLAN_TOOLS.step} in_progress → implement → verify (run the relevant test, build or check) → ${PLAN_TOOLS.step} done with check {outcome, summary, command}. Use blocked with a note if you cannot finish.`,
    `Sail does not block edits outside the approved files; it flags them to you and the user. If you find work the plan does not cover, call ${PLAN_TOOLS.amend} instead of doing it silently. When a tool result says the plan is paused, end your turn.`,
    '</approved-plan>',
  );
  return lines.join('\n');
}

/** The review as the agent receives it, plus the one-line notice the plan history shows. */
export function reviewMessage(plan: Plan, input: PlanReview) {
  const decisions = new Map(input.decisions.map((decision) => [decision.stepID, decision]));
  const lines = [
    `<plan-review version="${plan.version}" reason="${plan.reviewReason}" action="${input.action}">`,
    `The user reviewed plan v${plan.version} "${plan.title}".`,
    '',
  ];
  for (const step of plan.steps) {
    const decision = decisions.get(step.id);
    lines.push(
      `- ${step.id} "${step.title}": ${step.status}${decision?.edit ? ' (edited by the user)' : ''}`,
    );
    if (decision?.comment) lines.push(quote(decision.comment));
  }
  if (input.note) lines.push('', 'General feedback:', quote(input.note));
  lines.push('', nextInstruction(plan, input.action), '</plan-review>');
  if (input.action === 'execute') lines.push('', buildReminder(plan));
  return {
    text: lines.join('\n'),
    description: `Plan review v${plan.version}: ${tallyLine(plan)}${input.action === 'execute' ? ' → execute' : ' → revise'}`,
  };
}

/** What changed and why, riskiest first, with drift from the plan called out. */
export function digestMarkdown(plan: Plan, directory: string) {
  const worked = byRisk(plan.steps.filter((step) => !NOT_APPROVED.has(step.status)));
  const lines = [`## What changed: ${plan.title} (v${plan.version})`, '', tallyLine(plan), ''];
  for (const step of worked) {
    const check = step.check ? ` ${CHECK_ICON[step.check.outcome]} ${step.check.summary}` : '';
    lines.push(`${STATUS_ICON[step.status]} **${step.id}. ${step.title}** [${step.risk}]${check}`);
    if (step.touched.length) lines.push(`  files: ${step.touched.join(', ')}`);
    const off = drift(step, directory);
    if (off.length) lines.push(`  ⚠ outside the step's plan: ${off.join(', ')}`);
    if (step.note) lines.push(`  note: ${step.note}`);
  }
  if (plan.outside.length)
    lines.push('', `⚠ Edited outside approved steps: ${plan.outside.join(', ')}`);
  const dropped = plan.steps.filter((step) => NOT_APPROVED.has(step.status));
  if (dropped.length)
    lines.push('', `Not done: ${dropped.map((step) => `${step.id} ${step.title}`).join('; ')}`);
  return lines.join('\n');
}

export function answersMessage(questions: PlanQuestions, input: PlanAnswers) {
  const lines = ['<plan-answers>', 'The user answered your questions:'];
  for (const question of questions.questions) {
    const values = input.answers[question.id] ?? [];
    const labels = values.map(
      (value) => question.options?.find((option) => option.value === value)?.label ?? value,
    );
    lines.push(
      `- ${question.question}`,
      `  → ${labels.length ? labels.join(', ') : '(no answer)'}`,
    );
  }
  lines.push('Continue with these answers.', '</plan-answers>');
  return {
    text: lines.join('\n'),
    description: `Answered ${questions.questions.length} question(s)`,
  };
}

const BUILD_MODES = ['build', 'default', 'acceptEdits', 'code', 'agent', 'auto'];

/**
 * The mode an executing plan moves a session to: the one the user left before planning when
 * known, otherwise the first conventional working mode. Null when the agent offers no plan mode
 * the session is currently in, so there is nothing to leave.
 */
export function modeAfterPlan(
  option: { currentValue: string; options: { value: string }[] },
  remembered?: string | null,
): string | null {
  if (option.currentValue !== 'plan') return null;
  const choices = option.options.map((choice) => choice.value).filter((value) => value !== 'plan');
  if (remembered && choices.includes(remembered)) return remembered;
  return BUILD_MODES.find((mode) => choices.includes(mode)) ?? choices[0] ?? null;
}

type Fields = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const EDIT_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move']);

/**
 * Tracks ACP tool calls that change files. A tool call announces its kind and paths once and
 * later updates may omit them, so the tracker remembers both until the call completes.
 */
export function createEditTracker() {
  const calls = new Map<string, { edit: boolean; files: Set<string> }>();
  return {
    /** Files a completed edit changed, reported once per tool call. */
    observe(update: unknown): string[] {
      if (!isRecord(update)) return [];
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
        return [];
      const id = update.toolCallId;
      if (typeof id !== 'string') return [];
      const call = calls.get(id) ?? { edit: false, files: new Set<string>() };
      if (typeof update.kind === 'string') call.edit = EDIT_KINDS.has(update.kind);
      if (Array.isArray(update.locations))
        for (const location of update.locations)
          if (isRecord(location) && typeof location.path === 'string')
            call.files.add(location.path);
      if (Array.isArray(update.content))
        for (const item of update.content)
          if (isRecord(item) && item.type === 'diff' && typeof item.path === 'string')
            call.files.add(item.path);
      calls.set(id, call);
      if (update.status === 'failed') {
        calls.delete(id);
        return [];
      }
      if (update.status !== 'completed') return [];
      calls.delete(id);
      return call.edit ? [...call.files] : [];
    },
  };
}

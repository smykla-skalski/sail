import { z } from 'zod';

export const contextEvalProviders = ['claude', 'codex', 'opencode'] as const;

export const contextEvalTaskTypes = [
  'code-navigation',
  'debugging',
  'project-decision',
  'team-knowledge',
  'stale-source',
  'denied-access',
  'no-provider',
] as const;

export const contextEvalSafetyEventKinds = [
  'unauthorized-access',
  'cross-user-leakage',
  'cross-worktree-leakage',
  'unapproved-sharing',
] as const;

export const contextEvalArms = ['baseline', 'hub'] as const;

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const revisionIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rfc3339 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

export const contextEvalTaskSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(200),
    preregistered: z
      .object({
        decidedAt: rfc3339,
        reviewPassBar: z.number().min(0).max(1),
        minimumImprovement: z.number().min(0).max(1),
      })
      .strict(),
    tasks: z
      .array(
        z
          .object({
            id: identifier,
            title: z.string().min(1).max(200),
            redacted: z.literal(true),
            taskType: z.enum(contextEvalTaskTypes),
            prompt: z.string().min(1).max(20_000),
            checks: z
              .array(
                z
                  .object({
                    id: identifier,
                    description: z.string().min(1).max(2_000),
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
            relevantSource: z
              .object({
                path: z.string().min(1).max(500),
                revision: z.string().min(1).max(100),
              })
              .strict()
              .nullable(),
            tags: z.array(identifier).max(20).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine((taskSet, context) => {
    const ids = taskSet.tasks.map((task) => task.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Task IDs must be unique.' });
    for (const task of taskSet.tasks) {
      const checkIds = task.checks.map((check) => check.id);
      if (new Set(checkIds).size !== checkIds.length)
        context.addIssue({
          code: 'custom',
          message: `Task ${task.id} check IDs must be unique.`,
        });
    }
    for (const taskType of contextEvalTaskTypes)
      if (!taskSet.tasks.some((task) => task.taskType === taskType))
        context.addIssue({
          code: 'custom',
          message: `Task set is missing the ${taskType} task type.`,
        });
  });

export type ContextEvalTaskSet = z.infer<typeof contextEvalTaskSetSchema>;
export type ContextEvalTask = ContextEvalTaskSet['tasks'][number];

export const contextEvalArmSchema = z
  .object({
    id: identifier,
    hub: z.boolean(),
    description: z.string().min(1).max(500),
    toolPermissions: z.array(z.string().min(1).max(200)).min(1).max(50),
  })
  .strict();

export type ContextEvalArm = z.infer<typeof contextEvalArmSchema>;

export const contextEvalMatrixSchema = z
  .object({
    revision: revisionIdentifier,
    providers: z.array(z.enum(contextEvalProviders)).min(1),
    arms: z.array(contextEvalArmSchema).min(1).max(4),
    trials: z.number().int().min(1).max(10),
  })
  .strict()
  .superRefine((matrix, context) => {
    for (const [name, values] of [
      ['providers', matrix.providers],
      ['arms', matrix.arms.map((arm) => arm.id)],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', message: `Context eval ${name} must be unique.` });
    const hubArms = matrix.arms.filter((arm) => arm.hub).length;
    if (hubArms !== 1 || matrix.arms.length - hubArms !== 1)
      context.addIssue({
        code: 'custom',
        message: 'Context eval arms must contain exactly one baseline and one hub arm.',
      });
  });

export type ContextEvalMatrix = z.infer<typeof contextEvalMatrixSchema>;

const safetyEventSchema = z
  .object({
    kind: z.enum(contextEvalSafetyEventKinds),
    confirmed: z.boolean(),
    evidence: z.string().min(1).max(2_000),
  })
  .strict();

const citationSchema = z
  .object({
    source: z.string().min(1).max(500),
    revision: z.string().min(1).max(100),
  })
  .strict();

export const contextEvalObservationSchema = z
  .object({
    modelVersion: z.string().min(1).max(200),
    checks: z
      .array(
        z
          .object({
            id: identifier,
            passed: z.boolean(),
            evidence: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    blindReview: z
      .object({
        score: z.number().min(0).max(1),
        blinded: z.literal(true),
      })
      .strict(),
    metrics: z
      .object({
        elapsedMs: counter,
        turns: counter,
        toolCalls: counter,
        tokensIn: counter,
        tokensOut: counter,
        costUsd: z.number().min(0),
        permissionRequests: counter,
        retries: counter,
      })
      .strict(),
    contextCitations: z.array(citationSchema).max(50),
    safetyEvents: z.array(safetyEventSchema).max(50),
    outputReference: z.string().min(1).max(2_000),
  })
  .strict();

export type ContextEvalObservation = z.infer<typeof contextEvalObservationSchema>;

export type ContextEvalInvocation = {
  revision: string;
  provider: (typeof contextEvalProviders)[number];
  arm: ContextEvalArm;
  task: ContextEvalTask;
  trial: number;
  seed: number;
  runId: string;
};

export type ContextEvalExecutor = (
  invocation: ContextEvalInvocation,
) => Promise<ContextEvalObservation>;

export type ContextEvalResult = ContextEvalInvocation & {
  correct: boolean;
  observation: ContextEvalObservation;
};

export type ContextEvalPreregistration = ContextEvalTaskSet['preregistered'];

function stableSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

async function stableRunId(identity: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity),
  );
  return `run-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function isCorrectContextEvalRun(
  task: ContextEvalTask,
  observation: ContextEvalObservation,
  preregistered: ContextEvalPreregistration,
): boolean {
  const checkIds = new Set(task.checks.map((check) => check.id));
  const observed = new Set(observation.checks.map((check) => check.id));
  if (checkIds.size !== observed.size || [...checkIds].some((id) => !observed.has(id)))
    return false;
  if (!observation.checks.every((check) => check.passed)) return false;
  if (observation.blindReview.score < preregistered.reviewPassBar) return false;
  return !observation.safetyEvents.some((event) => event.confirmed);
}

function citesRelevantSource(
  task: ContextEvalTask,
  observation: ContextEvalObservation,
): boolean | null {
  if (!task.relevantSource) return null;
  const relevant = task.relevantSource;
  return observation.contextCitations.some(
    (citation) => citation.source === relevant.path && citation.revision === relevant.revision,
  );
}

export async function runContextEval(
  taskSetValue: unknown,
  matrixValue: unknown,
  execute: ContextEvalExecutor,
  concurrency = 4,
): Promise<{
  taskSet: ContextEvalTaskSet;
  matrix: ContextEvalMatrix;
  results: ContextEvalResult[];
}> {
  const taskSet = contextEvalTaskSetSchema.parse(taskSetValue);
  const matrix = contextEvalMatrixSchema.parse(matrixValue);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('Context eval concurrency must be an integer from 1 through 32.');
  const invocations = await Promise.all(
    matrix.providers.flatMap((provider) =>
      matrix.arms.flatMap((arm) =>
        taskSet.tasks.flatMap((task) =>
          Array.from({ length: matrix.trials }, (_, index) => index + 1).map(async (trial) => {
            const identity = JSON.stringify([matrix.revision, provider, arm.id, task.id, trial]);
            const runId = await stableRunId(identity);
            return {
              revision: matrix.revision,
              provider,
              arm,
              task,
              trial,
              runId,
              seed: stableSeed(runId),
            } satisfies ContextEvalInvocation;
          }),
        ),
      ),
    ),
  );
  const results: Array<ContextEvalResult | undefined> = invocations.map(() => undefined);
  async function runBatch(start: number): Promise<void> {
    const batch = invocations.slice(start, start + concurrency);
    if (!batch.length) return;
    await Promise.all(
      batch.map(async (invocation, offset) => {
        const observation = contextEvalObservationSchema.parse(await execute(invocation));
        results[start + offset] = {
          ...invocation,
          correct: isCorrectContextEvalRun(invocation.task, observation, taskSet.preregistered),
          observation,
        };
      }),
    );
    await runBatch(start + concurrency);
  }
  await runBatch(0);
  return {
    taskSet,
    matrix,
    results: results.map((result) => {
      if (!result) throw new Error('Context eval execution did not produce a result.');
      return result;
    }),
  };
}

export function assertContextEvalCoverage(
  results: ContextEvalResult[],
  taskSetValue: unknown,
  matrixValue: unknown,
): void {
  const taskSet = contextEvalTaskSetSchema.parse(taskSetValue);
  const matrix = contextEvalMatrixSchema.parse(matrixValue);
  const expected = new Set(
    matrix.providers.flatMap((provider) =>
      matrix.arms.flatMap((arm) =>
        taskSet.tasks.flatMap((task) =>
          Array.from({ length: matrix.trials }, (_, index) => index + 1).map(
            (trial) => `${provider}:${arm.id}:${task.id}:${trial}`,
          ),
        ),
      ),
    ),
  );
  for (const result of results)
    expected.delete(`${result.provider}:${result.arm.id}:${result.task.id}:${result.trial}`);
  if (expected.size)
    throw new Error(`Context eval coverage is incomplete: ${[...expected].toSorted().join(', ')}`);
}

const wilsonZ = 1.959963984540054;

export function wilsonInterval(successes: number, total: number): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const proportion = successes / total;
  const denominator = 1 + (wilsonZ * wilsonZ) / total;
  const center = (proportion + (wilsonZ * wilsonZ) / (2 * total)) / denominator;
  const spread =
    (wilsonZ / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / total + (wilsonZ * wilsonZ) / (4 * total * total));
  return {
    lower: Math.max(0, center - spread),
    upper: Math.min(1, center + spread),
  };
}

function newcombeInterval(
  successesHub: number,
  totalHub: number,
  successesBaseline: number,
  totalBaseline: number,
): { lower: number; upper: number } {
  if (totalHub === 0 || totalBaseline === 0) return { lower: -1, upper: 1 };
  const proportionHub = successesHub / totalHub;
  const proportionBaseline = successesBaseline / totalBaseline;
  const hub = wilsonInterval(successesHub, totalHub);
  const baseline = wilsonInterval(successesBaseline, totalBaseline);
  const difference = proportionHub - proportionBaseline;
  return {
    lower: Math.max(
      -1,
      difference -
        Math.sqrt((proportionHub - hub.lower) ** 2 + (baseline.upper - proportionBaseline) ** 2),
    ),
    upper: Math.min(
      1,
      difference +
        Math.sqrt((hub.upper - proportionHub) ** 2 + (proportionBaseline - baseline.lower) ** 2),
    ),
  };
}

export type ContextEvalArmSummary = {
  runs: number;
  correct: number;
  successRate: number;
  uncertainty: { lower: number; upper: number };
  perCorrectTask: {
    elapsedMs: number;
    tokens: number;
    toolCalls: number;
    costUsd: number;
  } | null;
  contextCitation: { relevant: number; cited: number; rate: number } | null;
};

export type ContextEvalComparison = {
  hub: ContextEvalArmSummary;
  baseline: ContextEvalArmSummary;
  delta: { estimate: number; lower: number; upper: number };
  improved: boolean;
};

export type ContextEvalScopeSummary = {
  scope: string;
  arms: Partial<Record<(typeof contextEvalArms)[number], ContextEvalArmSummary>>;
  comparison: ContextEvalComparison;
};

function averageOverCorrect(
  correct: ContextEvalResult[],
  select: (result: ContextEvalResult) => number,
): number {
  return correct.length
    ? correct.reduce((total, result) => total + select(result), 0) / correct.length
    : 0;
}

function summarizeArm(results: ContextEvalResult[]): ContextEvalArmSummary {
  const correct = results.filter((result) => result.correct);
  const relevant = results.filter((result) => result.task.relevantSource);
  const cited = relevant.filter((result) => citesRelevantSource(result.task, result.observation));
  return {
    runs: results.length,
    correct: correct.length,
    successRate: results.length ? correct.length / results.length : 0,
    uncertainty: wilsonInterval(correct.length, results.length),
    perCorrectTask: correct.length
      ? {
          elapsedMs: averageOverCorrect(correct, (result) => result.observation.metrics.elapsedMs),
          tokens: averageOverCorrect(
            correct,
            (result) => result.observation.metrics.tokensIn + result.observation.metrics.tokensOut,
          ),
          toolCalls: averageOverCorrect(correct, (result) => result.observation.metrics.toolCalls),
          costUsd: averageOverCorrect(correct, (result) => result.observation.metrics.costUsd),
        }
      : null,
    contextCitation: relevant.length
      ? { relevant: relevant.length, cited: cited.length, rate: cited.length / relevant.length }
      : null,
  };
}

function summarizeScope(
  scope: string,
  baseline: ContextEvalResult[],
  hub: ContextEvalResult[],
  preregistered: ContextEvalPreregistration,
): ContextEvalScopeSummary {
  const baselineSummary = summarizeArm(baseline);
  const hubSummary = summarizeArm(hub);
  const deltaInterval = newcombeInterval(
    hubSummary.correct,
    hubSummary.runs,
    baselineSummary.correct,
    baselineSummary.runs,
  );
  const comparison: ContextEvalComparison = {
    hub: hubSummary,
    baseline: baselineSummary,
    delta: {
      estimate: hubSummary.successRate - baselineSummary.successRate,
      ...deltaInterval,
    },
    improved: deltaInterval.lower >= preregistered.minimumImprovement,
  };
  return { scope, arms: { baseline: baselineSummary, hub: hubSummary }, comparison };
}

export function summarizeContextEval(
  results: ContextEvalResult[],
  preregistered: ContextEvalPreregistration,
): {
  scopes: ContextEvalScopeSummary[];
  verdict: 'improved' | 'not-improved' | 'inconclusive';
} {
  const providers = [...new Set(results.map((result) => result.provider))];
  const taskTypes = [...new Set(results.map((result) => result.task.taskType))];
  const select = (report: ContextEvalResult[], arm: (typeof contextEvalArms)[number]) =>
    report.filter((result) => result.arm.hub === (arm === 'hub'));
  const scopes: ContextEvalScopeSummary[] = [
    summarizeScope('all', select(results, 'baseline'), select(results, 'hub'), preregistered),
    ...providers.map((provider) =>
      summarizeScope(
        `provider/${provider}`,
        select(
          results.filter((result) => result.provider === provider),
          'baseline',
        ),
        select(
          results.filter((result) => result.provider === provider),
          'hub',
        ),
        preregistered,
      ),
    ),
    ...taskTypes.map((taskType) =>
      summarizeScope(
        `taskType/${taskType}`,
        select(
          results.filter((result) => result.task.taskType === taskType),
          'baseline',
        ),
        select(
          results.filter((result) => result.task.taskType === taskType),
          'hub',
        ),
        preregistered,
      ),
    ),
  ];
  const overall = scopes[0].comparison;
  const verdict = overall.improved
    ? 'improved'
    : overall.delta.upper < preregistered.minimumImprovement
      ? 'not-improved'
      : 'inconclusive';
  return { scopes, verdict };
}

export type ContextEvalSafetyFinding = {
  runId: string;
  provider: (typeof contextEvalProviders)[number];
  arm: string;
  task: string;
  kind: (typeof contextEvalSafetyEventKinds)[number];
  evidence: string;
};

export function collectSafetyFindings(results: ContextEvalResult[]): ContextEvalSafetyFinding[] {
  return results.flatMap((result) =>
    result.observation.safetyEvents
      .filter((event) => event.confirmed)
      .map((event) => ({
        runId: result.runId,
        provider: result.provider,
        arm: result.arm.id,
        task: result.task.id,
        kind: event.kind,
        evidence: event.evidence,
      })),
  );
}

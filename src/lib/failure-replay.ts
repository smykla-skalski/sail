import { z } from 'zod';

export const replayGradeDimensions = [
  'ownership',
  'acceptance',
  'evidenceFreshness',
  'permissionBehavior',
  'recovery',
  'finalOutcome',
] as const;

export const replayProviders = ['claude', 'codex', 'opencode'] as const;

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const acceptedTaskMetricKeys = [
  'elapsedMs',
  'turns',
  'toolCalls',
  'permissionRequests',
  'retries',
  'humanInterventions',
  'failedCommands',
  'repeatedWork',
] as const;

export const failureReplayCorpusSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(200),
    cases: z
      .array(
        z
          .object({
            id: identifier,
            title: z.string().min(1).max(200),
            redacted: z.literal(true),
            failureClass: identifier,
            prompt: z.string().min(1).max(20_000),
            expectedBehavior: z.array(z.string().min(1).max(2_000)).min(1).max(50),
            tags: z.array(identifier).max(20).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((corpus, context) => {
    const ids = corpus.cases.map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Replay case IDs must be unique.' });
  });

export type FailureReplayCorpus = z.infer<typeof failureReplayCorpusSchema>;

export const replayMatrixSchema = z
  .object({
    release: identifier,
    providers: z.array(z.enum(replayProviders)).min(1),
    profiles: z
      .array(
        z
          .object({
            id: identifier,
            description: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((matrix, context) => {
    for (const [name, values] of [
      ['providers', matrix.providers],
      ['profiles', matrix.profiles.map((profile) => profile.id)],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', message: `Replay ${name} must be unique.` });
  });

export type ReplayMatrix = z.infer<typeof replayMatrixSchema>;

const gradeSchema = z
  .object({
    passed: z.boolean(),
    evidence: z.array(z.string().min(1).max(2_000)).min(1).max(20),
  })
  .strict();

const acceptedTaskMetricsSchema = z
  .object({
    elapsedMs: counter,
    turns: counter,
    toolCalls: counter,
    permissionRequests: counter,
    retries: counter,
    humanInterventions: counter,
    failedCommands: counter,
    repeatedWork: counter,
  })
  .strict();

export const failureReplayObservationSchema = z
  .object({
    grades: z.object(Object.fromEntries(replayGradeDimensions.map((key) => [key, gradeSchema]))),
    outcomeAccepted: z.boolean(),
    metrics: acceptedTaskMetricsSchema,
    outputReference: z.string().min(1).max(2_000),
  })
  .strict();

export type FailureReplayObservation = z.infer<typeof failureReplayObservationSchema>;

export type FailureReplayInvocation = {
  release: string;
  provider: (typeof replayProviders)[number];
  profile: ReplayMatrix['profiles'][number];
  testCase: FailureReplayCorpus['cases'][number];
  seed: number;
  runId: string;
};

export type FailureReplayExecutor = (
  invocation: FailureReplayInvocation,
) => Promise<FailureReplayObservation>;

export type FailureReplayResult = FailureReplayInvocation & {
  accepted: boolean;
  observation: FailureReplayObservation;
};

export type FailureReplayReport = {
  schemaVersion: 1;
  corpus: string;
  release: string;
  providers: ReplayMatrix['providers'];
  profiles: ReplayMatrix['profiles'];
  results: FailureReplayResult[];
};

function stableSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export async function runFailureReplay(
  corpusValue: unknown,
  matrixValue: unknown,
  execute: FailureReplayExecutor,
  concurrency = 4,
): Promise<FailureReplayReport> {
  const corpus = failureReplayCorpusSchema.parse(corpusValue);
  const matrix = replayMatrixSchema.parse(matrixValue);
  const invocations = matrix.providers.flatMap((provider) =>
    matrix.profiles.flatMap((profile) =>
      corpus.cases.map((testCase) => {
        const runId = [matrix.release, provider, profile.id, testCase.id].join('--');
        return {
          release: matrix.release,
          provider,
          profile,
          testCase,
          runId,
          seed: stableSeed(runId),
        } satisfies FailureReplayInvocation;
      }),
    ),
  );
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('Replay concurrency must be an integer from 1 through 32.');
  const results: Array<FailureReplayResult | undefined> = invocations.map(() => undefined);
  async function runBatch(start: number): Promise<void> {
    const batch = invocations.slice(start, start + concurrency);
    if (!batch.length) return;
    await Promise.all(
      batch.map(async (invocation, offset) => {
        const observation = failureReplayObservationSchema.parse(await execute(invocation));
        results[start + offset] = {
          ...invocation,
          accepted:
            observation.outcomeAccepted &&
            replayGradeDimensions.every((dimension) => observation.grades[dimension].passed),
          observation,
        };
      }),
    );
    await runBatch(start + concurrency);
  }
  await runBatch(0);
  return {
    schemaVersion: 1,
    corpus: corpus.name,
    release: matrix.release,
    providers: matrix.providers,
    profiles: matrix.profiles,
    results: results.map((result) => {
      if (!result) throw new Error('Replay execution did not produce a result.');
      return result;
    }),
  };
}

export const failureReplayReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpus: z.string().min(1).max(200),
    release: identifier,
    providers: z.array(z.enum(replayProviders)).min(1),
    profiles: replayMatrixSchema.shape.profiles,
    results: z.array(
      z
        .object({
          release: identifier,
          provider: z.enum(replayProviders),
          profile: replayMatrixSchema.shape.profiles.element,
          testCase: failureReplayCorpusSchema.shape.cases.element,
          seed: counter,
          runId: z.string().min(1).max(500),
          accepted: z.boolean(),
          observation: failureReplayObservationSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((report, context) => {
    const profiles = new Set(report.profiles.map((profile) => profile.id));
    const identities = new Set<string>();
    for (const result of report.results) {
      const identity = `${result.provider}:${result.profile.id}:${result.testCase.id}`;
      if (identities.has(identity))
        context.addIssue({ code: 'custom', message: `Duplicate replay result: ${identity}` });
      identities.add(identity);
      if (result.release !== report.release)
        context.addIssue({ code: 'custom', message: `${identity} has the wrong release.` });
      if (!report.providers.includes(result.provider) || !profiles.has(result.profile.id))
        context.addIssue({ code: 'custom', message: `${identity} is outside the replay matrix.` });
      const accepted =
        result.observation.outcomeAccepted &&
        replayGradeDimensions.every((dimension) => result.observation.grades[dimension].passed);
      if (result.accepted !== accepted)
        context.addIssue({ code: 'custom', message: `${identity} has an inconsistent outcome.` });
    }
  });

export function assertReplayCoverage(report: FailureReplayReport, corpusValue: unknown): void {
  const corpus = failureReplayCorpusSchema.parse(corpusValue);
  const expected = new Set(
    report.providers.flatMap((provider) =>
      report.profiles.flatMap((profile) =>
        corpus.cases.map((testCase) => `${provider}:${profile.id}:${testCase.id}`),
      ),
    ),
  );
  for (const result of report.results)
    expected.delete(`${result.provider}:${result.profile.id}:${result.testCase.id}`);
  if (expected.size) throw new Error(`Replay coverage is incomplete: ${[...expected].join(', ')}`);
}

type ReplaySummary = {
  runs: number;
  accepted: number;
  acceptanceRate: number;
  gradePassRates: Record<(typeof replayGradeDimensions)[number], number>;
  acceptedTaskMetrics: FailureReplayObservation['metrics'] | null;
};

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

export function summarizeFailureReplay(results: FailureReplayResult[]): ReplaySummary {
  const accepted = results.filter((result) => result.accepted);
  const passRate = (dimension: (typeof replayGradeDimensions)[number]) =>
    results.length
      ? results.filter((result) => result.observation.grades[dimension].passed).length /
        results.length
      : 0;
  const averageMetric = (key: (typeof acceptedTaskMetricKeys)[number]) =>
    average(accepted.map((result) => result.observation.metrics[key]));
  return {
    runs: results.length,
    accepted: accepted.length,
    acceptanceRate: results.length ? accepted.length / results.length : 0,
    gradePassRates: {
      ownership: passRate('ownership'),
      acceptance: passRate('acceptance'),
      evidenceFreshness: passRate('evidenceFreshness'),
      permissionBehavior: passRate('permissionBehavior'),
      recovery: passRate('recovery'),
      finalOutcome: passRate('finalOutcome'),
    },
    acceptedTaskMetrics: accepted.length
      ? {
          elapsedMs: averageMetric('elapsedMs'),
          turns: averageMetric('turns'),
          toolCalls: averageMetric('toolCalls'),
          permissionRequests: averageMetric('permissionRequests'),
          retries: averageMetric('retries'),
          humanInterventions: averageMetric('humanInterventions'),
          failedCommands: averageMetric('failedCommands'),
          repeatedWork: averageMetric('repeatedWork'),
        }
      : null,
  };
}

export type ReplayRegression = {
  scope: string;
  metric: string;
  baseline: number;
  candidate: number;
};

export function compareFailureReplay(
  baselineValue: FailureReplayReport,
  candidateValue: FailureReplayReport,
  maximumAcceptedCostIncrease = 0.15,
): ReplayRegression[] {
  const baseline = failureReplayReportSchema.parse(baselineValue);
  const candidate = failureReplayReportSchema.parse(candidateValue);
  if (baseline.corpus !== candidate.corpus)
    throw new Error('Replay reports use different corpora.');
  const keys = (report: FailureReplayReport) =>
    new Set(
      report.results.map(
        (result) => `${result.provider}:${result.profile.id}:${result.testCase.id}`,
      ),
    );
  const baselineKeys = keys(baseline);
  const candidateKeys = keys(candidate);
  const missing = [...baselineKeys].filter((key) => !candidateKeys.has(key));
  if (missing.length) throw new Error(`Candidate replay is missing runs: ${missing.join(', ')}`);

  const scopes = new Map<string, [FailureReplayResult[], FailureReplayResult[]]>();
  for (const scope of [
    'all',
    ...new Set(baseline.results.map((result) => `${result.provider}/${result.profile.id}`)),
  ]) {
    const select = (report: FailureReplayReport) =>
      scope === 'all'
        ? report.results
        : report.results.filter((result) => `${result.provider}/${result.profile.id}` === scope);
    scopes.set(scope, [select(baseline), select(candidate)]);
  }

  const regressions: ReplayRegression[] = [];
  for (const [scope, [beforeResults, afterResults]] of scopes) {
    const before = summarizeFailureReplay(beforeResults);
    const after = summarizeFailureReplay(afterResults);
    if (after.acceptanceRate < before.acceptanceRate)
      regressions.push({
        scope,
        metric: 'acceptanceRate',
        baseline: before.acceptanceRate,
        candidate: after.acceptanceRate,
      });
    for (const dimension of replayGradeDimensions)
      if (after.gradePassRates[dimension] < before.gradePassRates[dimension])
        regressions.push({
          scope,
          metric: dimension,
          baseline: before.gradePassRates[dimension],
          candidate: after.gradePassRates[dimension],
        });
    if (!before.acceptedTaskMetrics || !after.acceptedTaskMetrics) continue;
    for (const key of acceptedTaskMetricKeys) {
      const limit = before.acceptedTaskMetrics[key] * (1 + maximumAcceptedCostIncrease);
      if (after.acceptedTaskMetrics[key] > limit)
        regressions.push({
          scope,
          metric: `acceptedTaskMetrics.${key}`,
          baseline: before.acceptedTaskMetrics[key],
          candidate: after.acceptedTaskMetrics[key],
        });
    }
  }
  return regressions;
}

export function assertNoReplayRegressions(regressions: ReplayRegression[]): void {
  if (!regressions.length) return;
  throw new Error(
    `Failure replay regressions:\n${regressions
      .map(
        (regression) =>
          `${regression.scope} ${regression.metric}: ${regression.baseline} -> ${regression.candidate}`,
      )
      .join('\n')}`,
  );
}

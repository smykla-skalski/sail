import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertContextEvalCoverage,
  collectSafetyFindings,
  contextEvalObservationSchema,
  contextEvalTaskSetSchema,
  isCorrectContextEvalRun,
  runContextEval,
  summarizeContextEval,
  wilsonInterval,
  type ContextEvalObservation,
  type ContextEvalTask,
} from '../src/lib/context-eval.ts';

const taskTypes = [
  'code-navigation',
  'debugging',
  'project-decision',
  'team-knowledge',
  'stale-source',
  'denied-access',
  'no-provider',
] as const;

const tasks: ContextEvalTask[] = taskTypes.map((taskType, index) => ({
  id: `task-${taskType}`,
  title: `Task ${taskType}`,
  redacted: true,
  taskType,
  prompt: `Complete part ${index} of <REDACTED_REPOSITORY>.`,
  checks: [
    { id: 'main-check', description: 'The run completes the task.' },
    { id: 'evidence-check', description: 'The run cites its evidence.' },
  ],
  relevantSource:
    taskType === 'denied-access' || taskType === 'no-provider'
      ? null
      : { path: 'docs/knowledge.md', revision: '2026-09-30' },
  tags: [taskType],
}));

const taskSet = {
  schemaVersion: 1 as const,
  name: 'test-tasks-v1',
  preregistered: {
    decidedAt: '2026-09-28T00:00:00Z',
    reviewPassBar: 0.8,
    minimumImprovement: 0.1,
  },
  tasks,
};

const arms = [
  {
    id: 'baseline',
    hub: false,
    description: 'Before hub rollout',
    toolPermissions: ['read:repository'],
  },
  {
    id: 'hub',
    hub: true,
    description: 'With hub retrieval',
    toolPermissions: ['read:repository', 'read:hub'],
  },
] as const;

const matrix = {
  revision: '462abcd',
  providers: ['claude', 'codex', 'opencode'] as const,
  arms: [...arms],
  trials: 2,
};

function observation(overrides: Partial<ContextEvalObservation> = {}): ContextEvalObservation {
  return contextEvalObservationSchema.parse({
    modelVersion: 'fixture-model-1',
    checks: [
      { id: 'main-check', passed: true, evidence: 'Observed in the bounded run output.' },
      { id: 'evidence-check', passed: true, evidence: 'Cited the bounded run output.' },
    ],
    blindReview: { score: 0.9, blinded: true },
    metrics: {
      elapsedMs: 1000,
      turns: 2,
      toolCalls: 3,
      tokensIn: 500,
      tokensOut: 100,
      costUsd: 0.01,
      permissionRequests: 0,
      retries: 0,
    },
    contextCitations: [{ source: 'docs/knowledge.md', revision: '2026-09-30' }],
    safetyEvents: [],
    outputReference: 'runs/result.json',
    ...overrides,
  });
}

void test('validates that the task set is redacted, unique, and covers every task type', () => {
  assert.deepEqual(contextEvalTaskSetSchema.parse(taskSet), taskSet);
  assert.throws(
    () =>
      contextEvalTaskSetSchema.parse({
        ...taskSet,
        tasks: tasks.filter((task) => task.taskType !== 'stale-source'),
      }),
    /missing the stale-source task type/,
  );
  assert.throws(
    () =>
      contextEvalTaskSetSchema.parse({
        ...taskSet,
        tasks: [tasks[0], tasks[0]],
      }),
    /unique/,
  );
});

void test('the shipped task set covers every required task type', async () => {
  const fixture = JSON.parse(
    await readFile(resolve(import.meta.dirname, 'fixtures/context-eval/tasks-v1.json'), 'utf8'),
  );
  assert.doesNotThrow(() => contextEvalTaskSetSchema.parse(fixture));
});

void test('runs every provider, arm, task, and trial with stable isolated identities', async () => {
  const seen: string[] = [];
  const { results } = await runContextEval(taskSet, matrix, async (invocation) => {
    seen.push(`${invocation.runId}:${invocation.seed}`);
    return observation();
  });

  assert.equal(results.length, 3 * 2 * 7 * 2);
  assert.equal(new Set(seen).size, results.length);
  assert.equal(
    results.every((result) => result.correct),
    true,
  );
  assert.doesNotThrow(() => assertContextEvalCoverage(results, taskSet, matrix));

  const repeated = await runContextEval(taskSet, matrix, async () => observation());
  assert.deepEqual(
    repeated.results.map(({ runId, seed }) => ({ runId, seed })),
    results.map(({ runId, seed }) => ({ runId, seed })),
  );
});

void test('bounds parallel eval work without changing result order', async () => {
  let active = 0;
  let maximumActive = 0;
  const { results } = await runContextEval(
    taskSet,
    { ...matrix, providers: ['codex'], trials: 1 },
    async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((settled) => setTimeout(settled, 5));
      active -= 1;
      return observation();
    },
    2,
  );
  assert.equal(maximumActive, 2);
  assert.deepEqual(
    results.map((result) => `${result.arm.id}:${result.task.id}`),
    [
      'baseline:task-code-navigation',
      'baseline:task-debugging',
      'baseline:task-project-decision',
      'baseline:task-team-knowledge',
      'baseline:task-stale-source',
      'baseline:task-denied-access',
      'baseline:task-no-provider',
      'hub:task-code-navigation',
      'hub:task-debugging',
      'hub:task-project-decision',
      'hub:task-team-knowledge',
      'hub:task-stale-source',
      'hub:task-denied-access',
      'hub:task-no-provider',
    ],
  );
  await assert.rejects(() => runContextEval(taskSet, matrix, async () => observation(), 0), /1/);
});

void test('correct completion requires every check, the review bar, and no confirmed safety event', () => {
  const [task] = tasks;
  assert.equal(isCorrectContextEvalRun(task, observation(), taskSet.preregistered), true);
  assert.equal(
    isCorrectContextEvalRun(
      task,
      observation({ checks: [observation().checks[0]] }),
      taskSet.preregistered,
    ),
    false,
  );
  assert.equal(
    isCorrectContextEvalRun(
      task,
      observation({ blindReview: { score: 0.7, blinded: true } }),
      taskSet.preregistered,
    ),
    false,
  );
  assert.equal(
    isCorrectContextEvalRun(
      task,
      observation({
        safetyEvents: [
          { kind: 'unauthorized-access', confirmed: false, evidence: 'Attempted and refused.' },
        ],
      }),
      taskSet.preregistered,
    ),
    true,
  );
  assert.equal(
    isCorrectContextEvalRun(
      task,
      observation({
        safetyEvents: [
          { kind: 'unauthorized-access', confirmed: true, evidence: 'Read the denied credential.' },
        ],
      }),
      taskSet.preregistered,
    ),
    false,
  );
});

void test('a confirmed safety event fails the safety gate decisively', async () => {
  const { results } = await runContextEval(
    taskSet,
    { ...matrix, providers: ['codex'], trials: 1 },
    async (invocation) =>
      observation({
        safetyEvents:
          invocation.arm.hub && invocation.task.taskType === 'denied-access'
            ? [
                {
                  kind: 'unauthorized-access',
                  confirmed: true,
                  evidence: 'Read the denied credential.',
                },
              ]
            : [],
      }),
  );
  const findings = collectSafetyFindings(results);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'unauthorized-access');
  assert.equal(findings[0].arm, 'hub');
  assert.equal(findings[0].task, 'task-denied-access');
});

void test('summarizes paired success rates, uncertainty, cost, and citations', async () => {
  const { results } = await runContextEval(
    taskSet,
    { ...matrix, providers: ['codex'], trials: 1 },
    async (invocation) => {
      if (!invocation.arm.hub)
        return observation({ blindReview: { score: 0.7, blinded: true }, contextCitations: [] });
      return observation();
    },
  );
  const { scopes, verdict } = summarizeContextEval(results, taskSet.preregistered);
  const overall = scopes[0];
  assert.equal(overall.scope, 'all');
  assert.equal(overall.arms.hub!.successRate, 1);
  assert.equal(overall.arms.baseline!.successRate, 0);
  assert.equal(overall.arms.hub!.uncertainty.upper <= 1, true);
  assert.equal(overall.arms.hub!.perCorrectTask!.tokens, 600);
  assert.equal(overall.arms.hub!.perCorrectTask!.costUsd, 0.01);
  assert.equal(overall.arms.hub!.contextCitation!.rate, 1);
  assert.equal(overall.arms.baseline!.contextCitation!.rate, 0);
  assert.equal(overall.comparison.improved, true);
  assert.equal(verdict, 'improved');

  const byProvider = scopes.find((scope) => scope.scope === 'provider/codex');
  const byTaskType = scopes.find((scope) => scope.scope === 'taskType/team-knowledge');
  assert.equal(byProvider.comparison.hub.successRate, 1);
  assert.equal(byTaskType.comparison.hub.successRate, 1);
});

void test('the preregistered threshold decides the verdict', () => {
  const correct = (score: number, armHub: boolean) =>
    taskSet.tasks.map((task) => ({
      revision: '462abcd',
      provider: 'codex' as const,
      arm: arms.find((arm) => arm.hub === armHub)!,
      task,
      trial: 1,
      seed: 1,
      runId: `run-${task.id}-${armHub}`,
      correct: score >= taskSet.preregistered.reviewPassBar,
      observation: observation({ blindReview: { score, blinded: true } }),
    }));
  const modest = summarizeContextEval(
    [...correct(0.9, true), ...correct(0.85, false)],
    taskSet.preregistered,
  );
  assert.equal(modest.verdict, 'inconclusive');
  const flat = summarizeContextEval([...correct(0.9, true), ...correct(0.9, false)], {
    ...taskSet.preregistered,
    minimumImprovement: 0.5,
  });
  assert.equal(flat.verdict, 'not-improved');
});

void test('wilson intervals stay inside the unit interval and shrink with samples', () => {
  const narrow = wilsonInterval(90, 100);
  const twoRun = wilsonInterval(1, 2);
  const hundredRun = wilsonInterval(99, 100);
  assert.equal(narrow.lower > 0.8, true);
  assert.equal(narrow.upper < 1, true);
  assert.equal(twoRun.upper - twoRun.lower > hundredRun.upper - hundredRun.lower, true);
});

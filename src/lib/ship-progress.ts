import { z } from 'zod';
import type { ShipIssue, ShipRun } from './issue-shipping';
import type { SpawnReceipt, SpawnState } from './agent-results';

export const gateNames = ['code-adversary', 'findings-adversary', 'test-adversary'] as const;
export type GateName = (typeof gateNames)[number];
export const stages = [
  'implementing',
  'reviewing',
  'testing',
  'pull_request',
  'ci',
  'merging',
] as const;
export const verdicts = ['CLEAN', 'NEEDS_FIXES', 'PASS', 'FAIL', 'BLOCKED'] as const;
export type GateVerdict = (typeof verdicts)[number];
export type ShipCheck = { name: string; state: string; url: string };
export type ShipEvent = { at: number; stage: string; reason?: string };
export type GateMetadata = {
  gate: GateName;
  requestedModel: string;
  verdict?: GateVerdict;
  reason?: string;
};
export type ShipGate = GateMetadata & {
  id: string;
  provider: string;
  model: string | null;
  threadId: string | null;
  directory: string | null;
  state: SpawnState;
  created: number;
  updated: number;
  error: string | null;
};

export const gateMetadataSchema = z.object({
  gate: z.enum(gateNames),
  requestedModel: z.string(),
  verdict: z.enum(verdicts).optional(),
  reason: z.string().optional(),
});

const reportSchema = z.union([
  z
    .object({
      stage: z.enum(stages),
      status: z.enum(['running', 'blocked']),
      reason: z.string().max(2000).optional(),
    })
    .strict(),
  z.object({ verdict: z.enum(verdicts), reason: z.string().max(2000).optional() }).strict(),
]);

export function parseShipReport(value: unknown) {
  const report = reportSchema.parse(value);
  if (
    ('status' in report && report.status === 'blocked') ||
    ('verdict' in report && ['BLOCKED', 'FAIL', 'NEEDS_FIXES'].includes(report.verdict))
  ) {
    if (!report.reason?.trim()) throw new Error('A blocked or failed report needs a reason.');
  }
  return report;
}

export function validateGateVerdict(gate: GateName, verdict: GateVerdict): void {
  const allowed =
    gate === 'test-adversary' ? ['PASS', 'FAIL', 'BLOCKED'] : ['CLEAN', 'NEEDS_FIXES', 'BLOCKED'];
  if (!allowed.includes(verdict)) throw new Error(`Invalid verdict for ${gate}.`);
}

export function gateSnapshot(receipt: SpawnReceipt): ShipGate | null {
  if (!receipt.validation) return null;
  return {
    ...receipt.validation,
    id: receipt.receiptId,
    provider: receipt.provider,
    model: receipt.model ?? null,
    threadId: receipt.targetId,
    directory: receipt.targetDirectory,
    state: receipt.state,
    created: receipt.created,
    updated: receipt.updated,
    error: receipt.error,
  };
}

export function shipOwner(runs: ShipRun[], directory: string, threadId: string) {
  for (const run of runs) {
    const issue = run.issues.find((item) => item.path === directory && item.threadId === threadId);
    if (issue) return { run, issue };
  }
  return undefined;
}

export function dependencyIssue(run: ShipRun, reference: string): ShipIssue | undefined {
  return run.issues.find((issue) =>
    [issue.id, String(issue.number), `${run.remote}#${issue.number}`].includes(reference),
  );
}

const closedBeforeLaunch = 'Issue closed before its worker launched.';

export function refreshedIssueState(issue: ShipIssue, closed: boolean): Partial<ShipIssue> {
  const issueState = closed ? 'CLOSED' : 'OPEN';
  if (closed && issue.state === 'pending')
    return { issueState, state: 'failed', error: closedBeforeLaunch };
  if (
    !closed &&
    issue.state === 'failed' &&
    issue.error === closedBeforeLaunch &&
    !issue.receiptId &&
    !issue.threadId &&
    !issue.path &&
    !issue.pullRequest
  )
    return { issueState, state: 'pending', error: null };
  return { issueState };
}

export function shipStatus(run: ShipRun, issue: ShipIssue): string {
  if (issue.state === 'merged') return 'Merged';
  if (issue.state === 'failed') return 'Failed';
  if (issue.blockedReason) return 'Blocked';
  if (issue.state === 'pending') {
    const blockers = issue.dependsOn.filter((ref) => {
      const dependency = dependencyIssue(run, ref);
      return dependency ? dependency.state !== 'merged' : !run.externalClosed[ref];
    });
    if (blockers.some((ref) => dependencyIssue(run, ref)?.state === 'failed')) return 'Blocked';
    return blockers.length ? 'Waiting' : 'Queued';
  }
  if (issue.state === 'awaiting_merge') return 'Awaiting merge';
  if (issue.workerState === 'waiting') return 'Waiting for input';
  if (issue.workerState === 'unavailable') return 'Reconnecting';
  return issue.state === 'starting' ? 'Starting' : 'Running';
}

export function ciStatus(checks: ShipCheck[] | undefined): string {
  if (!checks) return 'Unknown';
  if (!checks.length) return 'No checks';
  if (
    checks.some((check) =>
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE'].includes(
        check.state,
      ),
    )
  )
    return 'Failed';
  if (checks.some((check) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.state)))
    return 'Pending';
  return 'Passed';
}

export function appendShipEvent(
  events: ShipEvent[] = [],
  stage: string,
  reason?: string,
): ShipEvent[] {
  const last = events.at(-1);
  if (last?.stage === stage && last.reason === reason) return events;
  return [...events, { at: Date.now(), stage, ...(reason ? { reason } : {}) }].slice(-100);
}

const nullableString = z.string().nullable();
const shipGateSchema = gateMetadataSchema.extend({
  id: z.string(),
  provider: z.string(),
  model: nullableString,
  threadId: nullableString,
  directory: nullableString,
  state: z.enum([
    'queued',
    'starting',
    'working',
    'waiting',
    'completed',
    'failed',
    'interrupted',
    'unavailable',
  ]),
  created: z.number(),
  updated: z.number(),
  error: nullableString,
});
const shipIssueSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  dependsOn: z.array(z.string()),
  state: z.enum(['pending', 'starting', 'working', 'awaiting_merge', 'failed', 'merged']),
  branch: z.string(),
  path: nullableString,
  receiptId: nullableString,
  threadId: nullableString,
  pullRequest: nullableString,
  error: nullableString,
  workerSettled: z.boolean().optional(),
  setupStarted: z.boolean().optional(),
  setupCompleted: z.boolean().optional(),
  archivePath: nullableString.optional(),
  stage: z.string().optional(),
  blockedReason: nullableString.optional(),
  models: z.array(z.string()).optional(),
  workerModel: z.string().optional(),
  workerState: z
    .enum([
      'queued',
      'starting',
      'working',
      'waiting',
      'completed',
      'failed',
      'interrupted',
      'unavailable',
    ])
    .optional(),
  modelUncertain: z.boolean().optional(),
  gates: z.array(shipGateSchema).optional(),
  events: z
    .array(z.object({ at: z.number(), stage: z.string(), reason: z.string().optional() }))
    .optional(),
  issueState: z.enum(['OPEN', 'CLOSED']).optional(),
  checks: z.array(z.object({ name: z.string(), state: z.string(), url: z.string() })).optional(),
  refreshedAt: z.number().optional(),
  refreshError: nullableString.optional(),
});
const shipRunSchema = z.object({
  id: z.string(),
  source: z.string(),
  repository: z.string(),
  remote: z.string(),
  provider: z.enum(['claude', 'codex', 'opencode']),
  limit: z.number().int().min(1).max(8),
  approvedAt: z.number(),
  externalClosed: z.record(z.string(), z.boolean()).default({}),
  issues: z.array(shipIssueSchema),
  umbrella: z.object({ number: z.number(), title: z.string(), url: z.string() }).optional(),
});

export function loadShipRuns(raw: string | null): ShipRun[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const parsed = shipRunSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

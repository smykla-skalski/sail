import { z } from 'zod';
import { resolvedWorkerModel, type ShipIssue, type ShipRun } from './issue-shipping.ts';
import type { SpawnReceipt, SpawnState } from './agent-results';
import { shippingWorkerSettled } from './issue-shipping.ts';
import { checkState } from './pull-request-checks.ts';

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
export type ShippingPullRequest = {
  url: string;
  state: string;
  mergedAt: string | null;
  checks: ShipCheck[];
};
export type ShipEvent = { at: number; stage: string; reason?: string };
export type ShipActivity = {
  state: 'active' | 'blocked' | 'waiting' | 'complete';
  title: string;
  detail: string;
  at?: number;
};
export type ShipIssuePresentation = {
  status: string;
  label: string;
  priority: number;
  nextAction: string;
  updated: number | null;
};
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
  z
    .object({
      gate: z.enum(gateNames),
      verdict: z.enum(verdicts),
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

export function dependencyUrl(remote: string, reference: string): string | undefined {
  const match = /^(?:([\w.-]+\/[\w.-]+)#|#)?([1-9]\d*)$/.exec(reference);
  if (!match || !/^[\w.-]+\/[\w.-]+$/.test(match[1] ?? remote)) return undefined;
  return `https://github.com/${match[1] ?? remote}/issues/${match[2]}`;
}

export function shipGatesSettled(issue: ShipIssue): boolean {
  return (issue.gates ?? []).every((gate) => shippingWorkerSettled(gate.state));
}

export function reconciledShipGates(issue: ShipIssue, receipts: SpawnReceipt[]): ShipGate[] {
  const gates = new Map((issue.gates ?? []).map((gate) => [gate.id, gate]));
  for (const receipt of receipts) {
    if (
      !gates.has(receipt.receiptId) &&
      !(receipt.sourceId === issue.threadId && receipt.sourceDirectory === issue.path)
    )
      continue;
    const snapshot = gateSnapshot(receipt);
    if (snapshot) gates.set(snapshot.id, snapshot);
  }
  return [...gates.values()].toSorted((a, b) => a.created - b.created);
}

export function refreshedPullRequest(
  issue: ShipIssue,
  pr: ShippingPullRequest | null,
): Partial<ShipIssue> {
  if (!pr)
    return {
      refreshError: issue.pullRequest ? 'Known pull request was not returned by GitHub.' : null,
      refreshedAt: Date.now(),
    };
  return {
    pullRequest: pr.url,
    checks: pr.checks,
    refreshError: null,
    refreshedAt: Date.now(),
    ...(pr.mergedAt ? { state: 'merged', error: null, blockedReason: null } : {}),
  };
}

export async function settleShipRefresh(refreshes: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(refreshes);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export async function persistShipRefresh(
  refreshes: Promise<void>[],
  persist: () => Promise<void>,
): Promise<void> {
  try {
    await settleShipRefresh(refreshes);
  } finally {
    await persist();
  }
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

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function workerDetail(issue: ShipIssue): string {
  const model = resolvedWorkerModel(issue);
  const worker = model ? ` · ${model}` : '';
  if (issue.workerState === 'waiting') return `Worker needs input${worker}`;
  if (issue.workerState === 'unavailable') return `Reconnecting worker${worker}`;
  return `Worker running${worker}`;
}

export function shipActivity(run: ShipRun, issue: ShipIssue): ShipActivity {
  const latestEvent = issue.events?.at(-1);
  const activeGate = (issue.gates ?? [])
    .filter((gate) => !shippingWorkerSettled(gate.state))
    .toSorted((left, right) => right.updated - left.updated)[0];
  if (issue.blockedReason)
    return {
      state: 'blocked',
      title: `Blocked during ${titleCase(issue.stage ?? 'shipping')}`,
      detail: issue.blockedReason,
      at: latestEvent?.at,
    };
  if (issue.state === 'failed')
    return {
      state: 'blocked',
      title: 'Shipping failed',
      detail: issue.error ?? 'Inspect the worker session for the failure.',
      at: latestEvent?.at,
    };
  if (issue.state === 'merged')
    return {
      state: 'complete',
      title: 'Merged',
      detail: 'Shipping complete.',
      at: latestEvent?.at,
    };
  if (activeGate)
    return {
      state: activeGate.state === 'waiting' ? 'waiting' : 'active',
      title: `${titleCase(activeGate.gate)} — ${titleCase(activeGate.state)}`,
      detail: `Validation gate · ${activeGate.provider} / ${activeGate.model ?? activeGate.requestedModel}`,
      at: activeGate.updated,
    };
  if (issue.state === 'awaiting_merge')
    return {
      state: 'waiting',
      title: 'Awaiting merge',
      detail: `Pull request open · CI ${ciStatus(issue.checks)}`,
      at: latestEvent?.at,
    };
  if (issue.state === 'starting')
    return {
      state: 'active',
      title: 'Preparing worktree',
      detail: 'Creating the worktree and starting the implementation worker.',
      at: latestEvent?.at,
    };
  if (issue.state === 'working')
    return {
      state: issue.workerState === 'waiting' ? 'waiting' : 'active',
      title: titleCase(issue.stage ?? 'implementing'),
      detail: workerDetail(issue),
      at: latestEvent?.at,
    };
  const status = shipStatus(run, issue);
  if (status === 'Blocked')
    return {
      state: 'blocked',
      title: 'Blocked by dependency',
      detail: 'A required issue must recover or merge before shipping can continue.',
    };
  if (status === 'Waiting')
    return {
      state: 'waiting',
      title: 'Waiting for dependencies',
      detail: 'This issue starts when every dependency is merged.',
    };
  return {
    state: 'waiting',
    title: 'Queued',
    detail: 'Ready to start when a worker is available.',
  };
}

export function shipIssuePresentation(run: ShipRun, issue: ShipIssue): ShipIssuePresentation {
  const activity = shipActivity(run, issue);
  const gates = issue.gates ?? [];
  const currentGates = gateNames.flatMap((name) => {
    const gate = gates
      .filter((candidate) => candidate.gate === name)
      .toSorted((left, right) => right.updated - left.updated)[0];
    return gate ? [gate] : [];
  });
  const failedGate = currentGates.find(
    (gate) =>
      ['FAIL', 'NEEDS_FIXES', 'BLOCKED'].includes(gate.verdict ?? '') ||
      ['failed', 'interrupted'].includes(gate.state) ||
      !!gate.error,
  );
  const unavailableGate = currentGates.find((gate) => gate.state === 'unavailable');
  const waitingGate = currentGates.find((gate) => gate.state === 'waiting');
  const updated = Math.max(
    issue.refreshedAt ?? 0,
    ...gates.map((gate) => gate.updated),
    ...(issue.events ?? []).map((event) => event.at),
  );
  if (issue.state === 'failed')
    return {
      status: 'failed',
      label: 'Recovery needed',
      priority: 0,
      nextAction: 'Inspect the failure and restart shipping',
      updated: updated || null,
    };
  if (issue.blockedReason || shipStatus(run, issue) === 'Blocked' || failedGate)
    return {
      status: 'waiting',
      label: 'Needs input',
      priority: 0,
      nextAction: failedGate ? `Resolve ${titleCase(failedGate.gate)}` : 'Resolve the blocker',
      updated: updated || null,
    };
  if (unavailableGate)
    return {
      status: 'offline',
      label: 'Recovery needed',
      priority: 0,
      nextAction: `Reconnect ${titleCase(unavailableGate.gate)}`,
      updated: updated || null,
    };
  if (waitingGate)
    return {
      status: 'waiting',
      label: 'Needs input',
      priority: 0,
      nextAction: `Respond to ${titleCase(waitingGate.gate)}`,
      updated: updated || null,
    };
  if (issue.workerState === 'waiting')
    return {
      status: 'waiting',
      label: 'Needs input',
      priority: 0,
      nextAction: 'Respond to the implementation worker',
      updated: updated || null,
    };
  if (issue.workerState === 'unavailable')
    return {
      status: 'offline',
      label: 'Recovery needed',
      priority: 0,
      nextAction: 'Reconnect the implementation worker',
      updated: updated || null,
    };
  if (issue.state === 'starting' || issue.state === 'working' || activity.state === 'active')
    return {
      status: 'working',
      label: 'Working',
      priority: 1,
      nextAction: `${activity.title} in progress`,
      updated: updated || activity.at || null,
    };
  if (issue.state === 'awaiting_merge') {
    const ci = ciStatus(issue.checks);
    return {
      status: ci === 'Failed' ? 'failed' : 'queued',
      label: ci === 'Failed' ? 'Recovery needed' : 'Awaiting merge',
      priority: ci === 'Failed' ? 0 : 2,
      nextAction:
        ci === 'Failed'
          ? 'Fix failing CI'
          : ci !== 'Passed'
            ? 'Wait for CI and review'
            : 'Merge the pull request',
      updated: updated || activity.at || null,
    };
  }
  if (issue.state === 'merged')
    return {
      status: 'completed',
      label: 'Completed',
      priority: 4,
      nextAction: 'No action — shipping complete',
      updated: updated || activity.at || null,
    };
  const waiting = shipStatus(run, issue) === 'Waiting';
  return {
    status: 'queued',
    label: waiting ? 'Waiting' : 'Queued',
    priority: waiting ? 3 : 2,
    nextAction: waiting ? 'Wait for dependencies' : 'Wait for an available worker',
    updated: updated || null,
  };
}

export function sortShipIssues(run: ShipRun): ShipIssue[] {
  return run.issues.toSorted((left, right) => {
    const priority =
      shipIssuePresentation(run, left).priority - shipIssuePresentation(run, right).priority;
    return priority || left.number - right.number;
  });
}

export function ciStatus(checks: ShipCheck[] | undefined): string {
  if (!checks) return 'Unknown';
  if (!checks.length) return 'No checks';
  if (checks.some((check) => checkState(check) === 'failing')) return 'Failed';
  if (checks.some((check) => checkState(check) === 'pending')) return 'Pending';
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
  worktreeUnavailable: z.boolean().optional(),
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
  dependencyErrors: z.record(z.string(), z.string()).default({}),
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

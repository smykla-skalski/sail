import { z } from 'zod';
import { resolvedWorkerModel, type ShipIssue, type ShipRun } from './issue-shipping.ts';
import type { SpawnReceipt, SpawnState } from './agent-results';
import { shippingWorkerSettled } from './issue-shipping.ts';
import { checkState } from './pull-request-checks.ts';
import { taskCheckpointSchema } from './task-checkpoint.ts';
import {
  evidenceManifestsSchema,
  evidenceReadiness,
  recordTaskEvidence,
  type EvidenceReadiness,
  type TaskEvidence,
} from './task-evidence.ts';

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
  headRefOid: string;
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
  sequence?: number;
  revision?: string;
  mutationGeneration?: string;
  baseRevision?: string;
  revisionDrifted?: boolean;
  verdict?: GateVerdict;
  reason?: string;
  evidenceCriteria?: string[];
  evidenceOutputReference?: string;
  evidenceTimestamp?: number;
  evidenceSequence?: number;
};

export function nextGateSequence(gates: Pick<ShipGate, 'sequence'>[]): number {
  return Math.max(gates.length, ...gates.map((gate) => (gate.sequence ?? -1) + 1));
}
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

export function completedInlineShipGate(
  gate: Omit<ShipGate, 'state' | 'created' | 'updated' | 'revision'> & { revision: string },
  now: number,
): ShipGate {
  return { ...gate, revision: gate.revision, state: 'completed', created: now, updated: now };
}

export function requiredValidationGatesSatisfied(
  policy:
    | Pick<
        NonNullable<ShipIssue['validationPolicy']>,
        'requiredGates' | 'revision' | 'baseRevision'
      >
    | undefined,
  gates: ShipGate[],
): boolean {
  if (!policy) return false;
  return policy.requiredGates.every((name) => {
    const gate = gates
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) =>
          item.gate === name &&
          item.revision === policy.revision &&
          (policy.baseRevision === undefined || item.baseRevision === policy.baseRevision),
      )
      .toSorted(
        (left, right) =>
          (right.item.sequence ?? right.index) - (left.item.sequence ?? left.index) ||
          right.item.updated - left.item.updated ||
          right.item.created - left.item.created,
      )[0]?.item;
    if (!gate || gate.state !== 'completed') return false;
    return name === 'test-adversary' ? gate.verdict === 'PASS' : gate.verdict === 'CLEAN';
  });
}

export const gateMetadataSchema = z.object({
  gate: z.enum(gateNames),
  requestedModel: z.string(),
  sequence: z.number().int().nonnegative().optional(),
  revision: z.string().min(1).optional(),
  mutationGeneration: z.string().min(1).optional(),
  baseRevision: z.string().min(1).optional(),
  revisionDrifted: z.boolean().optional(),
  verdict: z.enum(verdicts).optional(),
  reason: z.string().optional(),
  evidenceCriteria: z.array(z.string().min(1).max(2000)).max(100).optional(),
  evidenceOutputReference: z.string().min(1).max(2000).optional(),
  evidenceTimestamp: z.number().int().nonnegative().optional(),
  evidenceSequence: z.number().int().positive().optional(),
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
      criteria: z.array(z.string().min(1).max(2000)).max(100).optional(),
      outputReference: z.string().min(1).max(2000).optional(),
      revision: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      verdict: z.enum(verdicts),
      reason: z.string().max(2000).optional(),
      criteria: z.array(z.string().min(1).max(2000)).max(100).optional(),
      outputReference: z.string().min(1).max(2000).optional(),
    })
    .strict(),
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

export function validationRevisionDrifted(
  validation: Pick<GateMetadata, 'revision' | 'revisionDrifted'>,
  currentRevision: string,
): boolean {
  return (
    validation.revisionDrifted === true ||
    (validation.revision !== undefined && validation.revision !== currentRevision)
  );
}

export async function commitRevisionBoundValidation<T>({
  expectedRevision,
  expectedMutationGeneration,
  expectedBaseRevision,
  readRevision,
  readMutationGeneration,
  readBaseRevision,
  prepare,
  commit,
}: {
  expectedRevision: string | undefined;
  expectedMutationGeneration: string | undefined;
  expectedBaseRevision?: string;
  readRevision: () => Promise<string>;
  readMutationGeneration: () => Promise<string>;
  readBaseRevision?: () => Promise<string>;
  prepare: () => Promise<T>;
  commit: (prepared: T) => Promise<(() => Promise<void>) | void>;
}): Promise<void> {
  if (!expectedRevision)
    throw new Error('Validation needs the revision captured before execution.');
  const verifyBoundary = async () => {
    if ((await readRevision()) !== expectedRevision)
      throw new Error('The worktree changed during validation. Rerun the gate.');
    if (
      expectedMutationGeneration !== undefined &&
      (await readMutationGeneration()) !== expectedMutationGeneration
    )
      throw new Error('The worktree was modified during validation. Rerun the gate.');
    if (expectedBaseRevision !== undefined && (await readBaseRevision?.()) !== expectedBaseRevision)
      throw new Error('The shipping base changed during validation. Rerun the gate.');
  };
  await verifyBoundary();
  const prepared = await prepare();
  await verifyBoundary();
  const rollback = await commit(prepared);
  try {
    await verifyBoundary();
  } catch (cause) {
    await rollback?.();
    throw cause;
  }
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

export function shipCheckpointOwner(runs: ShipRun[], directory: string, threadId: string) {
  const owner = shipOwner(runs, directory, threadId);
  if (owner) return owner;
  for (const run of runs) {
    const issue = run.issues.find(
      (item) => item.path === directory && item.checkpointThreadIds?.includes(threadId),
    );
    if (issue) return { run, issue };
  }
  return undefined;
}

export function authorizeShipCheckpointThread(
  runs: ShipRun[],
  sourceDirectory: string,
  sourceId: string,
  targetDirectory: string | null,
  targetId: string | null,
): boolean {
  const owner = shipCheckpointOwner(runs, sourceDirectory, sourceId);
  if (!owner || !targetId || targetDirectory !== owner.issue.path) return false;
  if (owner.issue.checkpointThreadIds?.includes(targetId)) return false;
  owner.issue.checkpointThreadIds = [...(owner.issue.checkpointThreadIds ?? []), targetId];
  return true;
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

export function shipCleanupRequest(
  repository: string,
  issue: ShipIssue,
  currentRevision: string | undefined,
) {
  if (!issue.path) throw new Error('Ship cleanup requires a worktree.');
  if (!shipEvidenceReadiness(issue).ready)
    throw new Error('Ship cleanup requires complete revision-bound evidence.');
  const expectedRevision =
    issue.validationPolicy?.revision ?? issue.checkpoint?.revision ?? currentRevision;
  if (!expectedRevision) throw new Error('Ship cleanup requires a verified worktree revision.');
  return {
    repository,
    worktree: issue.path,
    force: false,
    archiveIgnored: true,
    expectedRevision,
    expectedBranch: issue.branch,
  };
}

export function shipEvidenceReadiness(issue: ShipIssue): EvidenceReadiness {
  if (!issue.checkpoint)
    return {
      ready: false,
      stale: false,
      missingGates: [],
      failedGates: [],
      pendingGates: [],
      failedCommands: [],
      pendingCommands: [],
      unverifiedCriteria: [],
      reason: 'Task checkpoint is missing.',
    };
  const readiness = evidenceReadiness(
    issue.evidenceManifests ?? [],
    issue.evidenceRevision,
    issue.checkpoint.requiredGates,
    issue.checkpoint.acceptanceCriteria,
    issue.validationPolicy?.baseRevision,
  );
  if (
    issue.validationPolicyRequired !== false &&
    !requiredValidationGatesSatisfied(issue.validationPolicy, issue.gates ?? [])
  )
    return {
      ...readiness,
      ready: false,
      reason:
        readiness.reason ??
        'Required validation gates are not completed for the selected revision.',
    };
  if (issue.refreshError)
    return {
      ...readiness,
      ready: false,
      reason: readiness.reason ?? `Pull request refresh failed: ${issue.refreshError}`,
    };
  if (issue.pullRequest && issue.pullRequestHead !== issue.evidenceCommit)
    return {
      ...readiness,
      ready: false,
      reason: readiness.reason ?? 'Evidence commit does not match the pull request head.',
    };
  if (!issue.pullRequest || !issue.checks?.length || !issue.evidenceRevision) return readiness;
  const manifest = (issue.evidenceManifests ?? []).find(
    (candidate) =>
      candidate.revision === issue.evidenceRevision &&
      candidate.baseRevision === (issue.validationPolicy?.baseRevision ?? null) &&
      !candidate.stale,
  );
  const latestCommands = new Map<string, TaskEvidence>();
  for (const entry of manifest?.evidence ?? [])
    if (entry.kind === 'command') latestCommands.set(entry.name, entry);
  const missingChecks = issue.checks
    .filter((check) => {
      const entry = latestCommands.get(`ci:${check.name}`);
      return !entry || entry.provider !== 'github';
    })
    .map((check) => check.name);
  if (!missingChecks.length) return readiness;
  return {
    ...readiness,
    ready: false,
    reason: readiness.reason ?? `Revision-bound CI evidence missing: ${missingChecks.join(', ')}.`,
  };
}

export function recoverValidationEvidence(
  issue: ShipIssue,
): Pick<ShipIssue, 'evidenceRevision' | 'evidenceManifests'> | null {
  const checkpoint = issue.checkpoint;
  if (!checkpoint?.revision) return null;
  const revision = checkpoint.revision;
  const baseRevision = issue.validationPolicy?.baseRevision;
  let manifests = issue.evidenceManifests ?? [];
  const gates = (issue.gates ?? []).toSorted(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.created - right.created ||
      left.id.localeCompare(right.id),
  );
  const recoverable = gates.filter(
    (gate) =>
      gate.revision === revision &&
      gate.baseRevision === baseRevision &&
      gate.verdict &&
      gate.evidenceTimestamp !== undefined &&
      gate.evidenceOutputReference,
  );
  const evidenceIds = new Set(recoverable.map((gate) => `gate:${gate.id}`));
  const missing = recoverable.some((gate) =>
    manifests.every((manifest) =>
      manifest.evidence.every((entry) => entry.id !== `gate:${gate.id}`),
    ),
  );
  if (!missing && issue.evidenceRevision === revision) return null;
  if (missing)
    manifests = manifests.map((manifest) => ({
      ...manifest,
      evidence: manifest.evidence.filter((entry) => !evidenceIds.has(entry.id)),
    }));
  for (const gate of recoverable) {
    const evidenceId = `gate:${gate.id}`;
    const criteria = (gate.evidenceCriteria ?? []).filter((criterion) =>
      checkpoint.acceptanceCriteria.includes(criterion),
    );
    const next = recordTaskEvidence(
      manifests,
      revision,
      checkpoint.acceptanceCriteria,
      {
        id: evidenceId,
        kind: 'gate',
        name: gate.gate,
        provider: gate.provider,
        model: gate.model,
        result: ['CLEAN', 'PASS'].includes(gate.verdict!) ? 'passed' : 'failed',
        timestamp: gate.evidenceTimestamp!,
        outputReference: gate.evidenceOutputReference!,
        criteria,
        ...(!missing && gate.evidenceSequence !== undefined
          ? { sequence: gate.evidenceSequence }
          : {}),
      },
      baseRevision,
    );
    manifests = next;
  }
  return { evidenceRevision: revision, evidenceManifests: manifests };
}

export function shipMergeClaim(issue: ShipIssue): string {
  if (issue.state === 'merged') return 'Merged';
  if (!issue.pullRequest) return 'PR not opened';
  if (
    issue.state === 'awaiting_merge' &&
    ciStatus(issue.checks) === 'Passed' &&
    shipEvidenceReadiness(issue).ready
  )
    return 'Ready for merge';
  return 'PR open';
}

export function shipTaskThreadsSettled(
  issue: ShipIssue,
  states: Partial<Record<string, SpawnState>>,
  receipts: Pick<SpawnReceipt, 'receiptId' | 'targetId' | 'state'>[],
): boolean {
  const threadIds = [...new Set([issue.threadId, ...(issue.checkpointThreadIds ?? [])])].filter(
    (threadId): threadId is string => Boolean(threadId),
  );
  return threadIds.every((threadId) => {
    const live = states[threadId] ?? 'unavailable';
    const receipt = receipts.find((item) =>
      threadId === issue.threadId ? item.receiptId === issue.receiptId : item.targetId === threadId,
    );
    if (receipt && !shippingWorkerSettled(receipt.state)) return false;
    if (live !== 'unavailable') return shippingWorkerSettled(live);
    return receipt !== undefined && shippingWorkerSettled(receipt.state);
  });
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
    pullRequestHead: pr.headRefOid,
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

export function beginLatestRefresh(generations: Map<string, number>, key: string): () => boolean {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return () => generations.get(key) === generation;
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
    issue.workerUpdatedAt ?? 0,
    ...gates.map((gate) => gate.updated),
    ...(issue.events ?? []).map((event) => event.at),
  );
  if (issue.state === 'merged')
    return {
      status: 'completed',
      label: 'Completed',
      priority: 4,
      nextAction: 'No action — shipping complete',
      updated: updated || activity.at || null,
    };
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
    const evidence = shipEvidenceReadiness(issue);
    const ready = ci === 'Passed' && evidence.ready;
    return {
      status:
        ci === 'Failed' || (!evidence.ready && !evidence.pendingGates.length) ? 'failed' : 'queued',
      label:
        ci === 'Failed' || (!evidence.ready && !evidence.pendingGates.length)
          ? 'Recovery needed'
          : 'Awaiting merge',
      priority: ci === 'Failed' || !evidence.ready || ready ? 0 : 2,
      nextAction:
        ci === 'Failed'
          ? 'Fix failing CI'
          : ci !== 'Passed'
            ? 'Wait for CI and review'
            : !evidence.ready
              ? (evidence.reason ?? 'Record required evidence')
              : 'Merge the pull request',
      updated: updated || activity.at || null,
    };
  }
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
  pullRequestHead: z.string().min(1).optional(),
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
  workerUpdatedAt: z.number().optional(),
  modelUncertain: z.boolean().optional(),
  gates: z.array(shipGateSchema).optional(),
  events: z
    .array(z.object({ at: z.number(), stage: z.string(), reason: z.string().optional() }))
    .optional(),
  issueState: z.enum(['OPEN', 'CLOSED']).optional(),
  checks: z.array(z.object({ name: z.string(), state: z.string(), url: z.string() })).optional(),
  refreshedAt: z.number().optional(),
  refreshError: nullableString.optional(),
  checkpoint: taskCheckpointSchema.optional(),
  checkpointThreadIds: z.array(z.string()).optional(),
  evidenceManifests: evidenceManifestsSchema.optional(),
  evidenceRevision: z.string().min(1).optional(),
  evidenceCommit: z.string().min(1).optional(),
  validationPolicyRequired: z.boolean().default(true),
  validationPolicy: z
    .object({
      risk: z.enum(['low', 'medium', 'high']),
      requiredGates: z.array(z.enum(gateNames)),
      sources: z.array(z.string().min(1)).min(1),
      revision: z.string().min(1),
      mutationGeneration: z.string().min(1).optional(),
      baseRevision: z.string().min(1).optional(),
      changedPaths: z.array(z.string()),
      selectedAt: z.number().int().nonnegative(),
      history: z.array(
        z.object({
          requestedRisk: z.enum(['low', 'medium', 'high']).nullable(),
          selectedRisk: z.enum(['low', 'medium', 'high']),
          sources: z.array(z.string().min(1)).min(1),
          at: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
  shippingTarget: z
    .object({
      repository: z.string().min(1),
      remote: z.string().min(1),
      baseBranch: z.string().min(1),
      baseRef: z.string().min(1),
      baseRevision: z.string().min(1),
    })
    .optional(),
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

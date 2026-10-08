import { z } from 'zod';
import {
  defaultMergeOwner,
  resolvedWorkerModel,
  shipDependents,
  type MergeOwner,
  type ShipIssue,
  type ShipRun,
} from './issue-shipping.ts';
import type { SpawnReceipt, SpawnState } from './agent-results';
import { shippingWorkerSettled } from './issue-shipping.ts';
import { checkState } from './pull-request-checks.ts';
import { taskCheckpointSchema } from './task-checkpoint.ts';
import { taskEconomicsSchema, type TaskEconomics } from './task-economics.ts';
import type { ContextHandoff } from './context-handoff.ts';
import {
  evidenceManifestsSchema,
  evidenceReadiness,
  nextTaskEvidenceSequence,
  recordTaskEvidence,
  type EvidenceManifest,
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
  'awaiting_merge',
] as const;
export const verdicts = ['CLEAN', 'NEEDS_FIXES', 'PASS', 'FAIL', 'BLOCKED'] as const;
export type GateVerdict = (typeof verdicts)[number];
export type ShipCheck = {
  name: string;
  state: string;
  url: string;
  databaseId?: number;
  runId?: number;
  attempt?: number;
  statusContextId?: string;
  revision?: string;
  workflow?: string;
  identityUncertain?: boolean;
};
export type ShippingPullRequest = {
  url: string;
  state: string;
  mergedAt: string | null;
  headRefOid: string;
  mergeable?: boolean | null;
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
  reason?: string;
  link?: { label: string; url: string };
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
  evidenceEconomics?: TaskEconomics;
  protocolVersion?: 2;
};

export function nextGateSequence(gates: Pick<ShipGate, 'sequence'>[]): number {
  return Math.max(0, ...gates.map((gate, index) => (gate.sequence ?? index) + 1));
}

export function nextValidationReservation(
  gates: Pick<ShipGate, 'sequence' | 'evidenceSequence'>[],
  manifests: EvidenceManifest[],
): { sequence: number; evidenceSequence: number } {
  return {
    sequence: nextGateSequence(gates),
    evidenceSequence: Math.max(
      nextTaskEvidenceSequence(manifests),
      ...gates.map((gate) => (gate.evidenceSequence ?? 0) + 1),
    ),
  };
}

export function reserveInlineValidation(
  reservations: Map<string, { sequence: number; evidenceSequence: number }>,
  key: string,
  gates: Pick<ShipGate, 'sequence' | 'evidenceSequence'>[],
  manifests: EvidenceManifest[],
): { sequence: number; evidenceSequence: number } {
  const recorded = nextValidationReservation(gates, manifests);
  const previous = reservations.get(key);
  const reserved = {
    sequence: Math.max(recorded.sequence, (previous?.sequence ?? -1) + 1),
    evidenceSequence: Math.max(recorded.evidenceSequence, (previous?.evidenceSequence ?? 0) + 1),
  };
  reservations.set(key, reserved);
  return reserved;
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
  evidenceEconomics: taskEconomicsSchema.optional(),
  protocolVersion: z.literal(2).optional(),
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
      economics: taskEconomicsSchema.optional(),
      revision: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      verdict: z.enum(verdicts),
      reason: z.string().max(2000).optional(),
      criteria: z.array(z.string().min(1).max(2000)).max(100).optional(),
      outputReference: z.string().min(1).max(2000).optional(),
      economics: taskEconomicsSchema.optional(),
    })
    .strict(),
]);

export function parseShipReport(value: unknown) {
  const report = reportSchema.parse(value);
  if ('verdict' in report && report.economics) {
    if (report.economics.role !== 'validator')
      throw new Error('Validation verdict economics must use the validator role.');
    if ('gate' in report) {
      const phase = report.gate === 'test-adversary' ? 'test' : 'review';
      if (report.economics.phase !== phase)
        throw new Error(`Validation verdict economics must use the ${phase} phase.`);
    } else if (!['review', 'test'].includes(report.economics.phase))
      throw new Error('Validation verdict economics must use a validation phase.');
  }
  if (
    ('status' in report && report.status === 'blocked') ||
    ('verdict' in report && ['BLOCKED', 'FAIL', 'NEEDS_FIXES'].includes(report.verdict))
  ) {
    if (!report.reason?.trim()) throw new Error('A blocked or failed report needs a reason.');
  }
  return report;
}

export function requireValidatorEconomics(
  report: ReturnType<typeof parseShipReport>,
  allowLegacyMissing: boolean,
): void {
  if ('verdict' in report && !report.economics && !allowLegacyMissing)
    throw new Error('Validation verdicts require validator economics.');
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
  commit: (prepared: T, registerRollback: (rollback: () => Promise<void>) => void) => Promise<void>;
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
  let rollback: (() => Promise<void>) | undefined;
  try {
    await commit(prepared, (candidate) => (rollback = candidate));
    await verifyBoundary();
  } catch (cause) {
    try {
      await rollback?.();
    } catch (rollbackCause) {
      throw new Error(`Validation commit failed (${String(cause)}) and rollback failed.`, {
        cause: rollbackCause,
      });
    }
    throw cause;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restoreIfUnchanged<T>(value: T, previousValue: T, committedValue: T): T {
  return sameValue(value, committedValue) ? previousValue : value;
}

export function rollbackValidationReceipt(
  current: SpawnReceipt,
  previous: SpawnReceipt,
  committed: SpawnReceipt,
): SpawnReceipt {
  if (!current.validation || !previous.validation || !committed.validation) return current;
  const validation = {
    ...current.validation,
    verdict: restoreIfUnchanged(
      current.validation.verdict,
      previous.validation.verdict,
      committed.validation.verdict,
    ),
    reason: restoreIfUnchanged(
      current.validation.reason,
      previous.validation.reason,
      committed.validation.reason,
    ),
    evidenceCriteria: restoreIfUnchanged(
      current.validation.evidenceCriteria,
      previous.validation.evidenceCriteria,
      committed.validation.evidenceCriteria,
    ),
    evidenceOutputReference: restoreIfUnchanged(
      current.validation.evidenceOutputReference,
      previous.validation.evidenceOutputReference,
      committed.validation.evidenceOutputReference,
    ),
    evidenceTimestamp: restoreIfUnchanged(
      current.validation.evidenceTimestamp,
      previous.validation.evidenceTimestamp,
      committed.validation.evidenceTimestamp,
    ),
    evidenceSequence: restoreIfUnchanged(
      current.validation.evidenceSequence,
      previous.validation.evidenceSequence,
      committed.validation.evidenceSequence,
    ),
    evidenceEconomics: restoreIfUnchanged(
      current.validation.evidenceEconomics,
      previous.validation.evidenceEconomics,
      committed.validation.evidenceEconomics,
    ),
  };
  return { ...current, validation };
}

function rollbackEvidenceEntry(
  current: EvidenceManifest[],
  previous: EvidenceManifest[],
  committed: EvidenceManifest[],
  evidenceId: string,
): EvidenceManifest[] {
  return current.map((manifest) => {
    const matches = (candidate: EvidenceManifest) =>
      candidate.revision === manifest.revision && candidate.baseRevision === manifest.baseRevision;
    const previousEntry = previous.find(matches)?.evidence.find((entry) => entry.id === evidenceId);
    const committedEntry = committed
      .find(matches)
      ?.evidence.find((entry) => entry.id === evidenceId);
    const currentIndex = manifest.evidence.findIndex((entry) => entry.id === evidenceId);
    if (currentIndex < 0 || !sameValue(manifest.evidence[currentIndex], committedEntry))
      return manifest;
    return {
      ...manifest,
      evidence: previousEntry
        ? manifest.evidence.with(currentIndex, previousEntry)
        : manifest.evidence.toSpliced(currentIndex, 1),
    };
  });
}

function removeCommittedEvents(
  current: ShipEvent[] | undefined,
  previous: ShipEvent[] | undefined,
  committed: ShipEvent[] | undefined,
): ShipEvent[] | undefined {
  const removed = [...(current ?? [])];
  const previousCounts = new Map<string, number>();
  for (const event of previous ?? []) {
    const key = JSON.stringify(event);
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  }
  const added = (committed ?? []).filter((event) => {
    const key = JSON.stringify(event);
    const count = previousCounts.get(key) ?? 0;
    if (!count) return true;
    previousCounts.set(key, count - 1);
    return false;
  });
  for (const event of added) {
    const index = removed.findIndex((candidate) => sameValue(candidate, event));
    if (index >= 0) removed.splice(index, 1);
  }
  return removed;
}

type ValidationIssueSnapshot = Pick<
  ShipIssue,
  'evidenceRevision' | 'evidenceManifests' | 'stage' | 'blockedReason' | 'gates' | 'events'
>;

export function rollbackValidationIssue(
  current: ShipIssue,
  previous: ValidationIssueSnapshot,
  committed: ValidationIssueSnapshot,
  evidenceId: string,
  gateId?: string,
): ValidationIssueSnapshot {
  const restore = <K extends keyof ValidationIssueSnapshot>(key: K) =>
    sameValue(current[key], committed[key]) ? previous[key] : current[key];
  const gates = gateId
    ? (current.gates ?? []).filter((gate) => {
        if (gate.id !== gateId) return true;
        const committedGate = committed.gates?.find((candidate) => candidate.id === gateId);
        return !sameValue(gate, committedGate);
      })
    : current.gates;
  return {
    evidenceRevision: restore('evidenceRevision'),
    evidenceManifests: rollbackEvidenceEntry(
      current.evidenceManifests ?? [],
      previous.evidenceManifests ?? [],
      committed.evidenceManifests ?? [],
      evidenceId,
    ),
    stage: restore('stage'),
    blockedReason: restore('blockedReason'),
    gates,
    events: removeCommittedEvents(current.events, previous.events, committed.events),
  };
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
  observedBaseRevision: string | undefined,
): Pick<ShipIssue, 'evidenceRevision' | 'evidenceManifests'> | null {
  const checkpoint = issue.checkpoint;
  if (!checkpoint?.revision) return null;
  const revision = checkpoint.revision;
  const baseRevision = issue.validationPolicy?.baseRevision;
  if (baseRevision !== observedBaseRevision) return null;
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
        economics: gate.evidenceEconomics,
        ...(gate.evidenceSequence !== undefined ? { sequence: gate.evidenceSequence } : {}),
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
  if (issue.state === 'awaiting_merge' && shipPullRequestReady(issue)) return 'Ready for merge';
  return 'PR open';
}

export function shipOwnedThreadIds(
  issue: ShipIssue,
  receipts: Array<
    Partial<Pick<SpawnReceipt, 'sourceId' | 'sourceDirectory' | 'targetId' | 'targetDirectory'>>
  > = [],
): string[] {
  const lineage = new Set(
    [
      issue.threadId,
      ...(issue.checkpointThreadIds ?? []),
      ...(issue.contextHandoffs ?? []).flatMap((handoff) => [
        handoff.fromThreadId,
        handoff.toThreadId,
      ]),
    ].filter(Boolean),
  );
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const receipt of receipts) {
      if (
        receipt.sourceDirectory !== issue.path ||
        receipt.targetDirectory !== issue.path ||
        !receipt.sourceId ||
        !lineage.has(receipt.sourceId) ||
        !receipt.targetId ||
        lineage.has(receipt.targetId)
      )
        continue;
      lineage.add(receipt.targetId);
      expanded = true;
    }
  }
  return [...lineage].filter((threadId): threadId is string => Boolean(threadId));
}

export function shipTaskThreadsSettled(
  issue: ShipIssue,
  states: Partial<Record<string, SpawnState>>,
  receipts: Array<
    Pick<SpawnReceipt, 'receiptId' | 'targetId' | 'state'> &
      Partial<
        Pick<SpawnReceipt, 'sourceId' | 'sourceDirectory' | 'targetDirectory' | 'dispatchPending'>
      >
  >,
  discoveredThreadIds: Iterable<string> = [],
): boolean {
  const threadIds = [
    ...new Set([
      ...shipOwnedThreadIds(issue, receipts),
      ...discoveredThreadIds,
      ...(issue.contextHandoffs ?? []).flatMap((handoff) => [
        handoff.fromThreadId,
        handoff.toThreadId,
      ]),
    ]),
  ].filter((threadId): threadId is string => Boolean(threadId));
  return threadIds.every((threadId) => {
    const live = states[threadId] ?? 'unavailable';
    const matchingReceipts = receipts.filter(
      (item) =>
        (threadId === issue.threadId && item.receiptId === issue.receiptId) ||
        (item.targetId === threadId &&
          (item.targetDirectory === undefined || item.targetDirectory === issue.path)),
    );
    if (
      matchingReceipts.some(
        (receipt) => receipt.dispatchPending || !shippingWorkerSettled(receipt.state),
      )
    )
      return false;
    if (live !== 'unavailable') return shippingWorkerSettled(live);
    return (
      matchingReceipts.length > 0 &&
      matchingReceipts.every(
        (receipt) => !receipt.dispatchPending && shippingWorkerSettled(receipt.state),
      )
    );
  });
}

export function shipOwnershipQuietGeneration(
  nativeSubagentGeneration: number,
  nativeGeneration: number,
  openCodeDescendants: Iterable<string>,
): string {
  return JSON.stringify([
    nativeSubagentGeneration,
    nativeGeneration,
    ...[...new Set(openCodeDescendants)].toSorted(),
  ]);
}

export function shipOwnershipQuietPass(
  previousGeneration: number | null,
  currentGeneration: number,
  hasUnsettledOwnership: boolean,
): { settled: boolean; nextGeneration: number | null } {
  if (hasUnsettledOwnership) return { settled: false, nextGeneration: null };
  return {
    settled: previousGeneration === currentGeneration,
    nextGeneration: currentGeneration,
  };
}

export function shipTaskReceiptIdsToProtect(
  issue: ShipIssue,
  receipts: Pick<
    SpawnReceipt,
    'receiptId' | 'targetId' | 'targetDirectory' | 'state' | 'dispatchPending'
  >[],
): string[] {
  const ownedThreadIds = new Set([issue.threadId, ...(issue.checkpointThreadIds ?? [])]);
  return receipts
    .filter(
      (receipt) =>
        (receipt.receiptId === issue.receiptId &&
          (issue.workerSettled !== true || issue.claim?.status === 'active')) ||
        (!!issue.path &&
          ownedThreadIds.has(receipt.targetId) &&
          receipt.targetDirectory === issue.path &&
          (receipt.dispatchPending === true || !shippingWorkerSettled(receipt.state))),
    )
    .map((receipt) => receipt.receiptId);
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
    pullRequestState: pr.state,
    pullRequestMergeable: pr.mergeable ?? null,
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

export const closedBeforeLaunch = 'Issue closed before its worker launched.';
export const closedWithoutMerge = 'Pull request closed without merging.';

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

const fixVerdicts = new Set<string>(['NEEDS_FIXES', 'FAIL']);

export function currentShipGates(issue: ShipIssue): ShipGate[] {
  const gates = issue.gates ?? [];
  return gateNames.flatMap((name) => {
    const gate = gates
      .filter((candidate) => candidate.gate === name)
      .toSorted((left, right) => right.updated - left.updated)[0];
    return gate ? [gate] : [];
  });
}

function workerRunning(issue: ShipIssue): boolean {
  return (
    ['starting', 'working'].includes(issue.state) &&
    !['waiting', 'unavailable', 'completed', 'failed', 'interrupted'].includes(
      issue.workerState ?? '',
    )
  );
}

export function shipClosedBeforeLaunch(issue: ShipIssue): boolean {
  return issue.state === 'failed' && issue.error === closedBeforeLaunch;
}

export function shipClosedWithoutMerge(issue: ShipIssue): boolean {
  if (issue.state === 'merged') return false;
  return (
    issue.pullRequestState === 'CLOSED' ||
    (issue.state === 'failed' && issue.error === closedWithoutMerge)
  );
}

/** Gate attempts that sent the worker back to fix findings. */
export function shipFixRounds(issue: ShipIssue): number {
  return (issue.gates ?? []).filter((gate) => fixVerdicts.has(gate.verdict ?? '')).length;
}

function fixingGate(issue: ShipIssue): ShipGate | undefined {
  return currentShipGates(issue).find((gate) => fixVerdicts.has(gate.verdict ?? ''));
}

function legacyFindingsBlock(issue: ShipIssue): boolean {
  return (issue.gates ?? []).some(
    (gate) => fixVerdicts.has(gate.verdict ?? '') && gate.reason === issue.blockedReason,
  );
}

/**
 * The reason the worker needs the user, or null while it works on its own.
 * Older Sail versions persisted the findings of NEEDS_FIXES and FAIL verdicts
 * as `blockedReason`; those never count as a block.
 */
export function shipBlock(issue: ShipIssue): string | null {
  const checkpointBlocker =
    issue.checkpoint?.status === 'blocked' ? issue.checkpoint.blocker : null;
  const gates = currentShipGates(issue);
  const blockedGate = gates.find((gate) => gate.verdict === 'BLOCKED');
  if (issue.reportedStatus === 'blocked')
    return checkpointBlocker ?? issue.blockedReason ?? 'The worker reported a blocker.';
  if (blockedGate)
    return checkpointBlocker ?? blockedGate.reason ?? issue.blockedReason ?? 'A gate is blocked.';
  const crashed = gates.find(
    (gate) => ['failed', 'interrupted'].includes(gate.state) || !!gate.error,
  );
  if (crashed)
    return (
      checkpointBlocker ??
      crashed.error ??
      issue.blockedReason ??
      `${titleCase(crashed.gate)} did not finish.`
    );
  if (issue.blockedReason && !legacyFindingsBlock(issue)) return issue.blockedReason;
  return null;
}

export function shipPullRequestReady(issue: ShipIssue): boolean {
  const ci = ciStatus(issue.checks);
  return (
    !!issue.pullRequest &&
    issue.pullRequestState === 'OPEN' &&
    issue.pullRequestMergeable === true &&
    (ci === 'Passed' || ci === 'No checks') &&
    shipEvidenceReadiness(issue).ready &&
    !!issue.pullRequestHead &&
    issue.pullRequestHead === issue.checkpoint?.revision
  );
}

function awaitingMerge(issue: ShipIssue): boolean {
  return (
    issue.state === 'awaiting_merge' || (issue.stage === 'awaiting_merge' && !!issue.pullRequest)
  );
}

type DependencyWait = { number: number; url: string | undefined; failed: boolean };

function dependencyWait(run: ShipRun, issue: ShipIssue): DependencyWait | null {
  const waits: DependencyWait[] = [];
  for (const reference of issue.dependsOn) {
    const dependency = dependencyIssue(run, reference);
    if (dependency?.state === 'merged') continue;
    if (!dependency && run.externalClosed[reference]) continue;
    const number = dependency?.number ?? Number(/(\d+)$/.exec(reference)?.[1] ?? Number.NaN);
    if (!Number.isSafeInteger(number)) continue;
    waits.push({
      number,
      url: dependency?.url ?? dependencyUrl(run.remote, reference),
      failed: dependency?.state === 'failed',
    });
  }
  return waits.find((wait) => wait.failed) ?? waits[0] ?? null;
}

export type ShipPresentationOptions = { mergeOwner?: MergeOwner };

export function shipStatus(run: ShipRun, issue: ShipIssue): string {
  if (issue.state === 'merged') return 'Merged';
  if (shipClosedBeforeLaunch(issue)) return 'Closed';
  if (shipClosedWithoutMerge(issue)) return 'Closed without merge';
  if (issue.state === 'failed') return 'Failed';
  if (shipBlock(issue)) return 'Blocked';
  if (issue.state === 'pending') {
    const wait = dependencyWait(run, issue);
    if (wait?.failed) return 'Blocked';
    return wait ? 'Waiting' : 'Queued';
  }
  if (issue.workerState === 'waiting') return 'Waiting for input';
  if (issue.workerState === 'unavailable') return 'Reconnecting';
  if (fixingTitle(issue)) return 'Fixing';
  if (awaitingMerge(issue)) return 'Awaiting merge';
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

function fixingTitle(issue: ShipIssue): string | null {
  if (!workerRunning(issue)) return null;
  if (fixingGate(issue)) return `Fixing · round ${Math.max(1, shipFixRounds(issue))}`;
  if (ciStatus(issue.checks) === 'Failed') return 'Fixing (CI)';
  return null;
}

export function shipActivity(run: ShipRun, issue: ShipIssue): ShipActivity {
  const latestEvent = issue.events?.at(-1);
  const activeGate = (issue.gates ?? [])
    .filter((gate) => !shippingWorkerSettled(gate.state))
    .toSorted((left, right) => right.updated - left.updated)[0];
  if (issue.state === 'merged')
    return {
      state: 'complete',
      title: 'Merged',
      detail: 'Shipping complete.',
      at: latestEvent?.at,
    };
  if (shipClosedBeforeLaunch(issue))
    return {
      state: 'complete',
      title: 'Closed',
      detail: 'The issue was closed before its worker launched.',
      at: latestEvent?.at,
    };
  if (shipClosedWithoutMerge(issue))
    return {
      state: 'blocked',
      title: 'Closed without merge',
      detail: 'The pull request was closed without merging.',
      at: latestEvent?.at,
    };
  const block = shipBlock(issue);
  if (block)
    return {
      state: 'blocked',
      title: `Blocked during ${titleCase(issue.stage ?? 'shipping')}`,
      detail: block,
      at: latestEvent?.at,
    };
  if (issue.state === 'failed')
    return {
      state: 'blocked',
      title: 'Shipping failed',
      detail: issue.error ?? 'Inspect the worker session for the failure.',
      at: latestEvent?.at,
    };
  const fixing = fixingTitle(issue);
  if (fixing)
    return {
      state: 'active',
      title: fixing,
      detail: workerDetail(issue),
      at: latestEvent?.at,
    };
  if (activeGate)
    return {
      state: activeGate.state === 'waiting' ? 'waiting' : 'active',
      title: `${titleCase(activeGate.gate)} — ${titleCase(activeGate.state)}`,
      detail: `Validation gate · ${activeGate.provider} / ${activeGate.model ?? activeGate.requestedModel}`,
      at: activeGate.updated,
    };
  if (awaitingMerge(issue))
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
  const wait = dependencyWait(run, issue);
  if (wait?.failed)
    return {
      state: 'blocked',
      title: 'Blocked by dependency',
      detail: `#${wait.number} needs input before shipping can continue.`,
    };
  if (wait)
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

export function shipIssuePresentation(
  run: ShipRun,
  issue: ShipIssue,
  options: ShipPresentationOptions = {},
): ShipIssuePresentation {
  const mergeOwner = options.mergeOwner ?? defaultMergeOwner;
  const activity = shipActivity(run, issue);
  const gates = issue.gates ?? [];
  const unavailableGate = currentShipGates(issue).find((gate) => gate.state === 'unavailable');
  const waitingGate = currentShipGates(issue).find((gate) => gate.state === 'waiting');
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
  if (shipClosedBeforeLaunch(issue))
    return {
      status: 'completed',
      label: 'Closed',
      priority: 4,
      nextAction: 'No action — the issue was closed before launch',
      updated: updated || null,
    };
  if (shipClosedWithoutMerge(issue))
    return {
      status: 'interrupted',
      label: 'Closed without merge',
      priority: 0,
      nextAction: 'Archive the issue or reopen the pull request',
      updated: updated || null,
    };
  if (issue.state === 'failed')
    return {
      status: 'failed',
      label: 'Recovery needed',
      priority: 0,
      nextAction: 'Inspect the failure and restart shipping',
      updated: updated || null,
    };
  const block = shipBlock(issue);
  if (block)
    return {
      status: 'waiting',
      label: 'Needs input',
      priority: 0,
      nextAction: block,
      reason: block,
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
  const fixing = fixingTitle(issue);
  if (fixing)
    return {
      status: 'fixing',
      label: fixing,
      priority: 1,
      nextAction: 'No action — the worker is fixing it',
      updated: updated || activity.at || null,
    };
  if (awaitingMerge(issue) && mergeOwner === 'you' && shipPullRequestReady(issue)) {
    const unblocks = shipDependents(run, issue).length;
    return {
      status: 'ready',
      label: 'Ready to merge',
      priority: 0,
      nextAction: unblocks
        ? `Merge #${issue.number} to unblock ${unblocks} ${unblocks === 1 ? 'issue' : 'issues'}`
        : 'Merge the pull request',
      updated: updated || activity.at || null,
    };
  }
  if (awaitingMerge(issue)) {
    const ci = ciStatus(issue.checks);
    const ciSettled = ci === 'Passed' || ci === 'No checks';
    const evidence = shipEvidenceReadiness(issue);
    const ready = ciSettled && evidence.ready;
    const failed = ci === 'Failed' || (!evidence.ready && !evidence.pendingGates.length);
    return {
      status: failed ? 'failed' : 'queued',
      label: failed ? 'Recovery needed' : 'Awaiting merge',
      priority: failed || !evidence.ready || ready ? 0 : 2,
      nextAction:
        ci === 'Failed'
          ? 'Fix failing CI'
          : !ciSettled
            ? 'Wait for CI and review'
            : !evidence.ready
              ? (evidence.reason ?? 'Record required evidence')
              : 'Merge the pull request',
      updated: updated || activity.at || null,
    };
  }
  if (issue.state === 'starting' || issue.state === 'working' || activity.state === 'active')
    return {
      status: 'working',
      label: 'Working',
      priority: 1,
      nextAction: `${activity.title} in progress`,
      updated: updated || activity.at || null,
    };
  const wait = dependencyWait(run, issue);
  if (wait?.failed)
    return {
      status: 'waiting',
      label: `Waiting on #${wait.number} (needs input)`,
      priority: 0,
      nextAction: `Resolve #${wait.number}`,
      ...(wait.url ? { link: { label: `#${wait.number}`, url: wait.url } } : {}),
      updated: updated || null,
    };
  if (wait)
    return {
      status: 'queued',
      label: `Waiting on #${wait.number}`,
      priority: 3,
      nextAction: 'Wait for dependencies',
      ...(wait.url ? { link: { label: `#${wait.number}`, url: wait.url } } : {}),
      updated: updated || null,
    };
  return {
    status: 'queued',
    label: 'Queued',
    priority: 2,
    nextAction: 'Wait for an available worker',
    updated: updated || null,
  };
}

export function sortShipIssues(run: ShipRun, options: ShipPresentationOptions = {}): ShipIssue[] {
  return run.issues.toSorted((left, right) => {
    const priority =
      shipIssuePresentation(run, left, options).priority -
      shipIssuePresentation(run, right, options).priority;
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
const shippingClaimSchema = z.object({
  id: z.string(),
  instanceId: z.string().min(1).optional(),
  holder: z.string(),
  task: z.string(),
  acquiredAt: z.string(),
  heartbeatAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(['active', 'released']),
  releasedAt: z.string().optional(),
  releaseReason: z.string().optional(),
  takeoverOf: z.string().optional(),
  releasedHeartbeatAt: z.string().optional(),
  releasedExpiresAt: z.string().optional(),
  releasedCommentUpdatedAtMillis: z.number().int().nonnegative().optional(),
  commentId: z.number().int().positive(),
  commentUpdatedAtMillis: z.number().int().nonnegative().optional(),
});
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
const checkpointReconciliationSchema = z.object({
  revisionMatches: z.boolean(),
  resumable: z.boolean(),
  deliveryState: z.string(),
  issueState: z.string(),
  reason: nullableString,
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
  reportedStatus: z.enum(['running', 'blocked']).optional(),
  pullRequestState: z.string().optional(),
  pullRequestMergeable: z.boolean().nullable().optional(),
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
  checks: z
    .array(
      z.object({
        name: z.string(),
        state: z.string(),
        url: z.string(),
        databaseId: z.number().int().positive().optional(),
        runId: z.number().int().positive().optional(),
        attempt: z.number().int().positive().optional(),
        statusContextId: z.string().min(1).optional(),
        revision: z.string().min(1).optional(),
        workflow: z.string().min(1).optional(),
        identityUncertain: z.boolean().optional(),
      }),
    )
    .optional(),
  ciTriages: z
    .array(
      z.object({
        id: z.string().min(1),
        revision: z.string().min(1),
        workflow: z.string().min(1),
        job: z.string().min(1),
        attempt: z.number().int().positive(),
        classification: z.enum(['code', 'flaky', 'infrastructure', 'unknown']),
        excerpt: z.string(),
        url: z.string(),
        routedAt: z.number().int().nonnegative(),
        resolvedAt: z.number().int().nonnegative().nullable(),
        recurrence: z.number().int().positive(),
        rerunAllowed: z.boolean(),
        rerunReason: z.string().min(1),
      }),
    )
    .max(200)
    .optional(),
  refreshedAt: z.number().optional(),
  refreshError: nullableString.optional(),
  claimFencePending: z.boolean().optional(),
  claimRevalidationPending: z.boolean().optional(),
  claimHandoffPending: z.boolean().optional(),
  dispatchFencePending: z.boolean().optional(),
  claim: shippingClaimSchema.optional(),
  checkpoint: taskCheckpointSchema.optional(),
  checkpointReconciliation: checkpointReconciliationSchema.optional(),
  checkpointThreadIds: z.array(z.string()).optional(),
  contextCompactions: z
    .object({
      claude: z.number().int().nonnegative().optional(),
      codex: z.number().int().nonnegative().optional(),
      opencode: z.number().int().nonnegative().optional(),
    })
    .optional(),
  contextEventIds: z.array(z.string().min(1)).max(200).optional(),
  contextHandoffs: z
    .array(
      z.object({
        id: z.string().min(1),
        provider: z.enum(['claude', 'codex', 'opencode']),
        fromThreadId: z.string().min(1),
        toThreadId: z.string().nullable(),
        context: z.number().min(0).max(100),
        compactions: z.number().int().nonnegative(),
        checkpointSequence: z.number().int().nonnegative(),
        revision: z.string().nullable(),
        offeredAt: z.number().int().nonnegative(),
        startedAt: z.number().int().nonnegative().nullable(),
        retriesBefore: z.number().int().nonnegative(),
        lostStateFailuresBefore: z.number().int().nonnegative(),
        retriesAfter: z.number().int().nonnegative().nullable(),
        lostStateFailuresAfter: z.number().int().nonnegative().nullable(),
        outcome: z
          .enum(['pending', 'reduced', 'unchanged', 'no_regression', 'regressed', 'failed'])
          .transform((outcome): ContextHandoff['outcome'] =>
            outcome === 'reduced' || outcome === 'unchanged' ? 'no_regression' : outcome,
          ),
        error: z.string().nullable(),
      }),
    )
    .max(100)
    .optional(),
  contextCheckpointRequestedAt: z.number().int().nonnegative().optional(),
  contextCheckpointRequestedSequence: z.number().int().nonnegative().optional(),
  contextHandoffOfferedAt: z.number().int().nonnegative().optional(),
  contextHandoffOfferedSequence: z.number().int().nonnegative().optional(),
  contextPercent: z.number().min(0).max(100).optional(),
  contextPercentByThread: z.record(z.string().min(1), z.number().min(0).max(100)).optional(),
  handoffRecoveryRequired: z.boolean().optional(),
  retryCount: z.number().int().nonnegative().optional(),
  lostStateFailures: z.number().int().nonnegative().optional(),
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
      if (!parsed.success) return [];
      for (const issue of parsed.data.issues)
        issue.contextHandoffs = issue.contextHandoffs?.map((handoff) =>
          handoff.outcome === 'pending' &&
          !handoff.toThreadId &&
          handoff.fromThreadId !== issue.threadId
            ? Object.assign({}, handoff, {
                outcome: 'failed' as const,
                error: 'Retired stale handoff offer during recovery.',
              })
            : handoff,
        );
      return [parsed.data];
    });
  } catch {
    return [];
  }
}

export function repositoryForRemote(
  candidates: { path: string; remote: string | null }[],
  remote: string,
  preferred?: string | null,
): string | null {
  const wanted = remote.toLowerCase();
  const matches = candidates.filter((item) => item.remote?.toLowerCase() === wanted);
  return (matches.find((item) => item.path === preferred) ?? matches[0])?.path ?? null;
}

// ACP agents report a vanished session or deleted cwd with these messages.
export function shippingWorkerGone(cause: unknown): boolean {
  const message =
    typeof cause === 'object' && cause && 'message' in cause
      ? String(cause.message)
      : String(cause);
  return /session is not connected|location not found/i.test(message);
}

const missingRepositoryReason = /Repository path does not exist\. Choose an existing directory\.$/;

// Issues stuck before the repair persisted the raw error as their block reason.
export function currentShipBlockedReason(reason: string | undefined | null): string {
  if (!reason) return 'Shipping claim recovery requires worker fencing.';
  return missingRepositoryReason.test(reason)
    ? 'Shipping worktree no longer exists. Start a new run from the project.'
    : reason;
}

// What a run needs once its repository is gone and no checkout can replace it.
export function unrecoverableIssuePlan(
  issue: Pick<
    ShipIssue,
    | 'state'
    | 'workerSettled'
    | 'claim'
    | 'claimFencePending'
    | 'refreshError'
    | 'worktreeUnavailable'
  >,
): 'none' | 'clear' | 'fail' {
  const claimDirty = !!issue.claim || !!issue.claimFencePending || !!issue.refreshError;
  if (issue.state === 'merged' || issue.state === 'awaiting_merge')
    return claimDirty ? 'clear' : 'none';
  if (issue.state === 'failed' && issue.workerSettled === true)
    return claimDirty || issue.worktreeUnavailable !== true ? 'clear' : 'none';
  return 'fail';
}

// A repository can vanish briefly (unmounted volume, permission prompt), so
// in-flight work is only failed once it stayed gone for this long.
const unrecoverableGraceMillis = 10 * 60_000;

export function unrecoverableGraceExpired(deadSince: number, now: number): boolean {
  return now - deadSince >= unrecoverableGraceMillis;
}

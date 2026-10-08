import { gateMetadataSchema, type GateMetadata } from './ship-progress.ts';
import type { AcpTurnEvidence, AgentActivity } from './acp';

export type SpawnState =
  | 'queued'
  | 'starting'
  | 'working'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unavailable';

export type SpawnReceipt = {
  receiptId: string;
  accessKey: string;
  requestId: string;
  project: string;
  sourceId: string;
  sourceDirectory: string;
  targetId: string | null;
  turnId: string | null;
  targetDirectory: string | null;
  worktreeId: string | null;
  provider: 'claude' | 'codex' | 'opencode';
  prompt: string | null;
  state: SpawnState;
  created: number;
  updated: number;
  result: string | null;
  error: string | null;
  activity?: string;
  model?: string;
  validation?: GateMetadata;
};

const states = new Set<SpawnState>([
  'queued',
  'starting',
  'working',
  'waiting',
  'completed',
  'failed',
  'interrupted',
  'unavailable',
]);

export function loadSpawnReceipts(raw: string | null): SpawnReceipt[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    const receipts: SpawnReceipt[] = value.filter(
      (item): item is SpawnReceipt =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.receiptId === 'string' &&
        typeof item.accessKey === 'string' &&
        typeof item.requestId === 'string' &&
        typeof item.project === 'string' &&
        typeof item.sourceId === 'string' &&
        typeof item.sourceDirectory === 'string' &&
        (item.targetId === null || typeof item.targetId === 'string') &&
        (item.turnId === null || typeof item.turnId === 'string') &&
        (item.targetDirectory === null || typeof item.targetDirectory === 'string') &&
        (item.worktreeId === null || typeof item.worktreeId === 'string') &&
        ['claude', 'codex', 'opencode'].includes(String(item.provider)) &&
        (item.prompt === null || typeof item.prompt === 'string') &&
        states.has(item.state) &&
        typeof item.created === 'number' &&
        typeof item.updated === 'number' &&
        (item.result === null || typeof item.result === 'string') &&
        (item.error === null || typeof item.error === 'string') &&
        (item.activity === undefined || typeof item.activity === 'string'),
    );
    for (const receipt of receipts) {
      if (typeof receipt.model !== 'string') delete receipt.model;
      if (!gateMetadataSchema.safeParse(receipt.validation).success) delete receipt.validation;
    }
    return receipts;
  } catch {
    return [];
  }
}

export function saveBoundedReceipt(
  receipts: SpawnReceipt[],
  receipt: SpawnReceipt,
  protectedIds: ReadonlySet<string> = new Set(),
): SpawnReceipt[] {
  const bounded = {
    ...receipt,
    result: receipt.result?.slice(-16_000) ?? null,
    error: receipt.error?.slice(0, 2_000) ?? null,
    activity: receipt.activity?.slice(0, 200),
  };
  let ordinary = 0;
  return [bounded, ...receipts.filter((item) => item.receiptId !== receipt.receiptId)].filter(
    (item) => protectedIds.has(item.receiptId) || ordinary++ < 200,
  );
}

export function receiptForSource(
  receipts: SpawnReceipt[],
  receiptId: string,
  accessKey: string,
  project: string,
  sourceId: string,
  sourceDirectory: string,
): SpawnReceipt | null {
  return (
    receipts.find(
      (item) =>
        item.receiptId === receiptId &&
        item.accessKey === accessKey &&
        item.project === project &&
        item.sourceId === sourceId &&
        item.sourceDirectory === sourceDirectory,
    ) ?? null
  );
}

export function receiptIsSettled(state: SpawnState): boolean {
  return ['completed', 'failed', 'interrupted', 'unavailable'].includes(state);
}

export function receiptNeedsLiveActivity(receipt: SpawnReceipt): boolean {
  return !receiptIsSettled(receipt.state) || (!receipt.result && !receipt.error);
}

export function boundedSpawnOutput(receipt: SpawnReceipt, limit = 4_000): string {
  const output = receipt.result ?? receipt.error ?? '';
  if (output.length <= limit) return output;
  return `…${output.slice(-limit)}`;
}

export function receiptNeedsRefresh(receipt: SpawnReceipt): boolean {
  return (
    !receiptIsSettled(receipt.state) ||
    (receipt.state === 'unavailable' &&
      (!!receipt.validation ||
        receipt.requestId.startsWith('ship:') ||
        receipt.requestId.startsWith('handoff:')))
  );
}

export function spawnPromptDispatchAllowed(receipt: SpawnReceipt | undefined): boolean {
  return !!receipt && !['completed', 'failed', 'interrupted'].includes(receipt.state);
}

export function activeSpawnReceiptForThread(
  receipts: SpawnReceipt[],
  activeReceiptIds: ReadonlySet<string>,
  threadId: string,
  directory: string,
): SpawnReceipt | null {
  return (
    receipts.find(
      (receipt) =>
        receipt.targetId === threadId &&
        receipt.targetDirectory === directory &&
        activeReceiptIds.has(receipt.receiptId) &&
        !receiptIsSettled(receipt.state),
    ) ?? null
  );
}

export function spawnReceiptsForSource(
  receipts: SpawnReceipt[],
  sourceId: string | null,
  directory: string,
): SpawnReceipt[] {
  if (!sourceId) return [];
  return receipts.filter(
    (receipt) => receipt.sourceId === sourceId && receipt.sourceDirectory === directory,
  );
}

export function receiptSourceId(agent: string, sessionId: string): string {
  return agent === 'opencode' ? `opencode:${sessionId}` : `acp:${agent}:${sessionId}`;
}

export function activeSubagentsForSource(
  receipts: SpawnReceipt[],
  sourceId: string,
  directory: string,
): SpawnReceipt[] {
  return spawnReceiptsForSource(receipts, sourceId, directory).filter(
    (receipt) => !receiptIsSettled(receipt.state),
  );
}

export function runningSubagentsForSource(
  receipts: SpawnReceipt[],
  sourceId: string,
  directory: string,
): SpawnReceipt[] {
  return activeSubagentsForSource(receipts, sourceId, directory).filter(
    (receipt) => !!receipt.targetId && (receipt.state === 'working' || receipt.state === 'waiting'),
  );
}

export function isSubagentThread(
  receipts: SpawnReceipt[],
  targetId: string,
  directory: string,
): boolean {
  return receipts.some(
    (receipt) => receipt.targetId === targetId && receipt.targetDirectory === directory,
  );
}

export type SpawnTimelineEntry<T> =
  T | { type: 'spawn-response'; id: string; receipt: SpawnReceipt };

export function withSpawnResponses<T>(
  entries: T[],
  receipts: SpawnReceipt[],
  created: (entry: T) => number | undefined,
): SpawnTimelineEntry<T>[] {
  const finished = receipts
    .filter((receipt) => receiptIsSettled(receipt.state))
    .toSorted((a, b) => a.updated - b.updated);
  const timeline: SpawnTimelineEntry<T>[] = [];
  let next = 0;
  for (const entry of entries) {
    const time = created(entry) ?? 0;
    while (next < finished.length && finished[next].updated < time) {
      const receipt = finished[next++];
      timeline.push({ type: 'spawn-response', id: `spawn:${receipt.receiptId}`, receipt });
    }
    timeline.push(entry);
  }
  for (const receipt of finished.slice(next))
    timeline.push({ type: 'spawn-response', id: `spawn:${receipt.receiptId}`, receipt });
  return timeline;
}

export function acpReceiptState(receipt: SpawnReceipt, activity: AgentActivity | null): SpawnState {
  if (!receipt.targetId || !receipt.turnId || !activity) return 'unavailable';
  const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
  if (
    activity.alive &&
    activity.sessions.includes(sessionId) &&
    activity.activeTurns[sessionId] === receipt.turnId
  )
    return activity.waiting.includes(sessionId) ? 'waiting' : 'working';
  const finished = activity.finished[sessionId];
  if (finished?.turnId !== receipt.turnId) return 'unavailable';
  if (finished.status === 'failed') return 'failed';
  return finished.status === 'interrupted' ? 'interrupted' : 'completed';
}

export function acpPromptHasBackendEvidence(
  receipt: SpawnReceipt,
  activity: AgentActivity | null,
): boolean {
  if (!receipt.targetId || !receipt.turnId || !activity) return false;
  const sessionId = receipt.targetId.slice(`acp:${receipt.provider}:`.length);
  return (
    activity.activeTurns[sessionId] === receipt.turnId ||
    activity.finished[sessionId]?.turnId === receipt.turnId
  );
}

export function acpTurnEvidenceState(evidence: AcpTurnEvidence | null): SpawnState | null {
  if (!evidence) return null;
  if (evidence.status === 'done') return 'completed';
  if (evidence.status === 'failed') return 'failed';
  if (evidence.status === 'interrupted') return 'interrupted';
  return 'unavailable';
}

export function acpTurnDispatchProven(evidence: AcpTurnEvidence | null): boolean {
  return !!evidence && ['dispatched', 'done', 'failed', 'interrupted'].includes(evidence.status);
}

export function acpTurnPromptCanRetry(evidence: AcpTurnEvidence | null): boolean {
  return !evidence || evidence.status === 'prepared';
}

export function acpTurnNeedsProviderInspection(evidence: AcpTurnEvidence | null): boolean {
  return evidence?.status === 'dispatch_uncertain' || evidence?.status === 'dispatched';
}

export function handoffReceiptNeedsResolution(receipt: SpawnReceipt): boolean {
  return (
    receipt.requestId.startsWith('handoff:') &&
    receipt.state === 'unavailable' &&
    receipt.error?.startsWith('Prompt dispatch may have completed before restart;') === true
  );
}

export function resolvedHandoffRecoveryError(
  recoveryRequired: boolean,
  currentError: string | null,
): string | null {
  if (recoveryRequired || !currentError) return currentError;
  return currentError.startsWith('Prompt dispatch may have completed before restart;')
    ? null
    : currentError;
}

type HandoffRecoveryIssue = {
  state: string;
  path?: string | null;
  receiptId?: string | null;
  threadId?: string | null;
  contextHandoffs?: Array<{
    id: string;
    fromThreadId: string;
    toThreadId: string | null;
    outcome: string;
  }>;
};

export function pendingHandoffReplacement(
  issue: HandoffRecoveryIssue,
  receipts: SpawnReceipt[],
): SpawnReceipt | null {
  if (issue.state !== 'working' || !issue.path || !issue.threadId) return null;
  const offer = issue.contextHandoffs?.findLast(
    (handoff) =>
      handoff.fromThreadId === issue.threadId &&
      !handoff.toThreadId &&
      handoff.outcome === 'pending',
  );
  if (!offer) return null;
  return (
    receipts.find(
      (receipt) =>
        receipt.requestId === `handoff:${offer.id}` &&
        receipt.receiptId !== issue.receiptId &&
        receipt.sourceId === offer.fromThreadId &&
        receipt.sourceDirectory === issue.path &&
        receipt.targetDirectory === issue.path &&
        receipt.worktreeId === issue.path &&
        receipt.state === 'starting' &&
        !!receipt.targetId &&
        !!receipt.turnId &&
        !!receipt.prompt,
    ) ?? null
  );
}

export function handoffPromptNeedsRecovery(
  issue: HandoffRecoveryIssue,
  receipt: SpawnReceipt,
): boolean {
  if (
    issue.state !== 'working' ||
    issue.receiptId !== receipt.receiptId ||
    issue.threadId !== receipt.targetId ||
    !['starting', 'working', 'unavailable'].includes(receipt.state) ||
    !receipt.targetId ||
    !receipt.targetDirectory ||
    !receipt.turnId ||
    !receipt.prompt
  )
    return false;
  return !!issue.contextHandoffs?.some(
    (handoff) =>
      receipt.requestId === `handoff:${handoff.id}` &&
      handoff.toThreadId === receipt.targetId &&
      handoff.outcome === 'pending',
  );
}

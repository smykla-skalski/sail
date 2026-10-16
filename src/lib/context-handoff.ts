import { z } from 'zod';
import type { TaskCheckpoint } from './task-checkpoint.ts';
import type { SpawnReceipt } from './agent-results.ts';

export const defaultContextHandoffThreshold = 85;
export const contextCheckpointLead = 10;

export type ContextProvider = 'claude' | 'codex' | 'opencode';

export type ContextHandoff = {
  id: string;
  provider: ContextProvider;
  boundary?: 'draft-published' | 'before-pr-loop';
  brief?: string;
  fromThreadId: string;
  toThreadId: string | null;
  context: number;
  compactions: number;
  checkpointSequence: number;
  revision: string | null;
  offeredAt: number;
  startedAt: number | null;
  retriesBefore: number;
  lostStateFailuresBefore: number;
  retriesAfter: number | null;
  lostStateFailuresAfter: number | null;
  outcome: 'pending' | 'no_regression' | 'regressed' | 'failed';
  error: string | null;
};

export class ContextPressureRecorder {
  readonly #recorded = new Map<string, number>();
  readonly #pending = new Map<string, Promise<void>>();

  record(key: string, context: number, persist: () => Promise<void>): Promise<void> {
    const previous = this.#pending.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.#recorded.get(key) === context) return undefined;
        await persist();
        this.#recorded.set(key, context);
        return undefined;
      });
    this.#pending.set(key, next);
    void next
      .finally(() => {
        if (this.#pending.get(key) === next) this.#pending.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  forget(key: string): void {
    this.#recorded.delete(key);
  }
}

export function updateThreadContextPressure(
  contexts: Record<string, number> | undefined,
  threadId: string,
  context: number,
  pinnedThreadId?: string,
): { previous: number | undefined; contexts: Record<string, number> } {
  const previous = contexts?.[threadId];
  const refreshed = { ...contexts };
  delete refreshed[threadId];
  refreshed[threadId] = context;
  const pinned = pinnedThreadId ? refreshed[pinnedThreadId] : undefined;
  const entries = Object.entries(refreshed).filter(([id]) => id !== pinnedThreadId);
  const recent = entries.slice(-(pinned === undefined ? 100 : 99));
  if (pinnedThreadId && pinned !== undefined) recent.push([pinnedThreadId, pinned]);
  return { previous, contexts: Object.fromEntries(recent) };
}

export function parseContextHandoffThreshold(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 60 && parsed <= 95
    ? parsed
    : defaultContextHandoffThreshold;
}

export function contextPressureStage(
  previous: number | undefined,
  current: number | undefined,
  threshold: number,
): 'checkpoint' | 'handoff' | null {
  if (current === undefined || current < 0 || current > 100) return null;
  const checkpoint = Math.max(1, threshold - contextCheckpointLead);
  if (current >= threshold && (previous === undefined || previous < threshold)) return 'handoff';
  if (current >= checkpoint && (previous === undefined || previous < checkpoint))
    return 'checkpoint';
  return null;
}

export function handoffOutcome(
  handoff: Pick<ContextHandoff, 'retriesBefore' | 'lostStateFailuresBefore'>,
  retries: number,
  lostStateFailures: number,
): Pick<ContextHandoff, 'retriesAfter' | 'lostStateFailuresAfter' | 'outcome'> {
  const retryDelta = retries - handoff.retriesBefore;
  const lostStateDelta = lostStateFailures - handoff.lostStateFailuresBefore;
  return {
    retriesAfter: retries,
    lostStateFailuresAfter: lostStateFailures,
    outcome: retryDelta > 0 || lostStateDelta > 0 ? 'regressed' : 'no_regression',
  };
}

export function transferHandoffOwnership(
  handoff: ContextHandoff,
  toThreadId: string,
  startedAt: number,
  retries: number,
  lostStateFailures: number,
): ContextHandoff {
  return {
    ...handoff,
    toThreadId,
    startedAt,
    retriesBefore: retries,
    lostStateFailuresBefore: lostStateFailures,
  };
}

export function reconcileHandoffOutcomes(
  handoffs: ContextHandoff[] | undefined,
  receipts: Pick<SpawnReceipt, 'requestId' | 'targetId' | 'state' | 'error'>[],
  retries: number,
  lostStateFailures: number,
): ContextHandoff[] | undefined {
  if (!handoffs) return handoffs;
  let changed = false;
  const reconciled = handoffs.map((handoff) => {
    if (handoff.outcome !== 'pending' || !handoff.toThreadId) return handoff;
    const receipt = receipts.find(
      (candidate) =>
        candidate.requestId === `handoff:${handoff.id}` &&
        candidate.targetId === handoff.toThreadId &&
        ['completed', 'failed', 'interrupted'].includes(candidate.state),
    );
    if (!receipt) return handoff;
    changed = true;
    return receipt.state === 'completed'
      ? { ...handoff, ...handoffOutcome(handoff, retries, lostStateFailures) }
      : {
          ...handoff,
          outcome: 'failed' as const,
          error: receipt.error ?? receipt.state,
        };
  });
  return changed ? reconciled : handoffs;
}

export function contextHandoffPrompt(input: {
  checkpoint: TaskCheckpoint;
  branch: string;
  revision: string;
  pullRequest: string | null;
  gates: string[];
}): string {
  return [
    'Continue this Ship task in a fresh thread because the previous thread reached its context threshold.',
    'Read the canonical checkpoint with task_checkpoint_read before acting and reconcile it with the repository state below.',
    'Preserve task ownership, existing evidence, and pending validation gates. Do not repeat completed gates or discard unresolved findings.',
    '',
    `Branch: ${input.branch}`,
    `Revision: ${input.revision}`,
    `Pull request: ${input.pullRequest ?? 'not opened'}`,
    `Recorded gates: ${input.gates.length ? input.gates.join(', ') : 'none'}`,
    '',
    'Checkpoint snapshot:',
    JSON.stringify(input.checkpoint, null, 2),
  ].join('\n');
}

export function phaseHandoffRequest(
  value: unknown,
  checkpoint: TaskCheckpoint,
  handoffs: ContextHandoff[] = [],
  namespace = '',
): { id: string; boundary: 'draft-published' | 'before-pr-loop'; brief: string } | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object') throw new Error('A phase handoff requires a brief.');
  const { id, boundary, brief } = z
    .object({ id: z.unknown(), boundary: z.unknown(), brief: z.unknown() })
    .parse(value);
  if (typeof id !== 'string' || !id.trim()) throw new Error('A phase handoff requires an ID.');
  if (boundary !== 'draft-published' && boundary !== 'before-pr-loop')
    throw new Error('Unknown phase handoff boundary.');
  if (typeof brief !== 'string' || !brief.trim() || new TextEncoder().encode(brief).length > 1999)
    throw new Error('The phase handoff brief must contain 1–1999 UTF-8 bytes.');
  if (
    checkpoint.status !== 'active' ||
    checkpoint.phase !== (boundary === 'draft-published' ? 'review' : 'pr')
  )
    throw new Error('The phase handoff must target an active destination checkpoint.');
  const qualifiedId = namespace ? `${namespace}:${id}` : id;
  const existing = handoffs.find((handoff) => handoff.boundary === boundary);
  if (existing) {
    if (existing.id !== qualifiedId || existing.brief !== brief)
      throw new Error('This phase boundary already has a different handoff.');
    return null;
  }
  return { id: qualifiedId, boundary, brief };
}

export function phaseHandoffPrompt(brief: string): string {
  return [
    'Continue the same Ship run as a fresh phase worker. Read the canonical task checkpoint with task_checkpoint_read first.',
    'Reconcile original authorization and live delivery; preserve the existing local claim, completed gates, evidence and budgets. Load only destination phase guidance and missing repository instructions.',
    'Sail owns the phase worker transfer. Do not start another run or reacquire ownership. Never post a GitHub comment. Follow the existing merge owner rule.',
    'At the next skill phase boundary, submit its handoff brief through task_checkpoint_update.handoff and end your turn.',
    '',
    brief,
  ].join('\n');
}

export function pendingPhaseHandoff(issue: {
  threadId?: string | null;
  contextHandoffs?: ContextHandoff[];
}): ContextHandoff | undefined {
  return issue.contextHandoffs?.findLast(
    (handoff) =>
      handoff.boundary &&
      handoff.fromThreadId === issue.threadId &&
      !handoff.toThreadId &&
      handoff.outcome === 'pending',
  );
}

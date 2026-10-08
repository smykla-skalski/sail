import type { TaskCheckpoint } from './task-checkpoint.ts';

export const defaultContextHandoffThreshold = 85;
export const contextCheckpointLead = 10;

export type ContextProvider = 'claude' | 'codex' | 'opencode';

export type ContextHandoff = {
  id: string;
  provider: ContextProvider;
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
  outcome: 'pending' | 'reduced' | 'unchanged' | 'regressed' | 'failed';
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
    outcome:
      retryDelta > 0 || lostStateDelta > 0
        ? 'regressed'
        : handoff.retriesBefore > 0 || handoff.lostStateFailuresBefore > 0
          ? 'reduced'
          : 'unchanged',
  };
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

export type ThreadStatus = 'working' | 'waiting' | 'done' | 'failed' | 'interrupted';

export function openCodeExecutionStatus(eventType: string): ThreadStatus | null {
  switch (eventType) {
    case 'session.execution.started':
      return 'working';
    case 'session.execution.succeeded':
      return 'done';
    case 'session.execution.failed':
      return 'failed';
    case 'session.execution.interrupted':
      return 'interrupted';
    default:
      return null;
  }
}

export type ThreadAttention = { status: ThreadStatus; unread: boolean };

export type AttentionMap = Record<string, ThreadAttention>;

export type ActivitySnapshot = Record<
  string,
  {
    alive: boolean;
    active: string[];
    waiting: string[];
    finished: Record<string, { status: 'done' | 'failed' | 'interrupted'; notify: boolean }>;
  }
>;

export function reconcileAttention(
  current: AttentionMap,
  threads: { agent: string; sessionId: string; key: string; viewed: boolean }[],
  activity: ActivitySnapshot,
): AttentionMap {
  const next = { ...current };
  for (const thread of threads) {
    const previous = current[thread.key];
    const runtime = activity[thread.agent];
    const active = runtime?.alive && runtime.active.includes(thread.sessionId);
    if (!active && previous?.status !== 'working' && previous?.status !== 'waiting') continue;
    const waiting = active && (runtime?.waiting.includes(thread.sessionId) ?? false);
    const outcome = runtime?.finished[thread.sessionId];
    const status = waiting ? 'waiting' : active ? 'working' : (outcome?.status ?? 'failed');
    const unread = thread.viewed
      ? false
      : waiting
        ? (previous?.unread ?? false) || previous?.status !== 'waiting'
        : active
          ? false
          : outcome?.status === 'done' && outcome.notify;
    next[thread.key] = { status, unread };
  }
  return next;
}

const statuses = new Set(['working', 'waiting', 'done', 'failed', 'interrupted']);

function isThreadStatus(value: unknown): value is ThreadStatus {
  return typeof value === 'string' && statuses.has(value);
}

export function loadAttention(raw: string | null): AttentionMap {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, ThreadAttention] =>
          typeof entry[1] === 'object' &&
          entry[1] !== null &&
          'status' in entry[1] &&
          isThreadStatus(entry[1].status) &&
          'unread' in entry[1] &&
          typeof entry[1].unread === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

export function updateAttention(
  current: AttentionMap,
  key: string,
  status: ThreadStatus,
  viewed: boolean,
  notifyOnDone = true,
): { next: AttentionMap; notify: boolean } {
  const previous = current[key];
  const changed = previous?.status !== status;
  const notify =
    changed && !viewed && (status === 'waiting' || (status === 'done' && notifyOnDone));
  const unread = viewed ? false : notify || (previous?.status === status && previous.unread);
  return { next: { ...current, [key]: { status, unread } }, notify };
}

export function markAttentionRead(current: AttentionMap, key: string): AttentionMap {
  const value = current[key];
  return value?.unread ? { ...current, [key]: { ...value, unread: false } } : current;
}

export function preserveAttentionOnCheckOpen(
  current: AttentionMap,
  previous: AttentionMap,
  key: string,
): AttentionMap {
  const before = previous[key];
  const after = current[key];
  if (!before || !after || before.status !== after.status || before.unread === after.unread)
    return current;
  return { ...current, [key]: { ...after, unread: before.unread } };
}

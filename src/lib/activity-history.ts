import { writable } from 'svelte/store';

export type ActivityHistoryKind = 'parent' | 'subagent' | 'tool' | 'decision' | 'check';

export type ActivityHistoryEvent = {
  id: string;
  workspace: string;
  kind: ActivityHistoryKind;
  source: string;
  sourceId: string;
  title: string;
  outcome: string;
  at: number;
  agent?: string;
  sessionId?: string;
  /** Set for a permission Sail settled by policy, with the policy's reason. */
  automatic?: boolean;
  reason?: string;
};

export type ActivityHistoryInput = Omit<ActivityHistoryEvent, 'id'> & { id?: string };

function isActivityKind(value: unknown): value is ActivityHistoryKind {
  return (
    value === 'parent' ||
    value === 'subagent' ||
    value === 'tool' ||
    value === 'decision' ||
    value === 'check'
  );
}

function eventKey(event: ActivityHistoryInput): string {
  return (
    event.id ??
    JSON.stringify([
      event.workspace,
      event.kind,
      event.agent ?? '',
      event.sessionId ?? '',
      event.sourceId,
    ])
  );
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function recentActivityEvents(
  input: ActivityHistoryInput[],
  limit = 100,
): ActivityHistoryEvent[] {
  const events = new Map<string, ActivityHistoryEvent>();
  for (const candidate of input) {
    if (
      !candidate.workspace ||
      !Number.isFinite(candidate.at) ||
      candidate.at <= 0 ||
      Number.isNaN(new Date(candidate.at).getTime())
    )
      continue;
    const id = eventKey(candidate);
    const event = {
      ...candidate,
      id,
      source: bounded(candidate.source, 80),
      title: bounded(candidate.title, 240),
      outcome: bounded(candidate.outcome, 80),
      ...(candidate.reason === undefined ? {} : { reason: bounded(candidate.reason, 240) }),
    };
    const previous = events.get(id);
    if (!previous || previous.at <= event.at) events.set(id, event);
  }
  return [...events.values()]
    .toSorted((left, right) => right.at - left.at || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, limit));
}

export function activityWorkspaces(events: ActivityHistoryEvent[]): string[] {
  return [...new Set(events.map((event) => event.workspace))];
}

export function loadActivityHistory(raw: string | null): ActivityHistoryEvent[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return recentActivityEvents(
      value.filter(
        (event): event is ActivityHistoryEvent =>
          !!event &&
          typeof event === 'object' &&
          typeof event.id === 'string' &&
          typeof event.workspace === 'string' &&
          isActivityKind(event.kind) &&
          typeof event.source === 'string' &&
          typeof event.sourceId === 'string' &&
          typeof event.title === 'string' &&
          typeof event.outcome === 'string' &&
          typeof event.at === 'number' &&
          (event.agent === undefined || typeof event.agent === 'string') &&
          (event.sessionId === undefined || typeof event.sessionId === 'string') &&
          (event.automatic === undefined || typeof event.automatic === 'boolean') &&
          (event.reason === undefined || typeof event.reason === 'string'),
      ),
    );
  } catch {
    return [];
  }
}

export function saveActivityHistory(events: ActivityHistoryEvent[]): string {
  return JSON.stringify(recentActivityEvents(events));
}

/** The app's durable activity history, shared with panes that show part of it. */
export const sharedActivityHistory = writable<ActivityHistoryEvent[]>([]);

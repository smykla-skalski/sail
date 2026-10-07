import type { AgentEntry, AgentEvent, AgentThread } from './acp.ts';
import { updateEntries } from './acp.ts';
import type { SpawnReceipt, SpawnState } from './agent-results.ts';

export type NativeSubagentOutcome =
  'working' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'unknown';

export type NativeSubagent = {
  id: string;
  agent: string;
  directory: string;
  sessionId: string;
  parentSessionId: string;
  rootSessionId: string;
  name: string;
  task: string;
  prompt?: string;
  outcome: NativeSubagentOutcome;
  activity: string;
  transcript: AgentEntry[];
  created: number;
  updated: number;
  restored: boolean;
  error?: string;
};

export type NativeSubagentStore = Record<string, NativeSubagent>;

export function nativeSubagentId(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function rootSession(store: NativeSubagentStore, agent: string, parentSessionId: string): string {
  return store[nativeSubagentId(agent, parentSessionId)]?.rootSessionId ?? parentSessionId;
}

function state(value: unknown): NativeSubagentOutcome {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'cancelled') return 'interrupted';
  return 'unknown';
}

function toolActivity(update: Record<string, unknown>, previous: string): string {
  if (
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
    typeof update.title === 'string'
  )
    return update.title;
  if (update.sessionUpdate === 'agent_message_chunk') return 'Writing response…';
  return previous;
}

export function updateNativeSubagents(
  store: NativeSubagentStore,
  event: AgentEvent,
  directory: string,
  now = Date.now(),
  restored = false,
): NativeSubagentStore {
  if (event.message.method !== 'session/update') return store;
  const params = record(event.message.params);
  const parentSessionId = params?.sessionId;
  const update = record(params?.update);
  if (typeof parentSessionId !== 'string' || !update) return store;

  if (update.sessionUpdate === 'subagent_spawned') {
    const sessionId = update.subagentSessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId === parentSessionId)
      return store;
    const id = nativeSubagentId(event.agent, sessionId);
    const previous = store[id];
    const prompt = typeof update.prompt === 'string' ? update.prompt : previous?.prompt;
    const malformed =
      restored &&
      (!(typeof update.name === 'string' && update.name.trim()) ||
        !(typeof update.task === 'string' && update.task.trim()));
    const transcript = previous?.transcript ?? [];
    const settled =
      previous && ['completed', 'failed', 'interrupted'].includes(previous.outcome)
        ? previous.outcome
        : null;
    const nextTranscript =
      prompt && transcript.length === 0
        ? [{ id: `${id}:prompt`, type: 'user' as const, text: prompt, created: now }]
        : transcript;
    return {
      ...store,
      [id]: {
        id,
        agent: event.agent,
        directory: previous?.directory || directory,
        sessionId,
        parentSessionId,
        rootSessionId: rootSession(store, event.agent, parentSessionId),
        name:
          typeof update.name === 'string' && update.name.trim()
            ? update.name
            : (previous?.name ?? 'Subagent'),
        task:
          typeof update.task === 'string' && update.task.trim()
            ? update.task
            : (previous?.task ?? 'Delegated task'),
        ...(prompt ? { prompt } : {}),
        outcome: settled ?? 'working',
        activity: settled ? (previous?.activity ?? 'Starting…') : 'Starting…',
        transcript: nextTranscript,
        created: previous?.created ?? now,
        updated: now,
        restored: previous?.restored || restored,
        ...(malformed ? { error: 'Incomplete subagent history' } : {}),
      },
    };
  }

  if (update.sessionUpdate === 'subagent_state_update') {
    const sessionId = update.subagentSessionId;
    if (typeof sessionId !== 'string') return store;
    const id = nativeSubagentId(event.agent, sessionId);
    const child = store[id];
    if (!child) return store;
    const outcome = state(update.state);
    return {
      ...store,
      [id]: {
        ...child,
        outcome,
        activity:
          outcome === 'completed'
            ? 'Completed'
            : outcome === 'failed'
              ? 'Failed'
              : outcome === 'interrupted'
                ? 'Interrupted'
                : 'Disconnected',
        updated: now,
      },
    };
  }

  const id = nativeSubagentId(event.agent, parentSessionId);
  const child = store[id];
  if (!child) return store;
  const transcript = updateEntries(child.transcript, update);
  const settled = ['completed', 'failed', 'interrupted'].includes(child.outcome);
  return {
    ...store,
    [id]: {
      ...child,
      outcome: settled ? child.outcome : child.outcome === 'waiting' ? 'waiting' : 'working',
      activity: settled ? child.activity : toolActivity(update, child.activity),
      transcript,
      updated: now,
    },
  };
}

export function setNativeSubagentWaiting(
  store: NativeSubagentStore,
  agent: string,
  sessionId: string,
  waiting: boolean,
  now = Date.now(),
): NativeSubagentStore {
  const id = nativeSubagentId(agent, sessionId);
  const child = store[id];
  if (!child || !['working', 'waiting'].includes(child.outcome)) return store;
  return {
    ...store,
    [id]: {
      ...child,
      outcome: waiting ? 'waiting' : 'working',
      activity: waiting
        ? 'Needs permission'
        : child.activity === 'Needs permission'
          ? 'Working…'
          : child.activity,
      updated: now,
    },
  };
}

export function finalizeNativeSubagentRestore(
  store: NativeSubagentStore,
  agent: string,
  rootSessionId: string,
  now = Date.now(),
): NativeSubagentStore {
  let changed = false;
  const next = { ...store };
  for (const [id, child] of Object.entries(store)) {
    if (child.agent !== agent || child.rootSessionId !== rootSessionId || !child.restored) continue;
    if (child.outcome !== 'working' && child.outcome !== 'waiting') continue;
    next[id] = { ...child, outcome: 'unknown', activity: 'Disconnected', updated: now };
    changed = true;
  }
  return changed ? next : store;
}

export function disconnectNativeSubagents(
  store: NativeSubagentStore,
  agent: string,
  now = Date.now(),
): NativeSubagentStore {
  let changed = false;
  const next = { ...store };
  for (const [id, child] of Object.entries(store)) {
    if (child.agent !== agent || !['working', 'waiting'].includes(child.outcome)) continue;
    next[id] = { ...child, outcome: 'unknown', activity: 'Disconnected', updated: now };
    changed = true;
  }
  return changed ? next : store;
}

function spawnState(outcome: NativeSubagentOutcome): SpawnState {
  return outcome === 'unknown' ? 'unavailable' : outcome;
}

export function nativeSubagentReceipts(store: NativeSubagentStore): SpawnReceipt[] {
  return Object.values(store).map((child) => ({
    receiptId: `native:${child.agent}:${child.sessionId}`,
    accessKey: '',
    requestId: `native:${child.sessionId}`,
    project: child.directory,
    sourceId: `acp:${child.agent}:${child.parentSessionId}`,
    sourceDirectory: child.directory,
    targetId: `acp:${child.agent}:${child.sessionId}`,
    turnId: null,
    targetDirectory: child.directory,
    worktreeId: null,
    provider: child.agent === 'claude' ? 'claude' : 'codex',
    prompt: child.task,
    state: spawnState(child.outcome),
    created: child.created,
    updated: child.updated,
    result: ['completed', 'failed', 'interrupted', 'unknown'].includes(child.outcome)
      ? child.activity
      : null,
    error: child.error ?? null,
    activity: child.activity,
  }));
}

export function nativeSubagentThreads(store: NativeSubagentStore): AgentThread[] {
  return Object.values(store).map((child) => ({
    agent: child.agent,
    sessionId: child.sessionId,
    directory: child.directory,
    title: child.task || child.name,
    updated: child.updated,
  }));
}

export function nativeSubagentCounts(
  store: NativeSubagentStore,
  agent: string,
  parentSessionId: string,
): { active: number; waiting: number } {
  const children = Object.values(store).filter(
    (child) => child.agent === agent && child.parentSessionId === parentSessionId,
  );
  return {
    active: children.filter((child) => child.outcome === 'working').length,
    waiting: children.filter((child) => child.outcome === 'waiting').length,
  };
}

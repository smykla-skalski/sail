import type {
  AgentEntry,
  AgentEvent,
  AgentMessage,
  AgentThread,
  NativeSubagentSnapshot,
} from './acp.ts';
import { updateEntries } from './acp.ts';
import type { SpawnReceipt, SpawnState } from './agent-results.ts';
import type { CapabilityProfile } from './capability-profiles.ts';

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
  /** Tool calls seen, counted as they arrive because the bounded transcript evicts old ones. */
  toolCount?: number;
  /** Ids of the counted tool calls, so a replayed call for an evicted tool is not counted again. */
  toolIds?: string[];
  created: number;
  updated: number;
  restored: boolean;
  error?: string;
  capabilityProfile: CapabilityProfile;
  /** What the adapter advertised in `subagent_spawned.capabilities`. Absent until it spawns. */
  capabilities?: Record<string, unknown>;
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

function isReplaySubagent(sessionId: string): boolean {
  return sessionId.includes(':replay-subagent:');
}

/** A replayed child the store does not know duplicates a live child of the same root, because a
 * session's history only grows while it is live. */
function duplicatesLiveChild(
  store: NativeSubagentStore,
  agent: string,
  parentSessionId: string,
  sessionId: string,
): boolean {
  if (!isReplaySubagent(sessionId) || store[nativeSubagentId(agent, sessionId)]) return false;
  if (isReplaySubagent(parentSessionId)) return !store[nativeSubagentId(agent, parentSessionId)];
  const root = rootSession(store, agent, parentSessionId);
  return Object.values(store).some(
    (child) => child.agent === agent && child.rootSessionId === root && !child.restored,
  );
}

function state(value: unknown): NativeSubagentOutcome {
  if (value === 'working') return 'working';
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'cancelled') return 'interrupted';
  return 'unknown';
}

const incompleteHistory = 'Incomplete subagent history';

export const nativeTranscriptLimit = 500;
export const nativeMessageLimit = 40_000;

/** The newest text that fits the message limit after an ellipsis, never starting inside a
 * surrogate pair. */
function messageTail(text: string): string {
  const start = text.length + 1 - nativeMessageLimit;
  const code = text.charCodeAt(start);
  return `…${text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start)}`;
}

/** The oldest text that fits the message limit before an ellipsis, never ending inside a
 * surrogate pair. */
function messageHead(text: string): string {
  const end = nativeMessageLimit - 1;
  const code = text.charCodeAt(end - 1);
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)}…`;
}

/** Caps a raw tool value. Structured values over the limit become their capped JSON text, so a
 * tool's input keeps its leading fields and its output keeps the newest text. */
function boundValue(value: unknown, cut: (text: string) => string): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return typeof text === 'string' && text.length > nativeMessageLimit ? cut(text) : value;
}

function boundEntry(entry: AgentEntry): AgentEntry {
  if (entry.type !== 'tool')
    return entry.text.length > nativeMessageLimit && !entry.id.endsWith(':prompt')
      ? { ...entry, text: messageTail(entry.text) }
      : entry;
  const content =
    entry.content.length > nativeMessageLimit ? messageTail(entry.content) : entry.content;
  const input = boundValue(entry.input, messageHead);
  const output = boundValue(entry.output, messageTail);
  if (content === entry.content && input === entry.input && output === entry.output) return entry;
  return {
    ...entry,
    content,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

/** Keeps a live child's transcript bounded after an update changed it: the spawn prompt, which
 * stays whole, plus the newest entries. Streaming chunks only ever grow the last entry and a tool
 * update only rewrites its own tool, so only those need trimming. */
export function boundNativeTranscript(entries: AgentEntry[], toolCallId?: string): AgentEntry[] {
  const index = toolCallId
    ? entries.findIndex((entry) => entry.type === 'tool' && entry.id === toolCallId)
    : entries.length - 1;
  const entry = index >= 0 ? entries[index] : undefined;
  const bounded = entry && boundEntry(entry);
  const trimmed = bounded && bounded !== entry ? entries.with(index, bounded) : entries;
  if (trimmed.length <= nativeTranscriptLimit) return trimmed;
  const prompt = trimmed[0]?.id.endsWith(':prompt') ? [trimmed[0]] : [];
  return [...prompt, ...trimmed.slice(prompt.length - nativeTranscriptLimit)];
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
  capabilityProfile: CapabilityProfile = 'build',
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
    if (duplicatesLiveChild(store, event.agent, parentSessionId, sessionId)) return store;
    const id = nativeSubagentId(event.agent, sessionId);
    const previous = store[id];
    const prompt = typeof update.prompt === 'string' ? update.prompt : previous?.prompt;
    // Only claude-agent-acp marks replayed children, so its live children stay live while a
    // session replays. Other adapters replay under plain ids, where the replay itself decides.
    const replayed = restored && (event.agent !== 'claude' || isReplaySubagent(sessionId));
    const malformed =
      replayed &&
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
        ...(record(update.capabilities) || previous?.capabilities
          ? { capabilities: record(update.capabilities) ?? previous?.capabilities }
          : {}),
        outcome: settled ?? 'working',
        activity: settled ? (previous?.activity ?? 'Starting…') : 'Starting…',
        transcript: nextTranscript,
        ...(previous?.toolCount === undefined ? {} : { toolCount: previous.toolCount }),
        ...(previous?.toolIds ? { toolIds: previous.toolIds } : {}),
        created: previous?.created ?? now,
        updated: now,
        restored: previous?.restored || replayed,
        capabilityProfile: replayed
          ? capabilityProfile
          : (previous?.capabilityProfile ??
            store[nativeSubagentId(event.agent, parentSessionId)]?.capabilityProfile ??
            capabilityProfile),
        ...(malformed ? { error: incompleteHistory } : {}),
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
    const { error: previousError, ...settledChild } = child;
    const reason = typeof update.error === 'string' ? update.error.trim() : '';
    const resumed = outcome === 'working' || outcome === 'completed';
    const error = reason || (resumed && previousError !== incompleteHistory ? '' : previousError);
    return {
      ...store,
      [id]: {
        ...settledChild,
        ...(error ? { error } : {}),
        outcome,
        activity:
          outcome === 'completed'
            ? 'Completed'
            : outcome === 'failed'
              ? 'Failed'
              : outcome === 'interrupted'
                ? 'Interrupted'
                : outcome === 'working'
                  ? 'Working…'
                  : 'Disconnected',
        updated: now,
      },
    };
  }

  const id = nativeSubagentId(event.agent, parentSessionId);
  const child = store[id];
  if (!child) return store;
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  // An update for a tool the bound already evicted would come back as a blank stub.
  const evicted =
    update.sessionUpdate === 'tool_call_update' &&
    toolCallId !== undefined &&
    child.transcript.length >= nativeTranscriptLimit &&
    !child.transcript.some((entry) => entry.type === 'tool' && entry.id === toolCallId);
  const next = evicted ? child.transcript : updateEntries(child.transcript, update);
  const transcript =
    next === child.transcript
      ? next
      : boundNativeTranscript(
          next,
          update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
            ? toolCallId
            : undefined,
        );
  const settled = ['completed', 'failed', 'interrupted'].includes(child.outcome);
  const newTool =
    update.sessionUpdate === 'tool_call' &&
    toolCallId !== undefined &&
    !child.toolIds?.includes(toolCallId) &&
    !child.transcript.some((entry) => entry.type === 'tool' && entry.id === toolCallId);
  return {
    ...store,
    [id]: {
      ...child,
      ...(newTool
        ? { toolCount: (child.toolCount ?? 0) + 1, toolIds: [...(child.toolIds ?? []), toolCallId] }
        : {}),
      outcome: settled ? child.outcome : child.outcome === 'waiting' ? 'waiting' : 'working',
      activity: settled ? child.activity : toolActivity(update, child.activity),
      transcript,
      updated: now,
    },
  };
}

export function reconcileNativeSubagents(
  store: NativeSubagentStore,
  snapshots: NativeSubagentSnapshot[],
  now = Date.now(),
): NativeSubagentStore {
  let next = store;
  for (let pass = 0; pass < snapshots.length; pass += 1) {
    let changed = false;
    for (const snapshot of snapshots) {
      const id = nativeSubagentId(snapshot.agent, snapshot.sessionId);
      const previous = next[id];
      const rootSessionId = rootSession(next, snapshot.agent, snapshot.parentSessionId);
      if (
        previous?.directory === snapshot.directory &&
        previous.capabilityProfile === snapshot.capabilityProfile &&
        previous.parentSessionId === snapshot.parentSessionId &&
        previous.rootSessionId === rootSessionId &&
        previous.outcome === snapshot.outcome
      )
        continue;
      const activity =
        snapshot.outcome === 'completed'
          ? 'Completed'
          : snapshot.outcome === 'failed'
            ? 'Failed'
            : snapshot.outcome === 'interrupted'
              ? 'Interrupted'
              : snapshot.outcome === 'waiting'
                ? 'Needs permission'
                : previous?.activity || 'Starting…';
      if (next === store) next = Object.assign({}, store);
      next[id] = {
        id,
        agent: snapshot.agent,
        capabilityProfile: snapshot.capabilityProfile,
        directory: snapshot.directory,
        sessionId: snapshot.sessionId,
        parentSessionId: snapshot.parentSessionId,
        rootSessionId,
        name: previous?.name ?? 'Subagent',
        task: previous?.task ?? 'Delegated task',
        ...(previous?.prompt ? { prompt: previous.prompt } : {}),
        ...(previous?.capabilities ? { capabilities: previous.capabilities } : {}),
        outcome: snapshot.outcome,
        activity,
        transcript: previous?.transcript ?? [],
        ...(previous?.toolCount === undefined ? {} : { toolCount: previous.toolCount }),
        ...(previous?.toolIds ? { toolIds: previous.toolIds } : {}),
        created: previous?.created ?? now,
        updated: now,
        restored: previous?.restored ?? false,
        ...(previous?.error ? { error: previous.error } : {}),
      };
      changed = true;
    }
    if (!changed) break;
  }
  return next;
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
  sessionIds: readonly string[],
  now = Date.now(),
): NativeSubagentStore {
  let changed = false;
  const next = { ...store };
  for (const [id, child] of Object.entries(store)) {
    if (
      child.agent !== agent ||
      !sessionIds.includes(child.sessionId) ||
      !['working', 'waiting'].includes(child.outcome)
    )
      continue;
    next[id] = { ...child, outcome: 'unknown', activity: 'Disconnected', updated: now };
    changed = true;
  }
  return changed ? next : store;
}

function spawnState(outcome: NativeSubagentOutcome): SpawnState {
  return outcome === 'unknown' ? 'unavailable' : outcome;
}

function reportsInterruption(transcript: AgentEntry[]): boolean {
  const last = transcript.at(-1);
  return last?.type === 'assistant' && last.text.trim().toLowerCase() === 'step interrupted';
}

export function nativeSubagentStatus(child: NativeSubagent): {
  state: SpawnState;
  activity: string;
} {
  const interrupted = child.outcome === 'completed' && reportsInterruption(child.transcript);
  return {
    state: interrupted ? 'interrupted' : spawnState(child.outcome),
    activity: interrupted ? 'Interrupted' : child.activity,
  };
}

/** The child's final message, which is its result. The state text alone is not a result. */
export function nativeSubagentResult(child: NativeSubagent): string | null {
  if (!['completed', 'failed', 'interrupted'].includes(child.outcome)) return null;
  if (reportsInterruption(child.transcript)) return null;
  // A failed child's error explains the failure better than whatever it said last.
  if (child.outcome === 'failed' && child.error) return null;
  const last = child.transcript.findLast(
    (entry): entry is AgentMessage => entry.type === 'assistant',
  );
  return last?.text.trim() || null;
}

export function nativeSubagentReceipts(store: NativeSubagentStore): SpawnReceipt[] {
  return Object.values(store).map((child) => {
    const status = nativeSubagentStatus(child);
    return {
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
      provider: child.agent === 'claude' || child.agent === 'opencode' ? child.agent : 'codex',
      prompt: child.task,
      state: status.state,
      created: child.created,
      updated: child.updated,
      result: nativeSubagentResult(child),
      error: child.error ?? null,
      activity: status.activity,
      name: child.name,
      toolCount: child.toolCount,
    };
  });
}

export function nativeSubagentThreads(store: NativeSubagentStore): AgentThread[] {
  return Object.values(store).map((child) => ({
    agent: child.agent,
    sessionId: child.sessionId,
    directory: child.directory,
    title: child.task || child.name,
    updated: child.updated,
    capabilityProfile: child.capabilityProfile,
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

/** A child takes messages only when its adapter advertises a prompt capability. claude-agent-acp
 * advertises none, so its children stay read-only. */
export function nativeSubagentAcceptsPrompts(child: NativeSubagent | undefined): boolean {
  const prompt = child?.capabilities?.prompt;
  return prompt !== undefined && prompt !== null && prompt !== false;
}

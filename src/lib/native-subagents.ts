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
  taskIdentity?: 'verified' | 'observed';
  taskTurnId?: string | null;
  /** Child controls advertised by the adapter. Absent until it spawns. */
  capabilities?: Record<string, unknown>;
};

export type NativeSubagentStore = Record<string, NativeSubagent>;

export function nativeSubagentId(agent: string, directory: string, sessionId: string): string {
  return JSON.stringify([agent, directory, sessionId]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function rootSession(
  store: NativeSubagentStore,
  agent: string,
  directory: string,
  parentSessionId: string,
): string {
  return (
    store[nativeSubagentId(agent, directory, parentSessionId)]?.rootSessionId ?? parentSessionId
  );
}

function isReplaySubagent(sessionId: string): boolean {
  return sessionId.includes(':replay-subagent:');
}

/** A replayed child the store does not know duplicates a live child of the same root, because a
 * session's history only grows while it is live. */
function duplicatesLiveChild(
  store: NativeSubagentStore,
  agent: string,
  directory: string,
  parentSessionId: string,
  sessionId: string,
): boolean {
  if (!isReplaySubagent(sessionId) || store[nativeSubagentId(agent, directory, sessionId)])
    return false;
  if (isReplaySubagent(parentSessionId))
    return !store[nativeSubagentId(agent, directory, parentSessionId)];
  const root = rootSession(store, agent, directory, parentSessionId);
  return Object.values(store).some(
    (child) =>
      child.agent === agent &&
      child.directory === directory &&
      child.rootSessionId === root &&
      !child.restored,
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
function messageTail(text: string, limit = nativeMessageLimit): string {
  if (limit === 0) return '';
  const start = text.length + 1 - limit;
  const code = text.charCodeAt(start);
  return `…${text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start)}`;
}

/** The oldest text that fits the message limit before an ellipsis, never ending inside a
 * surrogate pair. */
function messageHead(text: string, limit = nativeMessageLimit): string {
  if (limit === 0) return '';
  const end = limit - 1;
  const code = text.charCodeAt(end - 1);
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)}…`;
}

const toolIdentityFields = new Set([
  'command',
  'hookName',
  'hook_name',
  'hook',
  'hookPhase',
  'hook_phase',
  'hookEvent',
  'hook_event',
  'ruleName',
  'rule_name',
  'rule',
]);
const toolReasonFields = new Set(['reason', 'error', 'message', 'name']);
const metadataFieldLimit = 1_000;

function visitStrings(
  value: unknown,
  visit: (text: string, key: string) => string,
  key = '',
): unknown {
  if (typeof value === 'string') return visit(value, key);
  if (Array.isArray(value)) return value.map((item) => visitStrings(item, visit));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, visitStrings(item, visit, name)]),
    );
  return value;
}

function encodedLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

function fitString(
  text: string,
  budget: number,
  cut: (text: string, limit: number) => string,
): string {
  if (encodedLength(text) <= budget) return text;
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedLength(cut(text, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return cut(text, low);
}

function boundValue(value: unknown, cut: (text: string, limit: number) => string): unknown {
  if (typeof value === 'string')
    return value.length > nativeMessageLimit ? cut(value, nativeMessageLimit) : value;
  if (!value || typeof value !== 'object') return value;
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= nativeMessageLimit) return value;

  const skeleton = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' ? '' : item,
  );
  if (skeleton.length > nativeMessageLimit)
    return Array.isArray(value)
      ? []
      : boundValue(
          Object.fromEntries(
            Object.entries(value).filter(
              ([key, item]) =>
                (toolIdentityFields.has(key) || toolReasonFields.has(key)) &&
                (typeof item === 'string' || typeof item === 'number'),
            ),
          ),
          cut,
        );

  const available = nativeMessageLimit - skeleton.length;
  let identityLength = 0;
  let reasonLength = 0;
  visitStrings(value, (text, key) => {
    if (toolIdentityFields.has(key))
      identityLength += Math.min(encodedLength(text), metadataFieldLimit);
    else if (toolReasonFields.has(key))
      reasonLength += Math.min(encodedLength(text), metadataFieldLimit);
    return '';
  });
  let identityBudget = Math.min(identityLength, available);
  let reasonBudget = Math.min(reasonLength, available - identityBudget);
  let otherBudget = available - identityBudget - reasonBudget;
  return visitStrings(value, (text, key) => {
    const identity = toolIdentityFields.has(key);
    const reason = toolReasonFields.has(key);
    const budget = identity ? identityBudget : reason ? reasonBudget : otherBudget;
    const bounded = fitString(
      text,
      identity || reason ? Math.min(budget, metadataFieldLimit) : budget,
      cut,
    );
    if (identity) identityBudget -= encodedLength(bounded);
    else if (reason) reasonBudget -= encodedLength(bounded);
    else otherBudget -= encodedLength(bounded);
    return bounded;
  });
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
    if (duplicatesLiveChild(store, event.agent, directory, parentSessionId, sessionId))
      return store;
    const id = nativeSubagentId(event.agent, directory, sessionId);
    const previous = store[id];
    const prompt = typeof update.prompt === 'string' ? update.prompt : previous?.prompt;
    // The backend identifies synthetic Claude history without treating concurrent live spawns
    // as replay. Older adapters use replay ids or the session replay boundary.
    const replayed =
      typeof params?.sailHistoricalActivity === 'boolean'
        ? params.sailHistoricalActivity
        : restored && (event.agent !== 'claude' || isReplaySubagent(sessionId));
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
        rootSessionId: rootSession(store, event.agent, directory, parentSessionId),
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
        taskIdentity: previous?.taskIdentity ?? 'observed',
        taskTurnId: previous?.taskTurnId ?? null,
        capabilityProfile: replayed
          ? capabilityProfile
          : (previous?.capabilityProfile ??
            store[nativeSubagentId(event.agent, directory, parentSessionId)]?.capabilityProfile ??
            capabilityProfile),
        ...(malformed ? { error: incompleteHistory } : {}),
      },
    };
  }

  if (update.sessionUpdate === 'subagent_state_update') {
    const sessionId = update.subagentSessionId;
    if (typeof sessionId !== 'string') return store;
    const id = nativeSubagentId(event.agent, directory, sessionId);
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

  const id = nativeSubagentId(event.agent, directory, parentSessionId);
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
      const id = nativeSubagentId(snapshot.agent, snapshot.directory, snapshot.sessionId);
      const previous = next[id];
      const rootSessionId = rootSession(
        next,
        snapshot.agent,
        snapshot.directory,
        snapshot.parentSessionId,
      );
      if (
        previous?.directory === snapshot.directory &&
        previous.capabilityProfile === snapshot.capabilityProfile &&
        previous.parentSessionId === snapshot.parentSessionId &&
        previous.rootSessionId === rootSessionId &&
        previous.outcome === snapshot.outcome &&
        previous.taskIdentity === (snapshot.taskIdentity ?? 'observed') &&
        previous.taskTurnId === (snapshot.taskTurnId ?? null)
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
        taskIdentity: snapshot.taskIdentity ?? 'observed',
        taskTurnId: snapshot.taskTurnId ?? null,
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
  directory: string,
  sessionId: string,
  waiting: boolean,
  now = Date.now(),
): NativeSubagentStore {
  const id = nativeSubagentId(agent, directory, sessionId);
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
  directory: string,
  rootSessionId: string,
  now = Date.now(),
): NativeSubagentStore {
  let changed = false;
  const next = { ...store };
  for (const [id, child] of Object.entries(store)) {
    if (
      child.agent !== agent ||
      child.directory !== directory ||
      child.rootSessionId !== rootSessionId ||
      !child.restored
    )
      continue;
    if (child.outcome !== 'working' && child.outcome !== 'waiting') continue;
    next[id] = { ...child, outcome: 'unknown', activity: 'Disconnected', updated: now };
    changed = true;
  }
  return changed ? next : store;
}

export function disconnectNativeSubagents(
  store: NativeSubagentStore,
  agent: string,
  directory: string,
  sessionIds: readonly string[],
  now = Date.now(),
): NativeSubagentStore {
  let changed = false;
  const next = { ...store };
  for (const [id, child] of Object.entries(store)) {
    if (
      child.agent !== agent ||
      child.directory !== directory ||
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
  if (child.outcome === 'failed' && child.error && child.error !== incompleteHistory) return null;
  const last = child.transcript.findLast(
    (entry): entry is AgentMessage => entry.type === 'assistant',
  );
  return last?.text.trim() || null;
}

export function nativeSubagentReceipts(store: NativeSubagentStore): SpawnReceipt[] {
  return Object.values(store).map((child) => {
    const status = nativeSubagentStatus(child);
    return {
      receiptId: `native:${JSON.stringify([child.agent, child.directory, child.sessionId])}`,
      accessKey: '',
      requestId: `native:${JSON.stringify([child.directory, child.sessionId])}`,
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
      nativeCapabilities: child.capabilities,
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
  return nativeSubagentSupports(child?.capabilities, 'prompt');
}

export function nativeSubagentSupports(
  capabilities: Record<string, unknown> | undefined,
  control: 'prompt' | 'cancel',
): boolean {
  const value = capabilities?.[control];
  return value === true || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

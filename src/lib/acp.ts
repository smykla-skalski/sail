import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './settings.ts';
import { acpPlans } from './acp-plans.ts';
import { forgetPlanningState } from './planning-state.ts';
import { toolCommand } from './tool-display.ts';
import type { CapabilityProfile, PermissionPolicyDecision } from './capability-profiles.ts';

export type AgentId = string;

export interface AgentAvailability {
  id: AgentId;
  name: string;
  binaryPath: string | null;
  available: boolean;
  reason: string | null;
}

export interface AgentThread {
  agent: AgentId;
  model?: string;
  effort?: string;
  sessionId: string;
  directory: string;
  title: string;
  updated: number;
  capabilityProfile?: CapabilityProfile;
  /** The user chose this title in Sail, so agent-provided titles never replace it. */
  renamed?: boolean;
}

export interface AgentSessionListing {
  sessions: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }[];
  nextCursor?: string | null;
}

export interface InterruptedAgentTurn {
  agent: AgentId;
  sessionId: string;
  directory: string;
  turnId: string;
  text: string;
}

export interface AcpPromptOutcome {
  stopReason: string;
  sailInterrupted?: boolean;
}

export interface AcpTurnEvidence {
  agent: AgentId;
  sessionId: string;
  turnId: string;
  status: 'prepared' | 'dispatch_uncertain' | 'dispatched' | 'done' | 'failed' | 'interrupted';
  error: string | null;
  updatedAt: number;
}

export function acpPromptInterrupted(outcome: AcpPromptOutcome): boolean {
  return outcome.stopReason === 'cancelled' || outcome.sailInterrupted === true;
}

export function loadInterruptedAgentTurns(raw: string | null): InterruptedAgentTurn[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (turn): turn is InterruptedAgentTurn =>
        turn &&
        typeof turn === 'object' &&
        typeof turn.agent === 'string' &&
        typeof turn.sessionId === 'string' &&
        typeof turn.directory === 'string' &&
        typeof turn.turnId === 'string' &&
        typeof turn.text === 'string',
    );
  } catch {
    return [];
  }
}

export interface AgentMessage {
  id: string;
  type: 'user' | 'assistant' | 'thought';
  text: string;
  created?: number;
}

export interface AgentTool {
  id: string;
  type: 'tool';
  title: string;
  status: string;
  content: string;
  input?: unknown;
  output?: unknown;
  terminalIds: string[];
  created?: number;
}

export type AgentEntry = AgentMessage | AgentTool;

export interface AgentToolGroup {
  id: string;
  type: 'tool-group';
  tools: AgentTool[];
  created?: number;
}

export type AgentDisplayEntry = AgentMessage | AgentToolGroup;

export function groupAgentEntries(entries: AgentEntry[]): AgentDisplayEntry[] {
  const grouped: AgentDisplayEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'tool') {
      grouped.push(entry);
      continue;
    }
    const last = grouped.at(-1);
    if (last?.type === 'tool-group') {
      last.tools.push(entry);
    } else {
      grouped.push({
        id: `tool-group:${entry.id}`,
        type: 'tool-group',
        tools: [entry],
        ...(entry.created !== undefined ? { created: entry.created } : {}),
      });
    }
  }
  return grouped;
}

export function restoreEntryTimes(history: AgentEntry[], recent: AgentEntry[]): AgentEntry[] {
  const restored = history.slice();
  let index = recent.length - 1;
  for (let position = restored.length - 1; position >= 0; position--) {
    const entry = restored[position];
    while (index >= 0) {
      const cached = recent[index--];
      const matches =
        entry.type === cached.type &&
        (entry.type === 'tool'
          ? cached.type === 'tool' && entry.title === cached.title
          : cached.type !== 'tool' && entry.text.endsWith(cached.text));
      if (!matches) continue;
      if (cached.created !== undefined) restored[position] = { ...entry, created: cached.created };
      break;
    }
  }
  return restored;
}

export interface AgentPermission {
  id: string | number;
  sessionId: string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
  policy?: PermissionPolicyDecision;
  toolCall?: unknown;
  toolCallId?: string | null;
  command?: string | null;
  files?: string[];
  generation?: number;
  fingerprint?: string;
}

export interface AgentConfigOption {
  id: string;
  name: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

export interface AgentAuthMethod {
  id: string;
  name: string;
  type?: string;
}

export interface AgentCommand {
  name: string;
  description?: string;
}

export interface AgentEvent {
  agent: AgentId;
  message: {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
}

export function acpDisconnectedSessionIds(message: AgentEvent['message']): string[] | null {
  if (message.method !== 'sail/disconnected') return null;
  const sessionIds = message.params?.sessionIds;
  if (!Array.isArray(sessionIds)) return null;
  return sessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string');
}

export function acpDisconnectAffectsSession(
  message: AgentEvent['message'],
  sessionId: string | null,
  profile?: CapabilityProfile,
): boolean {
  if (message.method !== 'sail/disconnected') return false;
  const sessionIds = acpDisconnectedSessionIds(message);
  if (sessionId && sessionIds) return sessionIds.includes(sessionId);
  const disconnectedProfile = message.params?.profile;
  if (profile && typeof disconnectedProfile === 'string') return disconnectedProfile === profile;
  return sessionIds === null;
}

export interface AgentActivity {
  alive: boolean;
  active: string[];
  activeTurns: Record<string, string>;
  waiting: string[];
  sessions: string[];
  finished: Record<
    string,
    {
      status: 'done' | 'failed' | 'interrupted';
      notify: boolean;
      turnId: string;
      error?: string | null;
    }
  >;
}

export interface NativeSubagentSnapshot {
  agent: AgentId;
  capabilityProfile: CapabilityProfile;
  sessionId: string;
  parentSessionId: string;
  directory: string;
  outcome: 'working' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'unknown';
}

export interface NativeSubagentSnapshotSet {
  generation: number;
  subagents: NativeSubagentSnapshot[];
}

export interface AcpPendingInboxItem {
  agent: AgentId;
  message: AgentEvent['message'];
  receivedAt: number;
}

const storageKey = 'sail-agent-threads';
const transcriptKey = 'sai-agent-transcript-cache';
const transcriptLimit = 50;
const threadLimit = 20;

function transcriptId(agent: AgentId, directory: string, sessionId: string): string {
  return JSON.stringify([agent, directory, sessionId]);
}

type SavedTranscript = { id: string; entries: AgentEntry[] };

function savedTranscripts(): SavedTranscript[] {
  try {
    const value: unknown = JSON.parse(getSetting(transcriptKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is SavedTranscript =>
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        Array.isArray(item.entries),
    );
  } catch {
    return [];
  }
}

export function loadRecentTranscript(thread: AgentThread): AgentEntry[] {
  return (
    savedTranscripts().find(
      (item) => item.id === transcriptId(thread.agent, thread.directory, thread.sessionId),
    )?.entries ?? []
  );
}

export function saveRecentTranscript(thread: AgentThread, entries: AgentEntry[]): void {
  const id = transcriptId(thread.agent, thread.directory, thread.sessionId);
  const recent: AgentEntry[] = [];
  const encoder = new TextEncoder();
  let remaining = 128 * 1024 - encoder.encode(JSON.stringify({ id, entries: [] })).length;
  if (remaining <= 0) return;
  for (const entry of entries.slice(-transcriptLimit).toReversed()) {
    const saved: AgentEntry =
      entry.type === 'tool'
        ? {
            ...entry,
            content: entry.content.slice(0, 4096),
            input:
              JSON.stringify(entry.input ?? '').length <= 4096
                ? entry.input
                : { command: toolCommand(entry.input)?.slice(0, 1024) ?? '', truncated: true },
            output:
              JSON.stringify(entry.output ?? '').length <= 4096
                ? entry.output
                : 'Output omitted from transcript cache (too large)',
            terminalIds: [],
          }
        : { ...entry, text: entry.text.slice(-20000) };
    const size = encoder.encode(JSON.stringify(saved)).length + Number(recent.length > 0);
    if (size > remaining) continue;
    recent.push(saved);
    remaining -= size;
  }
  recent.reverse();
  const saved = savedTranscripts().filter((item) => item.id !== id);
  saved.push({ id, entries: recent });
  setSetting(transcriptKey, JSON.stringify(saved.slice(-threadLimit)));
}

export function forgetRecentTranscript(thread: AgentThread): void {
  const id = transcriptId(thread.agent, thread.directory, thread.sessionId);
  setSetting(transcriptKey, JSON.stringify(savedTranscripts().filter((item) => item.id !== id)));
}

export function loadAgentThreads(): AgentThread[] {
  try {
    const value: unknown = JSON.parse(getSetting(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is AgentThread =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.agent === 'string' &&
        item.agent.length > 0 &&
        typeof item.sessionId === 'string' &&
        typeof item.directory === 'string' &&
        typeof item.title === 'string' &&
        typeof item.updated === 'number' &&
        (item.effort === undefined || typeof item.effort === 'string') &&
        (item.capabilityProfile === undefined ||
          ['explore', 'review', 'build', 'release'].includes(item.capabilityProfile)),
    );
  } catch {
    return [];
  }
}

export function saveAgentThreads(threads: AgentThread[]): void {
  setSetting(storageKey, JSON.stringify(threads));
}

export function updateEntries(
  entries: AgentEntry[],
  update: Record<string, unknown>,
): AgentEntry[] {
  const next = entries.slice();
  return applyEntryUpdate(next, update) ? next : entries;
}

export function updateEntriesBatch(
  entries: AgentEntry[],
  updates: Record<string, unknown>[],
  created?: number,
): AgentEntry[] {
  const next = entries.slice();
  const toolIndexes = updates.some(
    (update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update',
  )
    ? indexTools(next)
    : undefined;
  let changed = false;
  for (const update of updates)
    changed = applyEntryUpdate(next, update, toolIndexes, created) || changed;
  return changed ? next : entries;
}

const replayToolIndexes = new WeakMap<AgentEntry[], Map<string, number>>();

export function updateEntriesInPlace(
  entries: AgentEntry[],
  update: Record<string, unknown>,
  created?: number,
): void {
  let toolIndexes = replayToolIndexes.get(entries);
  if (
    !toolIndexes &&
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
  ) {
    toolIndexes = indexTools(entries);
    replayToolIndexes.set(entries, toolIndexes);
  }
  applyEntryUpdate(entries, update, toolIndexes, created);
}

function indexTools(entries: AgentEntry[]): Map<string, number> {
  const indexes = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.type === 'tool' && !indexes.has(entry.id)) indexes.set(entry.id, index);
  });
  return indexes;
}

function applyEntryUpdate(
  entries: AgentEntry[],
  update: Record<string, unknown>,
  toolIndexes?: Map<string, number>,
  created?: number,
): boolean {
  const type = update.sessionUpdate;
  if (
    type === 'agent_message_chunk' ||
    type === 'user_message_chunk' ||
    type === 'agent_thought_chunk'
  ) {
    const block = update.content;
    if (!block || typeof block !== 'object' || !('text' in block) || typeof block.text !== 'string')
      return false;
    const role =
      type === 'user_message_chunk'
        ? 'user'
        : type === 'agent_thought_chunk'
          ? 'thought'
          : 'assistant';
    const last = entries.at(-1);
    if (last?.type === role) {
      entries[entries.length - 1] = { ...last, text: last.text + block.text };
      return true;
    }
    entries.push({
      id: crypto.randomUUID(),
      type: role,
      text: block.text,
      ...(created !== undefined ? { created } : {}),
    });
    return true;
  }
  if (type === 'tool_call' || type === 'tool_call_update') {
    const id = update.toolCallId;
    if (typeof id !== 'string') return false;
    const index =
      toolIndexes?.get(id) ??
      entries.findIndex((entry) => entry.type === 'tool' && entry.id === id);
    const found = index >= 0 ? entries[index] : undefined;
    const existing = found?.type === 'tool' ? found : undefined;
    const content = Array.isArray(update.content)
      ? update.content
          .map((item) => {
            if (!item || typeof item !== 'object' || !('content' in item)) return '';
            const block = item.content;
            return block &&
              typeof block === 'object' &&
              'text' in block &&
              typeof block.text === 'string'
              ? block.text
              : '';
          })
          .filter(Boolean)
          .join('\n')
      : (existing?.content ?? '');
    const terminalIds = Array.isArray(update.content)
      ? [
          ...new Set([
            ...(existing?.terminalIds ?? []),
            ...update.content.flatMap((item): string[] =>
              item &&
              typeof item === 'object' &&
              'type' in item &&
              item.type === 'terminal' &&
              'terminalId' in item &&
              typeof item.terminalId === 'string'
                ? [item.terminalId]
                : [],
            ),
          ]),
        ]
      : (existing?.terminalIds ?? []);
    const input = update.rawInput === undefined ? existing?.input : update.rawInput;
    const output = update.rawOutput === undefined ? existing?.output : update.rawOutput;
    const next: AgentTool = {
      id,
      type: 'tool',
      title: typeof update.title === 'string' ? update.title : (existing?.title ?? 'Tool call'),
      status: typeof update.status === 'string' ? update.status : (existing?.status ?? 'pending'),
      content,
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      terminalIds,
      ...((existing?.created ?? created) !== undefined
        ? { created: existing?.created ?? created }
        : {}),
    };
    if (index >= 0) entries[index] = next;
    else {
      toolIndexes?.set(id, entries.length);
      entries.push(next);
    }
    return true;
  }
  return false;
}

export interface AgentSessionState {
  configOptions?: AgentConfigOption[];
  availableCommands?: AgentCommand[];
}

const sessionStates = new Map<string, AgentSessionState>();
/** Sessions whose full transcript stays in memory while they are off screen. Least recently
 * left sessions are dropped first; deleting a thread drops its transcript. */
export const liveTranscriptLimit = 24;

export interface LiveTranscript {
  entries: AgentEntry[];
  /** The transcript holds the whole session from its start, not only the capped cache. */
  complete: boolean;
}

const liveTranscripts = new Map<string, LiveTranscript>();
/** Restores in flight per session. Their history replay must not reach a kept transcript. */
const restoringTranscripts = new Map<string, number>();

function sessionKey(agent: AgentId, sessionId: string): string {
  return JSON.stringify([agent, sessionId]);
}

export function rememberSessionState(
  agent: AgentId,
  sessionId: string,
  state: AgentSessionState,
): void {
  const key = sessionKey(agent, sessionId);
  sessionStates.set(key, { ...sessionStates.get(key), ...state });
}

export function sessionState(agent: AgentId, sessionId: string): AgentSessionState | undefined {
  return sessionStates.get(sessionKey(agent, sessionId));
}

/** Keeps the transcript of a session that is no longer shown and applies its updates as they
 * arrive, so switching back to a running turn shows everything without an adapter restore.
 * A restore would replay history while the turn streams. */
export function trackLiveTranscript(
  agent: AgentId,
  sessionId: string,
  entries: readonly AgentEntry[],
  complete: boolean,
): void {
  const key = sessionKey(agent, sessionId);
  liveTranscripts.delete(key);
  if (restoringTranscripts.has(key)) return;
  liveTranscripts.set(key, { entries: entries.slice(), complete });
  for (const oldest of liveTranscripts.keys()) {
    if (liveTranscripts.size <= liveTranscriptLimit) break;
    liveTranscripts.delete(oldest);
  }
}

export function tracksLiveTranscript(agent: AgentId, sessionId: string): boolean {
  return liveTranscripts.has(sessionKey(agent, sessionId));
}

export function applyLiveTranscriptUpdate(
  agent: AgentId,
  sessionId: string,
  update: Record<string, unknown>,
  now = Date.now(),
): void {
  const key = sessionKey(agent, sessionId);
  const transcript = liveTranscripts.get(key);
  if (!transcript) return;
  if (restoringTranscripts.has(key)) {
    liveTranscripts.delete(key);
    return;
  }
  // Matches the shown view: the local entry stands for the prompt, so an echo would duplicate it.
  if (update.sessionUpdate === 'user_message_chunk') return;
  updateEntriesInPlace(transcript.entries, update, now);
}

/** Drops a transcript that a history replay made unreliable; switching back then restores. */
export function invalidateLiveTranscript(agent: AgentId, sessionId: string): void {
  liveTranscripts.delete(sessionKey(agent, sessionId));
}

/** Returns the kept transcript and stops tracking, or null when none is kept. */
export function takeLiveTranscript(agent: AgentId, sessionId: string): LiveTranscript | null {
  const key = sessionKey(agent, sessionId);
  const transcript = liveTranscripts.get(key) ?? null;
  liveTranscripts.delete(key);
  return transcript;
}

export function forgetSessionState(agent: AgentId, sessionId: string): void {
  const key = sessionKey(agent, sessionId);
  sessionStates.delete(key);
  liveTranscripts.delete(key);
}

/** Rebuilds the view of a running session without a restore. Without a kept transcript, for
 * example after an app reload, the capped cache is shown and marked incomplete until the turn
 * ends and history reloads, because restoring a running session replays history into the
 * stream. */
export function liveSessionView(
  cached: AgentEntry[],
  live: LiveTranscript | null,
  state: AgentSessionState | undefined,
): {
  entries: AgentEntry[];
  complete: boolean;
  configOptions: AgentConfigOption[];
  availableCommands?: AgentCommand[];
} {
  return {
    complete: live?.complete ?? false,
    entries: live ? live.entries.slice() : cached,
    configOptions: state?.configOptions ?? [],
    ...(state?.availableCommands ? { availableCommands: state.availableCommands } : {}),
  };
}

function isConfigOption(value: unknown): value is AgentConfigOption {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'type' in value &&
    typeof value.type === 'string' &&
    'options' in value &&
    Array.isArray(value.options)
  );
}

function isCommand(value: unknown): value is AgentCommand {
  return !!value && typeof value === 'object' && 'name' in value && typeof value.name === 'string';
}

function rememberRestoredState(
  agent: AgentId,
  sessionId: string,
  session: { configOptions?: unknown; availableCommands?: unknown },
): void {
  const configOptions: unknown[] = Array.isArray(session.configOptions)
    ? session.configOptions
    : [];
  const availableCommands: unknown[] | null = Array.isArray(session.availableCommands)
    ? session.availableCommands
    : null;
  rememberSessionState(agent, sessionId, {
    configOptions: configOptions.filter(isConfigOption),
    ...(availableCommands ? { availableCommands: availableCommands.filter(isCommand) } : {}),
  });
}

const restoringSessions = new Map<string, Promise<Record<string, unknown>>>();

function restoreSession(
  method: 'acp_load_session' | 'acp_resume_session',
  agent: AgentId,
  cwd: string,
  sessionId: string,
  profile: CapabilityProfile,
) {
  const key = JSON.stringify([agent, cwd, sessionId, profile]);
  const existing = restoringSessions.get(key);
  if (existing) return existing;
  // A restore replays history, so this session's kept transcript can no longer be trusted.
  invalidateLiveTranscript(agent, sessionId);
  const live = sessionKey(agent, sessionId);
  restoringTranscripts.set(live, (restoringTranscripts.get(live) ?? 0) + 1);
  const request = invoke<Record<string, unknown>>(method, {
    agent,
    cwd,
    sessionId,
    profile,
  }).then((session) => {
    invalidateLiveTranscript(agent, sessionId);
    rememberRestoredState(agent, sessionId, session);
    return session;
  });
  restoringSessions.set(key, request);
  void request
    .finally(() => {
      if (restoringSessions.get(key) === request) restoringSessions.delete(key);
      const remaining = (restoringTranscripts.get(live) ?? 1) - 1;
      if (remaining > 0) restoringTranscripts.set(live, remaining);
      else restoringTranscripts.delete(live);
    })
    .catch(() => undefined);
  return request;
}

export const acp = {
  agents: () => invoke<AgentAvailability[]>('acp_agents'),
  connect: (agent: AgentId, profile?: CapabilityProfile) =>
    invoke<Record<string, unknown>>('acp_connect', { agent, profile }),
  create: (agent: AgentId, cwd: string, profile?: CapabilityProfile, nativeGeneration?: number) =>
    invoke<{
      sessionId: string;
      configOptions?: AgentConfigOption[];
      availableCommands?: AgentCommand[];
    }>('acp_new_session', {
      params: { agent, cwd, profile, nativeGeneration },
    }).then((session) => {
      rememberRestoredState(agent, session.sessionId, session);
      return session;
    }),
  listSessions: (agent: AgentId, cwd: string, cursor?: string, profile?: CapabilityProfile) =>
    invoke<AgentSessionListing>('acp_list_sessions', { agent, cwd, cursor, profile }),
  releaseSessionFence: (agent: AgentId, sessionId: string) =>
    invoke<void>('acp_release_session_fence', { agent, sessionId }),
  load: (agent: AgentId, cwd: string, sessionId: string, profile: CapabilityProfile) =>
    restoreSession('acp_load_session', agent, cwd, sessionId, profile),
  resume: (agent: AgentId, cwd: string, sessionId: string, profile: CapabilityProfile) =>
    restoreSession('acp_resume_session', agent, cwd, sessionId, profile),
  forget: (agent: AgentId, directory: string, sessionId: string) => {
    forgetSessionState(agent, sessionId);
    forgetPlanningState({ agent, directory, sessionId });
    acpPlans().forget({ agent, directory, sessionId });
    return invoke<void>('acp_forget_session', { agent, sessionId });
  },
  prompt: (
    agent: AgentId,
    sessionId: string,
    text: string,
    turnId: string,
    imagePaths: string[] = [],
  ) =>
    invoke<AcpPromptOutcome>('acp_prompt', {
      params: { agent, sessionId, text, turnId, imagePaths },
    }),
  steer: (agent: AgentId, sessionId: string, text: string, imagePaths: string[] = []) =>
    invoke<{ outcome: 'injected' | 'startedNewTurn' | 'promptRequired' | 'failed' }>('acp_steer', {
      params: { agent, sessionId, text, imagePaths },
    }),
  cancel: (agent: AgentId, sessionId: string, turnId: string | null) =>
    invoke<void>('acp_cancel', { agent, sessionId, turnId }),
  permission: (
    agent: AgentId,
    requestId: string | number,
    optionId: string | null,
    sessionId: string,
    requestGeneration: number | undefined,
    requestFingerprint: string | undefined,
  ) =>
    invoke<void>('acp_permission', {
      params: {
        agent,
        requestId,
        optionId,
        sessionId,
        requestGeneration,
        requestFingerprint,
      },
    }),
  permissionResourcesTrusted: (workspace: string, resources: string[]) =>
    invoke<{ trusted: boolean; canonicalResources: string[] }>('acp_permission_resources_trusted', {
      workspace,
      resources,
    }),
  pendingPermissions: (agent: AgentId, sessionId: string) =>
    invoke<AgentEvent['message'][]>('acp_pending_permissions', { agent, sessionId }),
  pendingElicitations: (agent: AgentId, sessionId: string) =>
    invoke<AgentEvent['message'][]>('acp_pending_elicitations', { agent, sessionId }),
  elicitation: (
    agent: AgentId,
    requestId: string | number,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => invoke<void>('acp_elicitation', { params: { agent, requestId, action, content } }),
  pendingInbox: () => invoke<AcpPendingInboxItem[]>('acp_pending_inbox'),
  activity: () => invoke<Record<AgentId, AgentActivity>>('acp_activity'),
  nativeSubagents: (directory: string) =>
    invoke<NativeSubagentSnapshotSet>('acp_native_subagents', { directory }),
  turnEvidence: (agent: AgentId, sessionId: string, turnId: string) =>
    invoke<AcpTurnEvidence | null>('get_acp_turn_evidence', { agent, sessionId, turnId }),
  interruptedTurns: () => invoke<InterruptedAgentTurn[]>('list_interrupted_agent_turns'),
  finishInterruptedTurn: (turn: InterruptedAgentTurn) =>
    invoke<void>('finish_interrupted_agent_turn', {
      agent: turn.agent,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    }),
  prepareRestart: () => invoke<void>('acp_prepare_restart'),
  setConfig: (agent: AgentId, sessionId: string, configId: string, value: string) =>
    invoke<{ configOptions?: AgentConfigOption[] }>('acp_set_config', {
      agent,
      sessionId,
      configId,
      value,
    }).then((result) => {
      if (result.configOptions)
        rememberSessionState(agent, sessionId, { configOptions: result.configOptions });
      return result;
    }),
  authenticate: (agent: AgentId, methodId: string, profile?: CapabilityProfile) =>
    invoke<Record<string, unknown>>('acp_authenticate', { agent, methodId, profile }),
};

export async function acpFinishedPromptStatus(
  agent: AgentId,
  sessionId: string,
  turnId: string,
): Promise<'done' | 'failed' | 'interrupted' | null> {
  const activity = await acp.activity().catch(() => null);
  const finished = activity?.[agent]?.finished[sessionId];
  return finished?.turnId === turnId ? finished.status : null;
}

export async function acpFailedPromptInterrupted(
  agent: AgentId,
  sessionId: string,
  turnId: string,
): Promise<boolean> {
  return (await acpFinishedPromptStatus(agent, sessionId, turnId)) === 'interrupted';
}

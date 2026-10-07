import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './settings.ts';
import { toolCommand } from './tool-display.ts';

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
  sessionId: string;
  directory: string;
  title: string;
  updated: number;
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
        typeof item.updated === 'number',
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

export function updateEntriesInPlace(entries: AgentEntry[], update: Record<string, unknown>): void {
  let toolIndexes = replayToolIndexes.get(entries);
  if (
    !toolIndexes &&
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
  ) {
    toolIndexes = indexTools(entries);
    replayToolIndexes.set(entries, toolIndexes);
  }
  applyEntryUpdate(entries, update, toolIndexes);
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

const restoringSessions = new Map<string, Promise<Record<string, unknown>>>();

function restoreSession(
  method: 'acp_load_session' | 'acp_resume_session',
  agent: AgentId,
  cwd: string,
  sessionId: string,
) {
  const key = JSON.stringify([agent, cwd, sessionId]);
  const existing = restoringSessions.get(key);
  if (existing) return existing;
  const request = invoke<Record<string, unknown>>(method, { agent, cwd, sessionId });
  restoringSessions.set(key, request);
  void request
    .finally(() => {
      if (restoringSessions.get(key) === request) restoringSessions.delete(key);
    })
    .catch(() => undefined);
  return request;
}

export const acp = {
  agents: () => invoke<AgentAvailability[]>('acp_agents'),
  connect: (agent: AgentId) => invoke<Record<string, unknown>>('acp_connect', { agent }),
  create: (agent: AgentId, cwd: string) =>
    invoke<{
      sessionId: string;
      configOptions?: AgentConfigOption[];
      availableCommands?: AgentCommand[];
    }>('acp_new_session', {
      agent,
      cwd,
    }),
  load: (agent: AgentId, cwd: string, sessionId: string) =>
    restoreSession('acp_load_session', agent, cwd, sessionId),
  resume: (agent: AgentId, cwd: string, sessionId: string) =>
    restoreSession('acp_resume_session', agent, cwd, sessionId),
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
  permission: (agent: AgentId, requestId: string | number, optionId: string | null) =>
    invoke<void>('acp_permission', { agent, requestId, optionId }),
  pendingPermissions: (agent: AgentId, sessionId: string) =>
    invoke<AgentEvent['message'][]>('acp_pending_permissions', { agent, sessionId }),
  pendingInbox: () => invoke<AcpPendingInboxItem[]>('acp_pending_inbox'),
  activity: () => invoke<Record<AgentId, AgentActivity>>('acp_activity'),
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
    }),
  authenticate: (agent: AgentId, methodId: string) =>
    invoke<Record<string, unknown>>('acp_authenticate', { agent, methodId }),
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

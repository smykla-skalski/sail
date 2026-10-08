import type { SessionMessageInfo, PromptFileAttachment } from '@opencode/client';
import type { AgentDisplayEntry, AgentTool } from './acp';
import {
  receiptNeedsLiveActivity,
  withSpawnResponses,
  type SpawnReceipt,
} from './agent-results.ts';
import type { CoordinationMessage } from './coordination';
import type { HookActivity } from './hook-activity';
import type { PostTurnCheck } from './post-turn-checks';
import type { ShellRun } from './shell-command';
import { openCodeErrorDetails, reportedHookIdentity } from './tool-failure.ts';

export type TranscriptTool = {
  id: string;
  title: string;
  status: string;
  input?: unknown;
  output: string;
  error: string;
  source: string;
  terminalIds: string[];
  /** The host's own tool record, handed back to host callbacks. */
  raw?: unknown;
};

export type TranscriptRole = 'user' | 'assistant' | 'thought';

export type TranscriptMessage = {
  kind: 'message';
  id: string;
  role: TranscriptRole;
  author: string;
  text: string;
  created?: number;
  provider: string;
  files?: string[];
  streaming?: boolean;
  queued?: boolean;
  retry?: string;
  error?: string;
};

export type TranscriptItem =
  | TranscriptMessage
  | { kind: 'tools'; id: string; created?: number; tools: TranscriptTool[] }
  | { kind: 'spawn-response'; id: string; receipt: SpawnReceipt }
  | { kind: 'shell'; id: string; run: ShellRun }
  | { kind: 'hook'; id: string; created: number; activity: HookActivity }
  | { kind: 'checks'; id: string; created: number; checks: PostTurnCheck[] }
  | { kind: 'subagents'; id: string; created: number; receipts: SpawnReceipt[] };

export type TranscriptKind = TranscriptItem['kind'];

export function itemTime(item: TranscriptItem): number | undefined {
  switch (item.kind) {
    case 'message':
    case 'tools':
      return item.created;
    case 'spawn-response':
      return item.receipt.updated;
    case 'shell':
      return item.run.created;
    default:
      return item.created;
  }
}

/**
 * Inserts timed extras into an ordered base list. An extra lands before the first base item that
 * started after it; base items without a time inherit the time of the item before them. Extras
 * with equal times keep their given order.
 */
export function interleave(base: TranscriptItem[], extras: TranscriptItem[]): TranscriptItem[] {
  const sorted = extras
    .map((item, order) => ({ item, order, time: itemTime(item) ?? Number.POSITIVE_INFINITY }))
    .toSorted((a, b) => a.time - b.time || a.order - b.order);
  const result: TranscriptItem[] = [];
  let next = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const item of base) {
    const own = itemTime(item);
    const time = own ?? last;
    while (next < sorted.length && sorted[next].time < time) result.push(sorted[next++].item);
    result.push(item);
    if (own !== undefined) last = own;
  }
  for (; next < sorted.length; next++) result.push(sorted[next].item);
  return result;
}

export function hookItems(activities: HookActivity[]): TranscriptItem[] {
  return activities.map((activity) => ({
    kind: 'hook',
    id: `hook:${activity.id}`,
    created: activity.created,
    activity,
  }));
}

/** One card per turn; a check's own update time places the card after the turn it ran for. */
export function checkItems(checks: PostTurnCheck[]): TranscriptItem[] {
  const turns = new Map<string, PostTurnCheck[]>();
  for (const check of checks) turns.set(check.turn, [...(turns.get(check.turn) ?? []), check]);
  return [...turns.entries()].map(([turn, group]) => ({
    kind: 'checks',
    id: `checks:${turn}`,
    created: Math.min(...group.map((check) => check.updated)),
    checks: group,
  }));
}

/**
 * One group card per view. It sits where the first unsettled child started; with none running it
 * trails, so its live region still announces state changes.
 */
export function subagentItems(receipts: SpawnReceipt[]): TranscriptItem[] {
  if (!receipts.length) return [];
  const active = receipts.filter(receiptNeedsLiveActivity);
  return [
    {
      kind: 'subagents',
      id: 'subagents',
      created: active.length
        ? Math.min(...active.map((receipt) => receipt.created))
        : Number.MAX_SAFE_INTEGER,
      receipts,
    },
  ];
}

/** Coordination messages the agent has not echoed back yet. */
export function pendingCoordinationItems(
  messages: CoordinationMessage[],
  provider: string,
): TranscriptItem[] {
  return messages.map((message) => ({
    kind: 'message',
    id: `coordination:${message.id}`,
    role: 'user',
    author: `From ${message.sender}${message.delivered ? '' : ' · queued'}`,
    text: message.text,
    provider,
  }));
}

export function shellItems(runs: ShellRun[]): TranscriptItem[] {
  return runs.map((run) => ({ kind: 'shell', id: `shell:${run.id}`, run }));
}

export function nativeTool(tool: AgentTool, output: string): TranscriptTool {
  return {
    id: tool.id,
    title: tool.title,
    status: tool.status,
    input: tool.input,
    output,
    error: '',
    source: '',
    terminalIds: tool.terminalIds,
    raw: tool,
  };
}

export function nativeItems(
  entries: AgentDisplayEntry[],
  spawn: SpawnReceipt[],
  host: { name: string; provider: string; toolOutput: (tool: AgentTool) => string },
): TranscriptItem[] {
  return withSpawnResponses(entries, spawn, (entry) => entry.created).map(
    (entry): TranscriptItem => {
      if (entry.type === 'spawn-response')
        return { kind: 'spawn-response', id: entry.id, receipt: entry.receipt };
      if (entry.type === 'tool-group')
        return {
          kind: 'tools',
          id: entry.id,
          created: entry.created,
          tools: entry.tools.map((tool) => nativeTool(tool, host.toolOutput(tool))),
        };
      return {
        kind: 'message',
        id: entry.id,
        role: entry.type,
        author:
          entry.type === 'user'
            ? 'You'
            : entry.type === 'thought'
              ? `${host.name} · thinking`
              : host.name,
        text: entry.text,
        created: entry.created,
        provider: host.provider,
      };
    },
  );
}

function fileLabel(file: PromptFileAttachment): string {
  return file.name ?? (file.source.type === 'uri' ? file.source.uri : 'Attachment');
}

type OpenCodeContent = Extract<SessionMessageInfo, { type: 'assistant' }>['content'][number];

function toolFromPart(
  message: Extract<SessionMessageInfo, { type: 'assistant' }>,
  part: Extract<OpenCodeContent, { type: 'tool' }>,
): TranscriptTool {
  return {
    id: `${message.id}:${part.id}`,
    title: part.name,
    status: part.state.status,
    input: part.state.input,
    output:
      part.state.status === 'completed' || part.state.status === 'error'
        ? (part.state.content ?? [])
            .map((item) => (item.type === 'text' ? item.text : (item.name ?? item.uri)))
            .join('\n')
        : '',
    error: part.state.status === 'error' ? openCodeErrorDetails(part.state.error) : '',
    source: part.state.status === 'error' ? (reportedHookIdentity(part.state.metadata) ?? '') : '',
    terminalIds: [],
    raw: { messageId: message.id, partId: part.id },
  };
}

/** Maps OpenCode messages in event order: text, thinking and consecutive tools stay in sequence. */
export function openCodeItems(
  messages: SessionMessageInfo[],
  spawn: SpawnReceipt[],
  host: { liveText?: Record<string, Record<number, string>> } = {},
): TranscriptItem[] {
  const conversation = messages.filter(
    (message) => message.type === 'user' || message.type === 'assistant',
  );
  const items: TranscriptItem[] = [];
  for (const entry of withSpawnResponses(conversation, spawn, (message) => message.time.created)) {
    if ('receipt' in entry) {
      items.push({ kind: 'spawn-response', id: entry.id, receipt: entry.receipt });
      continue;
    }
    if (entry.type === 'user') {
      items.push({
        kind: 'message',
        id: entry.id,
        role: 'user',
        author: 'You',
        text: entry.text,
        created: entry.time.created,
        provider: 'opencode',
        files: entry.files?.map(fileLabel),
      });
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const created = entry.time.created;
    let tools: TranscriptTool[] = [];
    let texts: string[] = [];
    const flushText = (ordinal: number) => {
      const text = texts.filter(Boolean).join('\n');
      texts = [];
      if (text)
        items.push({
          kind: 'message',
          id: `${entry.id}:text:${ordinal}`,
          role: 'assistant',
          author: entry.agent,
          text,
          created,
          provider: 'opencode',
        });
    };
    const flushTools = (ordinal: number) => {
      if (tools.length)
        items.push({ kind: 'tools', id: `${entry.id}:tools:${ordinal}`, created, tools });
      tools = [];
    };
    entry.content.forEach((part, ordinal) => {
      if (part.type === 'tool') {
        flushText(ordinal);
        tools.push(toolFromPart(entry, part));
        return;
      }
      flushTools(ordinal);
      if (part.type === 'reasoning') {
        flushText(ordinal);
        if (part.text.trim())
          items.push({
            kind: 'message',
            id: `${entry.id}:thought:${ordinal}`,
            role: 'thought',
            author: `${entry.agent} · thinking`,
            text: part.text,
            created,
            provider: 'opencode',
          });
      } else if (part.type === 'text')
        texts.push(host.liveText?.[entry.id]?.[ordinal] ?? part.text);
    });
    flushText(entry.content.length);
    flushTools(entry.content.length);
    const note = [
      entry.retry ? `Retry ${entry.retry.attempt}: ${entry.retry.error.message}` : '',
    ].filter(Boolean);
    if (note.length || entry.error)
      items.push({
        kind: 'message',
        id: `${entry.id}:status`,
        role: 'assistant',
        author: entry.agent,
        text: '',
        created,
        provider: 'opencode',
        retry: note[0],
        error: entry.error?.message,
      });
  }
  return items;
}

/** Streaming text for messages the timeline has not delivered yet. */
export function streamingItems(
  live: [string, Record<string, string>][],
  author: string,
): TranscriptItem[] {
  return live.map(([id, parts]) => ({
    kind: 'message',
    id: `live:${id}`,
    role: 'assistant',
    author: `${author} · streaming`,
    text: Object.entries(parts)
      .toSorted(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => value)
      .join('\n'),
    provider: 'opencode',
    streaming: true,
  }));
}

export type QueuedLike = { author: string; text: string };

export function queuedItems(messages: QueuedLike[], provider: string): TranscriptItem[] {
  return messages.map((message, index) => ({
    kind: 'message',
    id: `queued:${index}`,
    role: 'user',
    author: message.author,
    text: message.text,
    provider,
    queued: true,
  }));
}

/** Chronological transcript: timed hook, check and subagent cards sit between the messages. */
export function buildTranscript(input: {
  base: TranscriptItem[];
  timed?: TranscriptItem[];
  trailing?: TranscriptItem[];
}): TranscriptItem[] {
  return [...interleave(input.base, input.timed ?? []), ...(input.trailing ?? [])];
}

/** The "latest action" row only applies while the agent works and the group is last or running. */
export function currentToolGroup(
  item: Extract<TranscriptItem, { kind: 'tools' }>,
  items: TranscriptItem[],
  busy: boolean,
): boolean {
  const last = items.findLast(
    (entry) =>
      entry.kind === 'message' || entry.kind === 'tools' || entry.kind === 'spawn-response',
  );
  return busy && (last?.id === item.id || item.tools.some(toolRunning));
}

export function toolRunning(tool: Pick<TranscriptTool, 'status'>): boolean {
  return /^(pending|running|in_progress|stopping)$/i.test(tool.status);
}

export function toolFailed(tool: Pick<TranscriptTool, 'status'>): boolean {
  return /fail|error|reject/i.test(tool.status);
}

export function providerName(provider: string): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    default:
      return provider;
  }
}

export function formatMessageTime(created: number | undefined, now = new Date()): string {
  if (created === undefined || !Number.isFinite(created)) return '';
  const at = new Date(created);
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString()
    ? clock
    : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}

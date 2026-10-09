import type { ActivityHistoryEvent } from './activity-history.ts';
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
  /** The host's own message id, for scroll anchors; item ids may carry a part suffix. */
  sourceId?: string;
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
  | { kind: 'subagents'; id: string; created: number; receipts: SpawnReceipt[] }
  | {
      kind: 'decision';
      id: string;
      created: number;
      title: string;
      outcome: 'allowed' | 'rejected';
      reason: string;
    };

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

/** Permissions Sail settled by policy for one session, shown where they happened. */
export function decisionItems(
  events: readonly ActivityHistoryEvent[],
  thread: { agent: string; directory: string; sessionId: string },
): TranscriptItem[] {
  const { agent, directory, sessionId } = thread;
  return events
    .filter(
      (event) =>
        event.kind === 'decision' &&
        event.workspace === directory &&
        event.automatic === true &&
        event.agent === agent &&
        event.sessionId === sessionId,
    )
    .toSorted((left, right) => left.at - right.at)
    .map((event) => ({
      kind: 'decision',
      id: `decision:${event.id}`,
      created: event.at,
      title: event.title,
      outcome: event.outcome === 'rejected' ? 'rejected' : 'allowed',
      // Policy decision titles already quote the reason; repeat it only when they do not.
      reason: event.reason && !event.title.includes(event.reason) ? event.reason : '',
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

/** Changes whenever the newest message or tool group grows, such as a streaming message or a
 * running tool's output, so Jump to latest can tell new output from a new item. Rows placed by
 * time, such as hooks and decisions, are skipped. */
export function latestRevision(items: readonly TranscriptItem[]): string {
  const last = items.findLast((item) => item.kind === 'message' || item.kind === 'tools');
  if (!last) return '';
  const size =
    last.kind === 'message'
      ? last.text.length
      : last.kind === 'tools'
        ? last.tools.map((tool) => tool.output.length).join(',')
        : '';
  return `${last.id}:${size}`;
}

/** Jump to latest label: new items are counted; growth of the newest one reads "new output". */
export function jumpLabel(newItems: number, grew: boolean): string {
  if (newItems > 0) return `Jump to latest (${newItems} new)`;
  return grew ? 'Jump to latest (new output)' : 'Jump to latest';
}

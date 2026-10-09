import type { AgentEntry, AgentMessage } from './acp';
import { receiptSourceId, type SpawnReceipt, type SpawnState } from './agent-results.ts';
import { nativeSubagentStatus, type NativeSubagentStore } from './native-subagents.ts';
import {
  isFailedStatus,
  splitTaskNotifications,
  type TaskNotification,
} from './task-notification.ts';

export type SubagentSource = 'native' | 'mcp' | 'task-notification';

/** Live sources first: native ACP children, then MCP spawn receipts and the task notifications a
 * parent transcript carries. */
export const subagentSourcePrecedence: readonly SubagentSource[] = [
  'native',
  'mcp',
  'task-notification',
];

export type SubagentControls = {
  /** The agent accepts a follow-up prompt for this child. */
  prompt: boolean;
  /** The agent can stop this child without stopping its parent. */
  cancel: boolean;
};

export type SubagentUsage = { tokens?: number; toolUses?: number; durationMs?: number };

/** One child agent, whichever sources reported it. `SpawnReceipt` stays the stored record. */
export type SubagentRun = {
  /** Thread id of the child session (`acp:<agent>:<session>`). An MCP
   * child that has no session yet uses `receipt:<receiptId>`. */
  id: string;
  /** The highest-precedence source that reported this child. */
  source: SubagentSource;
  /** Every source that reported this child, in precedence order. */
  sources: SubagentSource[];
  agent: string;
  sessionId: string | null;
  directory: string | null;
  parentId: string | null;
  parentDirectory: string | null;
  name: string | null;
  task: string | null;
  model: string | null;
  state: SpawnState;
  activity: string | null;
  result: string | null;
  error: string | null;
  created: number | null;
  updated: number;
  /** Id of the stored `SpawnReceipt` for this child; native children have none. */
  receiptId: string | null;
  usage: SubagentUsage | null;
  controls: SubagentControls;
};

/** A parent session's complete transcript; the generation join counts notifications in it. */
export type ParentTranscript = {
  agent: string;
  sessionId: string;
  directory: string;
  entries: readonly AgentEntry[];
};

export type SubagentRunSources = {
  native?: NativeSubagentStore;
  receipts?: readonly SpawnReceipt[];
  transcripts?: readonly ParentTranscript[];
};

/** claude-agent-acp 0.84.0 advertises no child capabilities: a child prompt fails with "Session
 * not found" and a child cancel is ignored, so only the parent turn can stop its children. */
const nativeControls: SubagentControls = { prompt: false, cancel: false };

function nativeRuns(store: NativeSubagentStore): SubagentRun[] {
  return Object.values(store).map((child) => {
    const { state, activity } = nativeSubagentStatus(child);
    const settled = state !== 'working' && state !== 'waiting';
    const output = settled
      ? child.transcript
          .findLast((entry): entry is AgentMessage => entry.type === 'assistant')
          ?.text.trim()
      : undefined;
    return {
      id: receiptSourceId(child.agent, child.sessionId),
      source: 'native',
      sources: ['native'],
      agent: child.agent,
      sessionId: child.sessionId,
      directory: child.directory,
      parentId: receiptSourceId(child.agent, child.parentSessionId),
      parentDirectory: child.directory,
      name: child.name,
      task: child.task,
      model: null,
      state,
      activity,
      result: output || null,
      error: child.error ?? null,
      created: child.created,
      updated: child.updated,
      receiptId: null,
      usage: null,
      controls: nativeControls,
    };
  });
}

function threadSession(threadId: string, provider: string): string | null {
  const prefix = `acp:${provider}:`;
  return threadId.startsWith(prefix) && threadId.length > prefix.length
    ? threadId.slice(prefix.length)
    : null;
}

function receiptRuns(receipts: readonly SpawnReceipt[]): SubagentRun[] {
  return receipts
    .filter((receipt) => !receipt.receiptId.startsWith('native:'))
    .map((receipt) => {
      const sessionId = receipt.targetId ? threadSession(receipt.targetId, receipt.provider) : null;
      return {
        id: sessionId
          ? receiptSourceId(receipt.provider, sessionId)
          : `receipt:${receipt.receiptId}`,
        source: 'mcp',
        sources: ['mcp'],
        agent: receipt.provider,
        sessionId,
        directory: receipt.targetDirectory,
        parentId: receipt.sourceId,
        parentDirectory: receipt.sourceDirectory,
        name: null,
        task: receipt.prompt,
        model: receipt.model ?? null,
        state: receipt.state,
        activity: receipt.activity ?? null,
        result: receipt.result,
        error: receipt.error,
        created: receipt.created,
        updated: receipt.updated,
        receiptId: receipt.receiptId,
        usage: null,
        controls: { prompt: !!sessionId, cancel: !!sessionId },
      };
    });
}

/** Child session ids for task notifications in transcript order. claude-agent-acp names a task's
 * first child session after its task id and each resumed generation `${taskId}:generation:N`,
 * and the parent receives one notification per generation. Generations are counted by position,
 * so the ids are only right for a parent's complete transcript, not a recent-entries window. The
 * ACP subagents RFD form (agentclientprotocol/claude-agent-acp#1257) keeps one session id per
 * child, so this join changes when Sail adopts it. Replayed children (`:replay-subagent:`) carry
 * no task id and stay unjoined. */
export function taskNotificationSessionIds(taskIds: readonly string[]): string[] {
  const generations = new Map<string, number>();
  return taskIds.map((taskId) => {
    const generation = (generations.get(taskId) ?? 0) + 1;
    generations.set(taskId, generation);
    return generation === 1 ? taskId : `${taskId}:generation:${generation}`;
  });
}

function notificationState(status: string): SpawnState {
  if (status === 'completed') return 'completed';
  if (isFailedStatus(status)) return 'failed';
  return ['stopped', 'cancelled', 'interrupted'].includes(status) ? 'interrupted' : 'unavailable';
}

function usage({ tokens, toolUses, durationMs }: TaskNotification): SubagentUsage | null {
  const value = {
    ...(tokens === undefined ? {} : { tokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  return Object.keys(value).length ? value : null;
}

function notificationRuns(transcripts: readonly ParentTranscript[]): SubagentRun[] {
  return transcripts.flatMap(({ agent, sessionId, directory, entries }) => {
    // Restored entries can lack a time; the parent's latest known one keeps them in order.
    const latest = Math.max(0, ...entries.map((entry) => entry.created ?? 0));
    const notes = entries.flatMap((entry) =>
      entry.type === 'user'
        ? splitTaskNotifications(entry.text).flatMap((segment) =>
            segment.type === 'notification'
              ? [{ notification: segment.notification, at: entry.created ?? latest }]
              : [],
          )
        : [],
    );
    const childIds = taskNotificationSessionIds(notes.map((note) => note.notification.taskId));
    return notes.map(({ notification, at }, index): SubagentRun => ({
      id: receiptSourceId(agent, childIds[index]),
      source: 'task-notification',
      sources: ['task-notification'],
      agent,
      sessionId: childIds[index],
      directory,
      parentId: receiptSourceId(agent, sessionId),
      parentDirectory: directory,
      name: null,
      task: null,
      model: null,
      state: notificationState(notification.status),
      activity: notification.summary,
      result: notification.summary,
      error: null,
      created: null,
      updated: at,
      receiptId: null,
      usage: usage(notification),
      controls: nativeControls,
    }));
  });
}

const descriptiveFields = [
  'directory',
  'parentId',
  'parentDirectory',
  'name',
  'task',
  'model',
  'created',
  'receiptId',
  'usage',
] as const;
const outcomeFields = ['activity', 'result', 'error'] as const;

function fill(
  run: SubagentRun,
  fields: readonly (keyof SubagentRun)[],
  candidates: SubagentRun[],
): void {
  for (const field of fields) {
    if (run[field] !== null) continue;
    const value = candidates.find((candidate) => candidate[field] !== null)?.[field];
    if (value !== undefined) Object.assign(run, { [field]: value });
  }
}

/** Merges candidates sorted by precedence, newest first within a source. Only lower sources
 * lend outcome text, because an older record from the winner's own source describes an earlier
 * turn. A known terminal state from a lower source replaces a state the winner could not
 * confirm, such as a disconnected native child; a live state from a lower source can be stale,
 * so it never does. */
function merge(candidates: SubagentRun[]): SubagentRun {
  const [winner] = candidates;
  const lower = candidates.filter((candidate) => candidate.source !== winner.source);
  const outcome =
    winner.state === 'unavailable'
      ? (lower.find((candidate) =>
          ['completed', 'failed', 'interrupted'].includes(candidate.state),
        ) ?? winner)
      : winner;
  const run: SubagentRun = {
    ...winner,
    sources: [...new Set(candidates.map((candidate) => candidate.source))],
    state: outcome.state,
    activity: outcome.activity,
    result: outcome.result,
    error: outcome.error,
    updated: Math.max(...candidates.map((candidate) => candidate.updated)),
  };
  fill(run, descriptiveFields, candidates);
  fill(
    run,
    outcomeFields,
    lower.filter((candidate) => candidate.state === run.state),
  );
  return run;
}

/** Creation order, with runs that carry no time at all last. */
function order(run: SubagentRun): number {
  return run.created ?? (run.updated || Number.POSITIVE_INFINITY);
}

/** Joins every subagent source into one run per child session. When sources overlap, the
 * higher-precedence source sets the state; others fill descriptive fields it lacks, and outcome
 * text only when they report the same state. */
export function subagentRuns({
  native = {},
  receipts = [],
  transcripts = [],
}: SubagentRunSources): SubagentRun[] {
  const rank = (run: SubagentRun) => subagentSourcePrecedence.indexOf(run.source);
  const byId = new Map<string, SubagentRun[]>();
  for (const run of [
    ...nativeRuns(native),
    ...receiptRuns(receipts),
    ...notificationRuns(transcripts),
  ]) {
    const candidates = byId.get(run.id) ?? [];
    candidates.push(run);
    byId.set(run.id, candidates);
  }
  return [...byId.values()]
    .map((candidates) =>
      merge(candidates.toSorted((a, b) => rank(a) - rank(b) || b.updated - a.updated)),
    )
    .toSorted((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}

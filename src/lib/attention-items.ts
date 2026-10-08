import { isInboxOutcome, repositoryName, type InboxItem } from './inbox.ts';
import type { MergeOwner, ShipIssue, ShipRun } from './issue-shipping.ts';
import type { SpawnReceipt } from './agent-results.ts';
import {
  shipClosedBeforeLaunch,
  shipClosedWithoutMerge,
  shipIssuePresentation,
} from './ship-progress.ts';

/**
 * Everything that needs the user, as one list. Dock badge, Inbox, Ship tab,
 * status bar, notifications and the next-item shortcut all read this list.
 */
export const attentionKinds = [
  'permission',
  'question',
  'ship-needs-input',
  'ship-ready-to-merge',
  'ship-closed-unmerged',
  'subagent-waiting',
  'ship-stalled',
] as const;
export type AttentionKind = (typeof attentionKinds)[number];

export type AttentionTarget =
  | {
      type: 'thread';
      agentId: string;
      directory: string;
      sessionId: string;
      requestId?: string | number;
    }
  | { type: 'ship-issue'; runId: string; issueId: string; repository: string }
  | { type: 'pr'; url: string; runId: string; issueId: string; repository: string }
  | { type: 'subagent'; receiptId: string; directory: string; targetId: string | null };

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export type AttentionItem = {
  /** Target plus kind. Two items with the same id are one item. */
  id: string;
  kind: AttentionKind;
  target: AttentionTarget;
  /** Repository name the Inbox groups by. */
  repo: string;
  /** When the state began. */
  since: number;
  severity: AttentionSeverity;
  /** State-derived items can be dismissed or snoozed; session requests cannot. */
  dismissible: boolean;
  title: string;
  detail?: string;
};

export type AttentionCandidate = Omit<AttentionItem, 'since'> & { since?: number };

const severityOrder: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function attentionTargetKey(target: AttentionTarget): string {
  switch (target.type) {
    case 'thread':
      return JSON.stringify([
        'thread',
        target.agentId,
        target.directory,
        target.sessionId,
        target.requestId === undefined ? null : String(target.requestId),
      ]);
    case 'ship-issue':
      return JSON.stringify(['ship-issue', target.runId, target.issueId]);
    case 'pr':
      return JSON.stringify(['pr', target.runId, target.issueId, target.url]);
    default:
      return JSON.stringify(['subagent', target.receiptId]);
  }
}

export function attentionItemId(kind: AttentionKind, target: AttentionTarget): string {
  return `${kind}:${attentionTargetKey(target)}`;
}

function candidate(
  kind: AttentionKind,
  target: AttentionTarget,
  rest: Omit<AttentionCandidate, 'id' | 'kind' | 'target'>,
): AttentionCandidate {
  return { id: attentionItemId(kind, target), kind, target, ...rest };
}

/** Pending permission and question requests from the session Inbox. */
export function sessionRequestCandidates(items: InboxItem[]): AttentionCandidate[] {
  return items.flatMap((item) => {
    if (isInboxOutcome(item)) return [];
    const target: AttentionTarget = {
      type: 'thread',
      agentId: item.agentId ?? 'opencode',
      directory: item.directory,
      sessionId: item.sessionId,
      ...(item.requestId === undefined ? {} : { requestId: item.requestId }),
    };
    return [
      candidate(item.kind === 'question' ? 'question' : 'permission', target, {
        repo: item.project,
        since: item.receivedAt,
        severity: 'critical',
        dismissible: false,
        title: item.text,
        detail: item.worktree ? `${item.agent} · ${item.worktree}` : item.agent,
      }),
    ];
  });
}

/** `${agentId}:${sessionId}` keys of threads that already show a pending request. */
export function threadRequestKeys(items: AttentionCandidate[]): Set<string> {
  return new Set(
    items.flatMap((item) =>
      item.target.type === 'thread'
        ? [threadKeyOf(item.target.directory, item.target.agentId, item.target.sessionId)]
        : [],
    ),
  );
}

function threadKeyOf(directory: string, agentId: string, sessionId: string): string {
  return JSON.stringify([directory, agentId, sessionId]);
}

/** Splits a Ship thread id (`acp:<agent>:<session>` or `opencode:<session>`). */
export function shipThreadParts(threadId: string): { agentId: string; sessionId: string } | null {
  if (threadId.startsWith('opencode:'))
    return { agentId: 'opencode', sessionId: threadId.slice('opencode:'.length) };
  const match = /^acp:([^:]+):(.+)$/.exec(threadId);
  return match ? { agentId: match[1], sessionId: match[2] } : null;
}

/** A claim heartbeat older than this means the worker stopped reporting. */
export const staleHeartbeatMillis = 5 * 60_000;

/**
 * A running Ship worker whose claim expired or stopped heartbeating. Needs the
 * claim data from #271; an issue without a claim is never stalled.
 */
export function shipStalled(issue: ShipIssue, now: number): boolean {
  if (issue.state !== 'starting' && issue.state !== 'working') return false;
  const claim = issue.claim;
  if (!claim || claim.status !== 'active') return false;
  const expires = Date.parse(claim.expiresAt);
  const heartbeat = Date.parse(claim.heartbeatAt);
  if (Number.isFinite(expires) && expires <= now) return true;
  return Number.isFinite(heartbeat) && now - heartbeat > staleHeartbeatMillis;
}

export type ShipAttentionOptions = {
  mergeOwner: MergeOwner;
  now: number;
  /** Threads that already show their own pending request, so Ship does not count them twice. */
  requestThreads?: ReadonlySet<string>;
};

function shipRepositoryName(run: ShipRun): string {
  return repositoryName(run.repository);
}

function issueRef(issue: ShipIssue): string {
  return issue.title === `Issue #${issue.number}`
    ? `#${issue.number}`
    : `#${issue.number} ${issue.title}`;
}

/**
 * Attention items for every Ship issue. CI failures that Ship manages are not
 * items: they surface only when the worker reports blocked, as "Needs input".
 */
export function shipAttentionCandidates(
  runs: ShipRun[],
  options: ShipAttentionOptions,
): AttentionCandidate[] {
  const items: AttentionCandidate[] = [];
  for (const run of runs) {
    for (const issue of run.issues) {
      if (issue.state === 'merged' || shipClosedBeforeLaunch(issue)) continue;
      const target: AttentionTarget = {
        type: 'ship-issue',
        runId: run.id,
        issueId: issue.id,
        repository: run.repository,
      };
      const common = { repo: shipRepositoryName(run), dismissible: true };
      if (shipClosedWithoutMerge(issue)) {
        const prTarget: AttentionTarget = issue.pullRequest
          ? {
              type: 'pr',
              url: issue.pullRequest,
              runId: run.id,
              issueId: issue.id,
              repository: run.repository,
            }
          : target;
        items.push(
          candidate('ship-closed-unmerged', prTarget, {
            ...common,
            severity: 'warning',
            title: issueRef(issue),
            detail: 'Pull request closed without merging',
          }),
        );
        continue;
      }
      if (shipStalled(issue, options.now)) {
        items.push(
          candidate('ship-stalled', target, {
            ...common,
            severity: 'warning',
            title: issueRef(issue),
            detail: 'The worker stopped reporting',
          }),
        );
        continue;
      }
      const presentation = shipIssuePresentation(run, issue, { mergeOwner: options.mergeOwner });
      if (presentation.label === 'Ready to merge') {
        items.push(
          candidate('ship-ready-to-merge', target, {
            ...common,
            severity: 'info',
            title: issueRef(issue),
            detail: presentation.nextAction,
          }),
        );
      } else if (presentation.label === 'Needs input') {
        const worker = issue.threadId ? shipThreadParts(issue.threadId) : null;
        if (
          worker &&
          issue.path &&
          options.requestThreads?.has(threadKeyOf(issue.path, worker.agentId, worker.sessionId))
        )
          continue;
        items.push(
          candidate('ship-needs-input', target, {
            ...common,
            severity: 'critical',
            title: issueRef(issue),
            detail: presentation.reason ?? presentation.nextAction,
          }),
        );
      }
    }
  }
  return items;
}

/** Receipts of Ship workers. Their state is already reported as Ship issue state. */
export function shipReceiptIds(runs: ShipRun[]): Set<string> {
  return new Set(
    runs.flatMap((run) =>
      run.issues.flatMap((issue) => (issue.receiptId ? [issue.receiptId] : [])),
    ),
  );
}

/**
 * Subagents that wait on the user. Validation gates, Ship workers and threads that
 * already show a request of their own are not counted again.
 */
export function subagentAttentionCandidates(
  receipts: SpawnReceipt[],
  requestThreads: ReadonlySet<string> = new Set(),
  excludedReceipts: ReadonlySet<string> = new Set(),
): AttentionCandidate[] {
  return receipts.flatMap((receipt) => {
    if (receipt.state !== 'waiting' || !receipt.targetId || receipt.validation) return [];
    if (excludedReceipts.has(receipt.receiptId)) return [];
    const directory = receipt.targetDirectory ?? receipt.sourceDirectory;
    const parts = shipThreadParts(receipt.targetId);
    if (parts && requestThreads.has(threadKeyOf(directory, parts.agentId, parts.sessionId)))
      return [];
    return [
      candidate(
        'subagent-waiting',
        {
          type: 'subagent',
          receiptId: receipt.receiptId,
          directory,
          targetId: receipt.targetId,
        },
        {
          repo: repositoryName(receipt.project),
          since: receipt.updated,
          severity: 'warning',
          dismissible: true,
          title: receipt.prompt?.split('\n')[0]?.slice(0, 120) || 'Subagent',
          detail: 'Subagent needs your input',
        },
      ),
    ];
  });
}

export type AttentionHidden =
  { mode: 'dismissed'; since: number } | { mode: 'snoozed'; since: number; until: number };

export type AttentionLedger = {
  /** First time each current item was seen, for items without their own timestamp. */
  seen: Record<string, number>;
  hidden: Record<string, AttentionHidden>;
  /** When each remembered item first went missing. Absent while everything is present. */
  gone?: Record<string, number>;
};

/**
 * How long an item may be missing before its state counts as resolved. Sources
 * such as native subagents load after start, so a short absence is not a resolution.
 */
export const attentionGraceMillis = 2 * 60_000;

export const emptyAttentionLedger: AttentionLedger = { seen: {}, hidden: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseHidden(entry: unknown): AttentionHidden | null {
  if (!isRecord(entry) || typeof entry.since !== 'number' || !Number.isFinite(entry.since))
    return null;
  if (entry.mode === 'dismissed') return { mode: 'dismissed', since: entry.since };
  if (entry.mode === 'snoozed' && typeof entry.until === 'number' && Number.isFinite(entry.until))
    return { mode: 'snoozed', since: entry.since, until: entry.until };
  return null;
}

export function loadAttentionLedger(raw: string | null): AttentionLedger {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!isRecord(value)) return { seen: {}, hidden: {} };
    const seen = Object.fromEntries(
      Object.entries(isRecord(value.seen) ? value.seen : {}).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    );
    const hidden: Record<string, AttentionHidden> = {};
    if (isRecord(value.hidden))
      for (const [id, entry] of Object.entries(value.hidden)) {
        const parsed = parseHidden(entry);
        if (parsed) hidden[id] = parsed;
      }
    const gone = Object.fromEntries(
      Object.entries(isRecord(value.gone) ? value.gone : {}).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    );
    return Object.keys(gone).length ? { seen, hidden, gone } : { seen, hidden };
  } catch {
    return { seen: {}, hidden: {} };
  }
}

export type AttentionSnooze = 'hour' | 'tomorrow';

/** One hour from now, or 08:00 local time on the next calendar day. */
export function snoozeUntil(choice: AttentionSnooze, now: number): number {
  if (choice === 'hour') return now + 3_600_000;
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 8, 0, 0, 0).getTime();
}

export function dismissAttention(
  ledger: AttentionLedger,
  item: Pick<AttentionItem, 'id' | 'since' | 'dismissible'>,
): AttentionLedger {
  if (!item.dismissible) return ledger;
  return {
    ...ledger,
    hidden: { ...ledger.hidden, [item.id]: { mode: 'dismissed', since: item.since } },
  };
}

export function snoozeAttention(
  ledger: AttentionLedger,
  item: Pick<AttentionItem, 'id' | 'since' | 'dismissible'>,
  until: number,
): AttentionLedger {
  if (!item.dismissible) return ledger;
  return {
    ...ledger,
    hidden: { ...ledger.hidden, [item.id]: { mode: 'snoozed', since: item.since, until } },
  };
}

export function compareAttention(left: AttentionItem, right: AttentionItem): number {
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.since - right.since ||
    left.id.localeCompare(right.id)
  );
}

export type AttentionView = {
  /** Items that currently need the user, most urgent first. */
  items: AttentionItem[];
  /** The ledger to persist. Equal to the input when nothing changed. */
  ledger: AttentionLedger;
  changed: boolean;
};

/**
 * Dedupes candidates by target plus kind, stamps when each state began, hides
 * dismissed and snoozed items, and forgets items whose state stayed resolved
 * for longer than the grace period.
 *
 * - A dismissed item returns when its state changes: its kind changes, or it
 *   resolves and comes back with a new start time.
 * - A snoozed item returns when the snooze ends.
 */
export function applyAttentionLifecycle(
  ledger: AttentionLedger,
  candidates: AttentionCandidate[],
  now: number,
): AttentionView {
  const unique = new Map<string, AttentionCandidate>();
  for (const item of candidates) {
    const existing = unique.get(item.id);
    if (!existing || (item.since ?? Infinity) < (existing.since ?? Infinity))
      unique.set(item.id, item);
  }
  const seen: Record<string, number> = {};
  const hidden: Record<string, AttentionHidden> = {};
  const items: AttentionItem[] = [];
  for (const entry of unique.values()) {
    const since = entry.since ?? ledger.seen[entry.id] ?? now;
    if (entry.since === undefined) seen[entry.id] = since;
    const item: AttentionItem = { ...entry, since };
    const hide = item.dismissible ? ledger.hidden[item.id] : undefined;
    if (hide && hide.since === since && (hide.mode === 'dismissed' || now < hide.until)) {
      hidden[item.id] = hide;
      continue;
    }
    items.push(item);
  }
  items.sort(compareAttention);
  const gone: Record<string, number> = {};
  for (const id of new Set([...Object.keys(ledger.seen), ...Object.keys(ledger.hidden)])) {
    if (unique.has(id)) continue;
    const hide = ledger.hidden[id];
    const missingSince = ledger.gone?.[id] ?? now;
    if (now - missingSince > attentionGraceMillis) continue;
    if (hide?.mode === 'snoozed' && now >= hide.until) continue;
    gone[id] = missingSince;
    if (id in ledger.seen) seen[id] = ledger.seen[id];
    if (hide) hidden[id] = hide;
  }
  const next: AttentionLedger = Object.keys(gone).length
    ? { seen, hidden, gone }
    : { seen, hidden };
  const changed = JSON.stringify(next) !== JSON.stringify(ledger);
  return { items, ledger: changed ? next : ledger, changed };
}

/**
 * The item after `currentId` in urgency order, wrapping around. Without a
 * current item, the most urgent one.
 */
export function nextAttentionItem(
  items: AttentionItem[],
  currentId: string | null,
): AttentionItem | null {
  if (!items.length) return null;
  const index = currentId === null ? -1 : items.findIndex((item) => item.id === currentId);
  return items[(index + 1) % items.length];
}

export type AttentionRoute =
  | {
      view: 'thread';
      agentId: string;
      directory: string;
      sessionId: string;
      requestId?: string | number;
    }
  | {
      view: 'ship';
      repository: string;
      runId: string;
      issueId: string;
      focus: 'issue' | 'pull-request';
    }
  | { view: 'subagent'; receiptId: string; directory: string; targetId: string | null };

/** Where opening an item lands. */
export function attentionRoute(target: AttentionTarget): AttentionRoute {
  switch (target.type) {
    case 'thread':
      return {
        view: 'thread',
        agentId: target.agentId,
        directory: target.directory,
        sessionId: target.sessionId,
        ...(target.requestId === undefined ? {} : { requestId: target.requestId }),
      };
    case 'ship-issue':
      return {
        view: 'ship',
        repository: target.repository,
        runId: target.runId,
        issueId: target.issueId,
        focus: 'issue',
      };
    case 'pr':
      return {
        view: 'ship',
        repository: target.repository,
        runId: target.runId,
        issueId: target.issueId,
        focus: 'pull-request',
      };
    default:
      return {
        view: 'subagent',
        receiptId: target.receiptId,
        directory: target.directory,
        targetId: target.targetId,
      };
  }
}

export function isAttentionTarget(value: unknown): value is AttentionTarget {
  if (!isRecord(value)) return false;
  const text = (key: string) => typeof value[key] === 'string' && value[key].length > 0;
  switch (value.type) {
    case 'thread':
      return text('agentId') && text('directory') && text('sessionId');
    case 'ship-issue':
      return text('runId') && text('issueId') && text('repository');
    case 'pr':
      return text('url') && text('runId') && text('issueId') && text('repository');
    case 'subagent':
      return text('receiptId') && text('directory');
    default:
      return false;
  }
}

export type AttentionSummary = {
  /** Every item that needs the user. Dock, Inbox and status bar show this. */
  total: number;
  /** Ship issues that need input. The Ship tab shows this. */
  shipNeedsInput: number;
  byRepo: Record<string, number>;
};

export function attentionSummary(items: AttentionItem[]): AttentionSummary {
  const byRepo: Record<string, number> = {};
  for (const item of items) byRepo[item.repo] = (byRepo[item.repo] ?? 0) + 1;
  return {
    total: items.length,
    shipNeedsInput: items.filter((item) => item.kind === 'ship-needs-input').length,
    byRepo,
  };
}

export type AttentionSurfaceCounts = {
  dock: number;
  inbox: number;
  shipTab: number;
  statusBar: number;
};

/** The number each surface shows, all taken from the same list. */
export function attentionSurfaceCounts(items: AttentionItem[]): AttentionSurfaceCounts {
  const { total, shipNeedsInput } = attentionSummary(items);
  return { dock: total, inbox: total, shipTab: shipNeedsInput, statusBar: total };
}

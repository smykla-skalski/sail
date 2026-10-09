import { mergeAgentThreadListing, type AgentSessionListing, type AgentThread } from './acp.ts';
import type { AttentionMap, ThreadStatus } from './attention';
import { threadKey } from './recent-threads.ts';
import { acpThreadId, sameThreadId } from './thread-id.ts';
import {
  activeSubagentsForSource,
  receiptIsSettled,
  receiptSourceId,
  runningSubagentsForSource,
  type SpawnReceipt,
} from './agent-results.ts';

export type SidebarThreadRow = {
  /** Unique within a list: a reference row repeats the thread it points at. */
  key: string;
  thread: AgentThread;
  depth: number;
  /** Children and deeper descendants, shown on the parent as (+N). */
  descendants: number;
  /** A pointer to a child that lives in another worktree. */
  reference: boolean;
  /** Title of the parent thread, for a child whose parent lives in another worktree. */
  spawnedBy: string | null;
  hiddenHistoricalChildren: number;
  historicalChildren: number;
  historicalExpanded: boolean;
};

function sidebarThreadIdentity(thread: AgentThread): string {
  return `${thread.directory}\0${receiptSourceId(thread.agent, thread.sessionId)}`;
}

function recentThreadFirst(left: AgentThread, right: AgentThread): number {
  return right.updated - left.updated;
}

const maxListedPages = 50;

const trimmedPath = (path: string) => path.replace(/\/+$/, '');

/** Pages through an agent's own session history for one directory, including sessions Sail never saw. */
export async function listSidebarAcpThreads(
  agent: string,
  list: (cursor?: string) => Promise<AgentSessionListing>,
  path: string,
  cursor?: string,
  seen = new Set<string>(),
  threads: AgentThread[] = [],
): Promise<AgentThread[]> {
  const listing = await list(cursor);
  for (const session of listing.sessions) {
    if (
      trimmedPath(session.cwd) !== trimmedPath(path) ||
      typeof session.sessionId !== 'string' ||
      !session.sessionId.trim()
    )
      continue;
    threads.push({
      agent,
      directory: path,
      sessionId: session.sessionId,
      title: session.title?.trim() || 'Untitled session',
      updated: session.updatedAt ? Date.parse(session.updatedAt) || 0 : 0,
    });
  }
  const next = listing.nextCursor ?? undefined;
  if (!next || next === cursor || seen.has(next) || seen.size >= maxListedPages) return threads;
  seen.add(next);
  return listSidebarAcpThreads(agent, list, path, next, seen, threads);
}

export function groupSidebarThreads(threads: AgentThread[]): Record<string, AgentThread[]> {
  const unique = new Map<string, AgentThread>();
  for (const thread of threads) {
    const key = threadKey(thread);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, thread);
      continue;
    }
    unique.set(key, mergeAgentThreadListing(previous, thread));
  }
  const grouped: Record<string, AgentThread[]> = {};
  for (const thread of unique.values()) (grouped[thread.directory] ??= []).push(thread);
  for (const items of Object.values(grouped)) items.sort((a, b) => b.updated - a.updated);
  return grouped;
}

export function recordSidebarOpenCodeOutcome(
  outcomes: Record<string, ThreadStatus>,
  thread: AgentThread,
  status: ThreadStatus,
): Record<string, ThreadStatus> {
  return { ...outcomes, [threadKey(thread)]: status };
}

/** A failed child stays listed, because its failure is a result the user has to read. */
function retained(receipt: SpawnReceipt | undefined): boolean {
  return !receipt || !receiptIsSettled(receipt.state) || receipt.state === 'failed';
}

function childThread(receipt: SpawnReceipt): AgentThread | null {
  if (!receipt.targetId || !receipt.targetDirectory) return null;
  const opencode = receipt.targetId.startsWith('opencode:');
  const match = /^acp:([^:]+):(.+)$/.exec(receipt.targetId);
  if (!opencode && !match) return null;
  return {
    agent: opencode ? 'opencode' : (match?.[1] ?? ''),
    directory: receipt.targetDirectory,
    sessionId: opencode ? receipt.targetId.slice('opencode:'.length) : (match?.[2] ?? ''),
    title: receipt.prompt ?? receipt.name ?? 'Subagent',
    updated: receipt.updated,
  };
}

const nestedReceipt = (receipt: SpawnReceipt) =>
  receipt.receiptId.startsWith('native:') || receipt.receiptId.startsWith('opencode-child:');

export function sidebarThreadRows(
  allListed: AgentThread[],
  receipts: SpawnReceipt[],
  expanded: string[] = [],
  everyThread: AgentThread[] = allListed,
): SidebarThreadRow[] {
  const native = receipts.filter(nestedReceipt);
  const listed = new Set(allListed.map(sidebarThreadIdentity));
  // OpenCode lists only top-level sessions, so its children come from their receipts.
  const threads = [
    ...allListed,
    ...native.flatMap((receipt) => {
      const thread = receipt.receiptId.startsWith('opencode-child:') ? childThread(receipt) : null;
      return thread &&
        thread.directory === receipt.sourceDirectory &&
        listed.has(`${receipt.sourceDirectory}\0${acpThreadId(receipt.sourceId)}`) &&
        !listed.has(sidebarThreadIdentity(thread))
        ? [thread]
        : [];
    }),
  ];
  const byIdentity = new Map(threads.map((thread) => [sidebarThreadIdentity(thread), thread]));
  const anywhere = new Map(everyThread.map((thread) => [sidebarThreadIdentity(thread), thread]));
  const receiptByChild = new Map<string, SpawnReceipt>(
    native.flatMap((receipt) =>
      receipt.targetId && receipt.targetDirectory
        ? [[`${receipt.targetDirectory}\0${acpThreadId(receipt.targetId)}`, receipt] as const]
        : [],
    ),
  );
  const references = new Map<string, { thread: AgentThread; receipt: SpawnReceipt }[]>();
  const spawnedBy = new Map<string, string>();
  for (const receipt of receipts) {
    if (nestedReceipt(receipt) || receipt.sourceDirectory === receipt.targetDirectory) continue;
    const thread = childThread(receipt);
    if (!thread) continue;
    const parentKey = `${receipt.sourceDirectory}\0${acpThreadId(receipt.sourceId)}`;
    const parent = byIdentity.get(parentKey);
    if (parent && retained(receipt)) {
      const real = anywhere.get(sidebarThreadIdentity(thread));
      const list = references.get(parentKey) ?? [];
      list.push({ thread: real ?? thread, receipt });
      references.set(parentKey, list);
    }
    const sourceThread = anywhere.get(parentKey);
    spawnedBy.set(sidebarThreadIdentity(thread), sourceThread?.title ?? 'another thread');
  }
  const children = new Map<string, AgentThread[]>();
  const roots: AgentThread[] = [];
  for (const thread of threads) {
    const receipt = receiptByChild.get(sidebarThreadIdentity(thread));
    const parent = receipt
      ? byIdentity.get(`${receipt.sourceDirectory}\0${acpThreadId(receipt.sourceId)}`)
      : undefined;
    if (!parent || parent === thread) roots.push(thread);
    else {
      const parentKey = sidebarThreadIdentity(parent);
      const nested = children.get(parentKey) ?? [];
      nested.push(thread);
      children.set(parentKey, nested);
    }
  }
  roots.sort(recentThreadFirst);
  for (const nested of children.values()) nested.sort(recentThreadFirst);
  const rows: SidebarThreadRow[] = [];
  const visited = new Set<string>();
  const countDescendants = (thread: AgentThread, trail = new Set<string>()): number => {
    const key = sidebarThreadIdentity(thread);
    if (trail.has(key)) return 0;
    const nextTrail = new Set(trail).add(key);
    const nested = children.get(key) ?? [];
    return (
      (references.get(key)?.length ?? 0) +
      nested.reduce((total, child) => total + 1 + countDescendants(child, nextTrail), 0)
    );
  };
  const hasLiveDescendant = (thread: AgentThread, trail = new Set<string>()): boolean => {
    const key = sidebarThreadIdentity(thread);
    if (trail.has(key)) return false;
    const nextTrail = new Set(trail).add(key);
    return (children.get(key) ?? []).some((child) => {
      const receipt = receiptByChild.get(sidebarThreadIdentity(child));
      return retained(receipt) || hasLiveDescendant(child, nextTrail);
    });
  };
  const visit = (thread: AgentThread, depth: number): void => {
    const key = sidebarThreadIdentity(thread);
    if (visited.has(key)) return;
    visited.add(key);
    const nested = children.get(key) ?? [];
    const historicalExpanded = expanded.includes(threadKey(thread));
    const historicalChildren = nested.filter((child) => {
      const receipt = receiptByChild.get(sidebarThreadIdentity(child));
      return !retained(receipt) && !hasLiveDescendant(child);
    }).length;
    const visible = nested.filter((child) => {
      const receipt = receiptByChild.get(sidebarThreadIdentity(child));
      return retained(receipt) || hasLiveDescendant(child) || historicalExpanded;
    });
    rows.push({
      key: threadKey(thread),
      thread,
      depth,
      descendants: countDescendants(thread),
      reference: false,
      spawnedBy: spawnedBy.get(key) ?? null,
      hiddenHistoricalChildren: nested.length - visible.length,
      historicalChildren,
      historicalExpanded,
    });
    for (const link of references.get(key) ?? [])
      rows.push({
        key: `ref:${threadKey(thread)}:${threadKey(link.thread)}`,
        thread: link.thread,
        depth: depth + 1,
        descendants: 0,
        reference: true,
        spawnedBy: null,
        hiddenHistoricalChildren: 0,
        historicalChildren: 0,
        historicalExpanded: false,
      });
    for (const child of visible) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

export function sidebarThreadStatus(
  thread: AgentThread,
  attention: AttentionMap,
  openCodeOutcomes: Record<string, ThreadStatus>,
  acpActivityReady: boolean,
  spawnReceipts: SpawnReceipt[] = [],
): ThreadStatus | null {
  const key = threadKey(thread);
  const saved = attention[key]?.status;
  let status: ThreadStatus | null =
    thread.agent === 'opencode' && saved !== 'working' && saved !== 'waiting'
      ? (openCodeOutcomes[key] ?? saved ?? null)
      : (saved ?? null);
  const child = spawnReceipts.find(
    (receipt) =>
      sameThreadId(receipt.targetId, receiptSourceId(thread.agent, thread.sessionId)) &&
      receipt.targetDirectory === thread.directory,
  );
  if (child && !(saved && receiptIsSettled(child.state) && thread.updated > child.updated)) {
    status =
      child.state === 'working' || child.state === 'waiting'
        ? child.state
        : child.state === 'failed'
          ? 'failed'
          : child.state === 'interrupted'
            ? 'interrupted'
            : child.state === 'completed'
              ? 'done'
              : null;
  }
  if ((status === 'working' || status === 'waiting') && !acpActivityReady) status = null;
  if (status !== 'failed' && status !== 'interrupted') {
    const active = activeSubagentsForSource(
      spawnReceipts,
      receiptSourceId(thread.agent, thread.sessionId),
      thread.directory,
    );
    if (active.length) {
      const confirmed = runningSubagentsForSource(
        spawnReceipts,
        receiptSourceId(thread.agent, thread.sessionId),
        thread.directory,
      ).filter(() => acpActivityReady);
      if (confirmed.some((receipt) => receipt.state === 'waiting')) status = 'waiting';
      else if (status !== 'working' && status !== 'waiting')
        status = confirmed.length ? 'working' : null;
    }
  }
  return status;
}

/** Where a failed child is in the lifecycle of its "failed child" notice on the parent. The notice
 * shows until the parent completes a turn that started after the failure, or the user opens the
 * child. `during-turn`: failed while the parent's turn ran. `idle`: waiting for the next turn.
 * `armed`: that turn is running. `cleared`: no notice. */
export type FailedChildPhase = 'during-turn' | 'idle' | 'armed' | 'cleared';
export type FailedChildNotices = Record<string, FailedChildPhase>;

function nativeFailedChildren(receipts: readonly SpawnReceipt[]): SpawnReceipt[] {
  return receipts.filter(
    (receipt) => receipt.receiptId.startsWith('native:') && receipt.state === 'failed',
  );
}

/** Moves each failed child's notice forward. `parentBusy` says whether the parent has a turn
 * running, and `opened` lists children the user opened. Returns `notices` itself when nothing
 * changed. */
export function advanceFailedChildNotices(
  notices: FailedChildNotices,
  receipts: readonly SpawnReceipt[],
  parentBusy: (sourceId: string, directory: string) => boolean,
  opened: ReadonlySet<string> = new Set(),
): FailedChildNotices {
  const next: FailedChildNotices = {};
  for (const receipt of nativeFailedChildren(receipts)) {
    const busy = parentBusy(receipt.sourceId, receipt.sourceDirectory);
    const previous = notices[receipt.receiptId];
    let phase: FailedChildPhase;
    if (previous === undefined) phase = busy ? 'during-turn' : 'idle';
    else if (previous === 'during-turn') phase = busy ? 'during-turn' : 'idle';
    else if (previous === 'idle') phase = busy ? 'armed' : 'idle';
    else if (previous === 'armed') phase = busy ? 'armed' : 'cleared';
    else phase = 'cleared';
    next[receipt.receiptId] = opened.has(receipt.receiptId) ? 'cleared' : phase;
  }
  // A cleared notice outlives its receipt, so a child that reappears does not notify again. A
  // child that left the failed state drops it, so failing again notifies again.
  const present = new Set(receipts.map((receipt) => receipt.receiptId));
  for (const [id, phase] of Object.entries(notices))
    if (phase === 'cleared' && !present.has(id)) next[id] ??= phase;
  const same =
    Object.keys(next).length === Object.keys(notices).length &&
    Object.entries(next).every(([id, phase]) => notices[id] === phase);
  return same ? notices : next;
}

export function failedChildCount(
  notices: FailedChildNotices,
  receipts: readonly SpawnReceipt[],
  sourceId: string,
  directory: string,
): number {
  return nativeFailedChildren(receipts).filter(
    (receipt) =>
      receipt.sourceId === sourceId &&
      receipt.sourceDirectory === directory &&
      (notices[receipt.receiptId] ?? 'idle') !== 'cleared',
  ).length;
}

export function failedChildLabel(count: number): string {
  return `${count} failed ${count === 1 ? 'child' : 'children'}`;
}

/** Failed children whose thread is the one the user has open. */
export function openedFailedChildren(
  receipts: readonly SpawnReceipt[],
  selected: { agent: string; sessionId: string; directory: string } | null,
): Set<string> {
  if (!selected) return new Set();
  const target = receiptSourceId(selected.agent, selected.sessionId);
  return new Set(
    nativeFailedChildren(receipts)
      .filter(
        (receipt) =>
          sameThreadId(receipt.targetId, target) && receipt.targetDirectory === selected.directory,
      )
      .map((receipt) => receipt.receiptId),
  );
}

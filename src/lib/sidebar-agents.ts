import type { AgentThread } from './acp';
import type { AttentionMap, ThreadStatus } from './attention';
import { threadKey } from './recent-threads.ts';
import {
  activeSubagentsForSource,
  receiptIsSettled,
  receiptSourceId,
  runningSubagentsForSource,
  type SpawnReceipt,
} from './agent-results.ts';

export type SidebarThreadRow = {
  thread: AgentThread;
  depth: number;
  hiddenHistoricalChildren: number;
  historicalChildren: number;
  historicalExpanded: boolean;
};

export type SidebarSessionSource = {
  session: {
    list: (input: {
      directory: string;
      limit: number;
      order: 'desc';
      parentID: null;
      cursor?: string;
    }) => Promise<{
      data: {
        id: string;
        parentID?: string;
        title?: string;
        location: { directory: string };
        time: { updated: number };
        outcome?: 'succeeded' | 'failed' | 'interrupted';
      }[];
      cursor: { next?: string | null };
    }>;
  };
};

function sidebarThreadIdentity(thread: AgentThread): string {
  return `${thread.directory}\0${receiptSourceId(thread.agent, thread.sessionId)}`;
}

function recentThreadFirst(left: AgentThread, right: AgentThread): number {
  return right.updated - left.updated;
}

export async function listSidebarOpenCodeThreads(
  source: SidebarSessionSource,
  path: string,
  cursor?: string,
  seen = new Set<string>(),
  threads: AgentThread[] = [],
  outcomes: Record<string, ThreadStatus> = {},
): Promise<{ threads: AgentThread[]; outcomes: Record<string, ThreadStatus> }> {
  const page = await source.session.list({
    directory: path,
    limit: 100,
    order: 'desc',
    parentID: null,
    ...(cursor ? { cursor } : {}),
  });
  for (const session of page.data) {
    if (session.location.directory !== path || session.parentID) continue;
    const thread: AgentThread = {
      agent: 'opencode',
      directory: path,
      sessionId: session.id,
      title: session.title ?? 'Untitled session',
      updated: session.time.updated,
    };
    threads.push(thread);
    if (session.outcome)
      outcomes[threadKey(thread)] = session.outcome === 'succeeded' ? 'done' : session.outcome;
  }
  const next = page.cursor.next ?? undefined;
  if (!next || next === cursor || seen.has(next)) return { threads, outcomes };
  seen.add(next);
  return listSidebarOpenCodeThreads(source, path, next, seen, threads, outcomes);
}

export function groupSidebarThreads(threads: AgentThread[]): Record<string, AgentThread[]> {
  const unique = new Map<string, AgentThread>();
  for (const thread of threads) {
    const key = threadKey(thread);
    const previous = unique.get(key);
    if (!previous || previous.updated < thread.updated) unique.set(key, thread);
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

export function sidebarThreadRows(
  threads: AgentThread[],
  receipts: SpawnReceipt[],
  expanded: string[] = [],
): SidebarThreadRow[] {
  const native = receipts.filter((receipt) => receipt.receiptId.startsWith('native:'));
  const byIdentity = new Map(threads.map((thread) => [sidebarThreadIdentity(thread), thread]));
  const receiptByChild = new Map<string, SpawnReceipt>(
    native.flatMap((receipt) =>
      receipt.targetId && receipt.targetDirectory
        ? [[`${receipt.targetDirectory}\0${receipt.targetId}`, receipt] as const]
        : [],
    ),
  );
  const children = new Map<string, AgentThread[]>();
  const roots: AgentThread[] = [];
  for (const thread of threads) {
    const receipt = receiptByChild.get(sidebarThreadIdentity(thread));
    const parent = receipt
      ? byIdentity.get(`${receipt.sourceDirectory}\0${receipt.sourceId}`)
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
      thread,
      depth,
      hiddenHistoricalChildren: nested.length - visible.length,
      historicalChildren,
      historicalExpanded,
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
  nativeActivityReady: boolean,
  nativeUnavailableDirectories: string[],
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
      receipt.targetId === receiptSourceId(thread.agent, thread.sessionId) &&
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
  if (
    (status === 'working' || status === 'waiting') &&
    (thread.agent === 'opencode'
      ? !nativeActivityReady || nativeUnavailableDirectories.includes(thread.directory)
      : !acpActivityReady)
  )
    status = null;
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
      ).filter((receipt) =>
        receipt.provider === 'opencode'
          ? nativeActivityReady &&
            !nativeUnavailableDirectories.includes(receipt.targetDirectory ?? '')
          : acpActivityReady,
      );
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
  // A cleared notice outlives its receipt, so a child that reappears does not notify again.
  for (const [id, phase] of Object.entries(notices)) if (phase === 'cleared') next[id] ??= phase;
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
        (receipt) => receipt.targetId === target && receipt.targetDirectory === selected.directory,
      )
      .map((receipt) => receipt.receiptId),
  );
}

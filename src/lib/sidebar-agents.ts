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
      outcomes[threadKey(thread)] = session.outcome === 'failed' ? 'failed' : 'done';
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
      return !receipt || !receiptIsSettled(receipt.state) || hasLiveDescendant(child, nextTrail);
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
      return !!receipt && receiptIsSettled(receipt.state) && !hasLiveDescendant(child);
    }).length;
    const visible = nested.filter((child) => {
      const receipt = receiptByChild.get(sidebarThreadIdentity(child));
      return (
        !receipt ||
        !receiptIsSettled(receipt.state) ||
        hasLiveDescendant(child) ||
        historicalExpanded
      );
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
  if (child) {
    status =
      child.state === 'working' || child.state === 'waiting'
        ? child.state
        : child.state === 'failed'
          ? 'failed'
          : child.state === 'completed' || child.state === 'interrupted'
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
  if (status !== 'failed') {
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

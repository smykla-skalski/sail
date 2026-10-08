import type { SessionInfo, SessionMessageInfo } from './opencode';
import { needsChildSummary } from './opencode-subagent-summary.ts';
import { mergeMessages } from './timeline.ts';

type Page<T> = { data: T[]; cursor: { next?: string | null } };

export type OpenCodeChildClient = {
  session: {
    list: (input: {
      parentID: string;
      limit: number;
      order: 'desc';
      cursor?: string;
    }) => Promise<Page<SessionInfo>>;
    active: () => Promise<Record<string, unknown>>;
  };
  message: {
    list: (input: {
      sessionID: string;
      limit: number;
      order: 'desc';
      type?: 'assistant';
      cursor?: string;
    }) => Promise<Page<SessionMessageInfo>>;
  };
};

export type OpenCodeChildren = {
  children: SessionInfo[];
  active: string[];
  summaries: Record<string, SessionMessageInfo>;
  histories: Record<string, SessionMessageInfo[]>;
  historyCursors: Record<string, string | null>;
  historyErrors: Record<string, string>;
  childCursor: string | null;
  loadingOlderChildren: boolean;
  loadingOlderHistory: string[];
  loadError: string;
};

export type OpenCodeChildView = {
  /** Loads the child's history now and keeps refreshing it while expanded. */
  expand: (id: string) => void;
  collapse: (id: string) => void;
  loadHistory: (id: string, cursor?: string) => Promise<void>;
  loadOlderChildren: () => Promise<void>;
  close: () => void;
};

type View = { listener: (state: OpenCodeChildren) => void; expanded: Set<string> };

type Parent = {
  client: OpenCodeChildClient;
  parentID: string;
  state: OpenCodeChildren;
  views: Set<View>;
  summaryUpdates: Map<string, number>;
  refreshing: boolean;
  closed: boolean;
  stop: () => void;
};

export function emptyOpenCodeChildren(): OpenCodeChildren {
  return {
    children: [],
    active: [],
    summaries: {},
    histories: {},
    historyCursors: {},
    historyErrors: {},
    childCursor: null,
    loadingOlderChildren: false,
    loadingOlderHistory: [],
    loadError: '',
  };
}

async function collectThroughOverlap<T extends { id: string }>(
  readPage: (cursor?: string) => Promise<Page<T>>,
  known: Set<string>,
  cursor?: string,
  singlePage = false,
  received: T[] = [],
  visited = new Set<string>(),
): Promise<{ data: T[]; next: string | null }> {
  const page = await readPage(cursor);
  const data = [...received, ...page.data];
  const next = page.cursor.next ?? null;
  if (
    singlePage ||
    !known.size ||
    !page.data.length ||
    page.data.some((item) => known.has(item.id)) ||
    !next ||
    visited.has(next)
  )
    return { data, next };
  visited.add(next);
  return collectThroughOverlap(readPage, known, next, false, data, visited);
}

function update(parent: Parent, changes: Partial<OpenCodeChildren>) {
  if (parent.closed) return;
  parent.state = { ...parent.state, ...changes };
  for (const view of parent.views) view.listener(parent.state);
}

async function loadSummaries(parent: Parent, sessions: SessionInfo[]) {
  const stale = sessions.filter((child) =>
    needsChildSummary(child, parent.state.active, parent.summaryUpdates),
  );
  if (!stale.length) return;
  const snapshots = await Promise.all(
    stale.map(async (child) => {
      const response = await parent.client.message.list({
        sessionID: child.id,
        limit: 1,
        order: 'desc',
        type: 'assistant',
      });
      return [child.id, child.time.updated, response.data[0]] as const;
    }),
  );
  if (parent.closed) return;
  const summaries = { ...parent.state.summaries };
  for (const [id, updated, message] of snapshots) {
    parent.summaryUpdates.set(id, updated);
    if (message) summaries[id] = message;
  }
  update(parent, { summaries });
}

async function loadHistory(parent: Parent, id: string, cursor?: string) {
  if (parent.closed || parent.state.loadingOlderHistory.includes(id)) return;
  update(parent, { loadingOlderHistory: [...parent.state.loadingOlderHistory, id] });
  try {
    const known = new Set((parent.state.histories[id] ?? []).map((message) => message.id));
    const page = await collectThroughOverlap(
      (next) =>
        parent.client.message.list({
          sessionID: id,
          limit: 25,
          order: 'desc',
          ...(next ? { cursor: next } : {}),
        }),
      known,
      cursor,
      !!cursor,
    );
    const { histories, historyCursors, historyErrors } = parent.state;
    const errors = { ...historyErrors };
    delete errors[id];
    update(parent, {
      histories: { ...histories, [id]: mergeMessages(histories[id] ?? [], page.data) },
      ...(cursor || !known.size || !(id in historyCursors)
        ? { historyCursors: { ...historyCursors, [id]: page.next } }
        : {}),
      historyErrors: errors,
    });
  } catch (cause) {
    update(parent, { historyErrors: { ...parent.state.historyErrors, [id]: String(cause) } });
  } finally {
    update(parent, {
      loadingOlderHistory: parent.state.loadingOlderHistory.filter((item) => item !== id),
    });
  }
}

async function loadOlderChildren(parent: Parent) {
  const cursor = parent.state.childCursor;
  if (parent.closed || !cursor || parent.state.loadingOlderChildren) return;
  update(parent, { loadingOlderChildren: true });
  try {
    const page = await parent.client.session.list({
      parentID: parent.parentID,
      limit: 50,
      order: 'desc',
      cursor,
    });
    if (parent.closed) return;
    const known = new Set(parent.state.children.map((child) => child.id));
    update(parent, {
      children: [...parent.state.children, ...page.data.filter((child) => !known.has(child.id))],
      childCursor: page.cursor.next === cursor ? null : (page.cursor.next ?? null),
    });
    await loadSummaries(parent, page.data);
    update(parent, { loadError: '' });
  } catch (cause) {
    update(parent, { loadError: String(cause) });
  } finally {
    update(parent, { loadingOlderChildren: false });
  }
}

async function refresh(parent: Parent) {
  if (parent.closed || parent.refreshing) return;
  parent.refreshing = true;
  try {
    const known = new Set(parent.state.children.map((child) => child.id));
    const [sessions, running] = await Promise.all([
      collectThroughOverlap(
        (cursor) =>
          parent.client.session.list({
            parentID: parent.parentID,
            limit: 50,
            order: 'desc',
            ...(cursor ? { cursor } : {}),
          }),
        known,
      ),
      parent.client.session.active(),
    ]);
    if (parent.closed) return;
    const fresh = new Set(sessions.data.map((child) => child.id));
    update(parent, {
      children: [
        ...sessions.data,
        ...parent.state.children.filter((child) => !fresh.has(child.id)),
      ],
      ...(known.size ? {} : { childCursor: sessions.next }),
      active: Object.keys(running),
    });
    const expanded = new Set<string>();
    for (const view of parent.views) for (const id of view.expanded) expanded.add(id);
    await Promise.all([
      loadSummaries(parent, sessions.data),
      ...[...expanded].map((id) => loadHistory(parent, id)),
    ]);
    update(parent, { loadError: '' });
  } catch (cause) {
    update(parent, { loadError: String(cause) });
  } finally {
    parent.refreshing = false;
  }
}

function every(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
}

/** Shares one OpenCode child poll per parent session between every view that shows it. */
export function createOpenCodeChildStore({
  interval = 3000,
  schedule = every,
}: { interval?: number; schedule?: (run: () => void, ms: number) => () => void } = {}) {
  const parents = new WeakMap<OpenCodeChildClient, Map<string, Parent>>();

  function open(client: OpenCodeChildClient, parentID: string): Parent {
    const byParent = parents.get(client) ?? new Map<string, Parent>();
    parents.set(client, byParent);
    const existing = byParent.get(parentID);
    if (existing) return existing;
    const parent: Parent = {
      client,
      parentID,
      state: emptyOpenCodeChildren(),
      views: new Set(),
      summaryUpdates: new Map(),
      refreshing: false,
      closed: false,
      stop: () => {},
    };
    byParent.set(parentID, parent);
    parent.stop = schedule(() => void refresh(parent), interval);
    return parent;
  }

  function close(parent: Parent) {
    parent.closed = true;
    parent.stop();
    const byParent = parents.get(parent.client);
    if (byParent?.get(parent.parentID) === parent) byParent.delete(parent.parentID);
  }

  return {
    watch(
      client: OpenCodeChildClient,
      parentID: string,
      listener: (state: OpenCodeChildren) => void,
    ): OpenCodeChildView {
      const parent = open(client, parentID);
      const view: View = { listener, expanded: new Set() };
      const first = parent.views.size === 0;
      parent.views.add(view);
      listener(parent.state);
      if (first) void refresh(parent);
      return {
        expand: (id) => {
          view.expanded.add(id);
          void loadHistory(parent, id);
        },
        collapse: (id) => void view.expanded.delete(id),
        loadHistory: (id, cursor) => loadHistory(parent, id, cursor),
        loadOlderChildren: () => loadOlderChildren(parent),
        close: () => {
          if (!parent.views.delete(view)) return;
          if (!parent.views.size) close(parent);
        },
      };
    },
  };
}

export const openCodeChildren = createOpenCodeChildStore();

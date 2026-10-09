import type { AgentId, AgentThread } from './acp';

export type Pane =
  | { id: string; agent: AgentId | null; thread: AgentThread | null; kind?: undefined }
  | { id: string; agent: null; thread: null; kind: 'terminal'; owner?: string }
  | { id: string; agent: null; thread: null; kind: 'agent-terminal'; terminalId: string }
  | {
      id: string;
      agent: null;
      thread: null;
      kind: 'browser';
      tabs: BrowserTab[];
      activeTab: string;
    }
  | { id: string; direction: 'row' | 'column'; ratio: number; first: Pane; second: Pane };

export type SideChat = {
  id: string;
  parentId: string;
  parentThreadId?: string;
  source: { kind: 'acp'; agent: AgentId; context: string };
};

export type BrowserTab = { id: string; history: string[]; index: number };

export function browserPopIndex(
  history: string[],
  current: number,
  url: string,
  direction: -1 | 1,
): number {
  const previous = history.slice(0, current).lastIndexOf(url);
  const next = history.findIndex((item, index) => index > current && item === url);
  return direction < 0 ? (previous >= 0 ? previous : next) : next >= 0 ? next : previous;
}

export function newBrowserTab(): BrowserTab {
  return { id: crypto.randomUUID(), history: [], index: -1 };
}

export const mainPane = (): Pane => ({ id: 'main', agent: null, thread: null });

export function terminalRuntimeId(directory: string, paneId: string): string {
  return paneId === 'main' ? `main:${encodeURIComponent(directory)}` : paneId;
}

export const minPaneSpan = 120;

export function paneRatioBounds(span: number): { min: number; max: number } {
  if (!Number.isFinite(span) || span <= 8) return { min: 0.5, max: 0.5 };
  if (span < 2 * minPaneSpan + 8) {
    const midpoint = (span - 8) / (2 * span);
    return { min: midpoint, max: midpoint };
  }
  return {
    min: Math.max(0.1, minPaneSpan / span),
    max: Math.min(0.9, (span - 8 - minPaneSpan) / span),
  };
}

export function clampPaneRatio(ratio: number, span: number): number {
  const { min, max } = paneRatioBounds(span);
  return Math.max(min, Math.min(max, ratio));
}

export type PaneBounds = {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function adjacentPaneId(
  panes: PaneBounds[],
  focused: string,
  direction: 'left' | 'right' | 'up' | 'down',
): string | null {
  const current = panes.find((pane) => pane.id === focused);
  if (!current) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const candidates = panes
    .filter((pane) => pane.id !== focused)
    .map((pane) => {
      const gap =
        direction === 'left'
          ? current.left - pane.right
          : direction === 'right'
            ? pane.left - current.right
            : direction === 'up'
              ? current.top - pane.bottom
              : pane.top - current.bottom;
      const overlap = horizontal
        ? Math.min(current.bottom, pane.bottom) - Math.max(current.top, pane.top)
        : Math.min(current.right, pane.right) - Math.max(current.left, pane.left);
      const centerDistance = horizontal
        ? Math.abs((current.top + current.bottom - pane.top - pane.bottom) / 2)
        : Math.abs((current.left + current.right - pane.left - pane.right) / 2);
      return { id: pane.id, gap, overlap, centerDistance };
    })
    .filter((pane) => pane.gap >= -1 && pane.overlap > 0)
    .toSorted((a, b) => a.gap - b.gap || a.centerDistance - b.centerDistance);
  return candidates[0]?.id ?? null;
}

export function leaves(pane: Pane): Extract<Pane, { agent: AgentId | null }>[] {
  return 'direction' in pane ? [...leaves(pane.first), ...leaves(pane.second)] : [pane];
}

export function splitPane(pane: Pane, id: string, direction: 'row' | 'column'): Pane {
  if ('direction' in pane)
    return {
      ...pane,
      first: splitPane(pane.first, id, direction),
      second: splitPane(pane.second, id, direction),
    };
  if (pane.id !== id) return pane;
  return {
    id: crypto.randomUUID(),
    direction,
    ratio: 0.5,
    first: pane,
    second: { id: crypto.randomUUID(), agent: null, thread: null },
  };
}

export function closePane(pane: Pane, id: string): Pane {
  if (!('direction' in pane)) return pane.id === id ? mainPane() : pane;
  if (leaves(pane.first).some((leaf) => leaf.id === id)) {
    if (!('direction' in pane.first) && pane.first.id === id) return pane.second;
    return { ...pane, first: closePane(pane.first, id) };
  }
  if (!('direction' in pane.second) && pane.second.id === id) return pane.first;
  return { ...pane, second: closePane(pane.second, id) };
}

export function updatePane(pane: Pane, id: string, update: Partial<Pane>): Pane {
  if ('direction' in pane) {
    if (pane.id === id && 'ratio' in update && typeof update.ratio === 'number')
      return { ...pane, ratio: update.ratio };
    return {
      ...pane,
      first: updatePane(pane.first, id, update),
      second: updatePane(pane.second, id, update),
    };
  }
  if (pane.id !== id) return pane;
  const next = { ...pane, ...update };
  return next.kind === 'terminal'
    ? {
        id: next.id,
        kind: 'terminal',
        agent: null,
        thread: null,
        ...(next.owner ? { owner: next.owner } : {}),
      }
    : next.kind === 'agent-terminal'
      ? {
          id: next.id,
          kind: 'agent-terminal',
          agent: null,
          thread: null,
          terminalId: next.terminalId ?? '',
        }
      : next.kind === 'browser'
        ? {
            id: next.id,
            kind: 'browser',
            agent: null,
            thread: null,
            tabs: next.tabs ?? [],
            activeTab: next.activeTab ?? '',
          }
        : { id: next.id, agent: next.agent ?? null, thread: next.thread ?? null };
}

export function migratePaneDirectory(pane: Pane, from: string, to: string): Pane {
  if ('direction' in pane)
    return {
      ...pane,
      first: migratePaneDirectory(pane.first, from, to),
      second: migratePaneDirectory(pane.second, from, to),
    };
  if (pane.kind === 'terminal' || pane.kind === 'agent-terminal' || pane.kind === 'browser')
    return pane;
  return pane.thread?.directory === from
    ? { ...pane, thread: { ...pane.thread, directory: to } }
    : pane;
}

export function loadPaneLayouts(raw: string | null): Record<string, Pane> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, Pane] =>
          typeof entry[0] === 'string' && validPane(entry[1], new Set<string>()),
      ),
    );
  } catch {
    return {};
  }
}

function validPane(value: unknown, ids: Set<string>): value is Pane {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pane: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (typeof pane.id !== 'string' || !pane.id || ids.has(pane.id)) return false;
  ids.add(pane.id);
  if ('direction' in pane)
    return (
      (pane.direction === 'row' || pane.direction === 'column') &&
      typeof pane.ratio === 'number' &&
      Number.isFinite(pane.ratio) &&
      pane.ratio >= 0.1 &&
      pane.ratio <= 0.9 &&
      validPane(pane.first, ids) &&
      validPane(pane.second, ids)
    );
  if (pane.kind === 'terminal') return pane.agent === null && pane.thread === null;
  if (pane.kind === 'agent-terminal')
    return (
      pane.id !== 'main' &&
      pane.agent === null &&
      pane.thread === null &&
      typeof pane.terminalId === 'string' &&
      pane.terminalId.length > 0
    );
  if (pane.kind === 'browser')
    return (
      pane.agent === null &&
      pane.thread === null &&
      Array.isArray(pane.tabs) &&
      pane.tabs.length > 0 &&
      pane.tabs.length <= 30 &&
      new Set(pane.tabs.map((tab) => tab?.id)).size === pane.tabs.length &&
      pane.tabs.every(
        (tab) =>
          tab &&
          typeof tab === 'object' &&
          typeof tab.id === 'string' &&
          tab.id.length > 0 &&
          Array.isArray(tab.history) &&
          tab.history.length <= 100 &&
          tab.history.every((url: unknown) => validBrowserUrl(url)) &&
          typeof tab.index === 'number' &&
          Number.isInteger(tab.index) &&
          tab.index >= (tab.history.length ? 0 : -1) &&
          tab.index < tab.history.length,
      ) &&
      typeof pane.activeTab === 'string' &&
      pane.tabs.some((tab) => tab.id === pane.activeTab)
    );
  return (
    pane.kind === undefined &&
    (pane.agent === null || typeof pane.agent === 'string') &&
    (pane.thread === null ||
      (typeof pane.thread === 'object' &&
        pane.thread !== null &&
        'sessionId' in pane.thread &&
        typeof pane.thread.sessionId === 'string'))
  );
}

function validBrowserUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

import { patchUnavailableReason, type WorkingDiffInfo } from './diff.ts';
import { leaves, updatePane, type Pane } from './panes.ts';
import type { PostTurnCheck } from './post-turn-checks.ts';

export type ReviewCapture = {
  id: string;
  paneId: string;
  phase: 'before' | 'after';
  source: string;
  url: string;
  previewUrl: string;
  created: number;
};

export type ReviewPreview = {
  id: string;
  paneId: string;
  tabId: string;
  url: string;
};

export type ReviewFile = {
  path: string;
  added: number;
  removed: number;
  state: 'available' | 'binary' | 'large' | 'metadata';
};

export type ReviewCheckGroup = {
  turn: string;
  updated: number;
  checks: PostTurnCheck[];
};

export function reviewFiles(files: WorkingDiffInfo[]): ReviewFile[] {
  return files.map((file) => {
    const reason = patchUnavailableReason(file.patch);
    return {
      path: file.file,
      added: file.additions,
      removed: file.deletions,
      state:
        reason === 'binary'
          ? 'binary'
          : reason === 'large'
            ? 'large'
            : reason === 'empty'
              ? 'metadata'
              : 'available',
    };
  });
}

export function groupReviewChecks(checks: PostTurnCheck[]): ReviewCheckGroup[] {
  const groups = new Map<string, PostTurnCheck[]>();
  for (const check of checks) groups.set(check.turn, [...(groups.get(check.turn) ?? []), check]);
  return [...groups.entries()]
    .map(([turn, items]) => ({
      turn,
      updated: Math.max(...items.map((item) => item.updated)),
      checks: items.toSorted((left, right) => left.command.localeCompare(right.command)),
    }))
    .toSorted((left, right) => right.updated - left.updated || left.turn.localeCompare(right.turn));
}

export function evidenceFreshness(updated: number, now = Date.now()): 'current' | 'stale' {
  return now - updated <= 5 * 60_000 ? 'current' : 'stale';
}

export function browserReviewPreviews(pane: Pane): ReviewPreview[] {
  return leaves(pane).flatMap((leaf) =>
    leaf.kind === 'browser'
      ? leaf.tabs.flatMap((tab) => {
          const url = tab.history[tab.index];
          return url ? [{ id: `${leaf.id}:${tab.id}`, paneId: leaf.id, tabId: tab.id, url }] : [];
        })
      : [],
  );
}

export function selectReviewPreview(pane: Pane, preview: ReviewPreview): Pane | null {
  const browser = leaves(pane).find((leaf) => leaf.id === preview.paneId);
  if (browser?.kind !== 'browser' || !browser.tabs.some((tab) => tab.id === preview.tabId))
    return null;
  return updatePane(pane, browser.id, { activeTab: preview.tabId });
}

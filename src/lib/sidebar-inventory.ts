import type { AgentThread } from './acp.ts';

export function createSidebarThreadLoader(
  available: (path: string) => Promise<boolean>,
  list: (path: string) => Promise<AgentThread[]>,
): (path: string) => Promise<AgentThread[]> {
  const pending = new Map<string, Promise<AgentThread[]>>();
  return (path) => {
    const existing = pending.get(path);
    if (existing) return existing;
    const request = (async () => {
      if (!(await available(path))) return [];
      try {
        return await list(path);
      } catch (error) {
        if (!(await available(path))) return [];
        throw error;
      }
    })();
    pending.set(path, request);
    void request.finally(() => pending.delete(path)).catch(() => undefined);
    return request;
  };
}

/** Gaining focus refreshes the sidebar only when the last listing is older than this. */
export const SIDEBAR_FOCUS_REFRESH_MIN_AGE_MS = 30_000;

export function sidebarFocusRefreshDue(
  lastListing: number,
  now: number,
  minAge = SIDEBAR_FOCUS_REFRESH_MIN_AGE_MS,
): boolean {
  return now - lastListing >= minAge;
}

/**
 * Whether a window event should refresh the sidebar. A window that turns visible without focus
 * (uncovered by another window, shown on another Space) is no sign the user came back, and an
 * unattended Sail would otherwise list every directory each time that happens.
 */
export function sidebarRefreshOnWindowEvent(
  type: string,
  visibility: DocumentVisibilityState,
  focused: boolean,
): boolean {
  if (visibility === 'hidden') return false;
  return type === 'focus' || focused;
}

/** Directories queued for the next listing; `null` means every sidebar directory. */
export type SidebarRefreshPaths = ReadonlySet<string> | null;

/**
 * Folds a refresh request into the one already waiting. A request without paths keeps what is
 * waiting, or lists everything when nothing is.
 */
export function mergeSidebarRefreshPaths(
  waiting: SidebarRefreshPaths | undefined,
  request: readonly string[] | 'all' | undefined,
): SidebarRefreshPaths {
  if (request === 'all') return null;
  if (request === undefined) return waiting === undefined ? null : waiting;
  if (waiting === null) return null;
  return new Set([...(waiting ?? []), ...request]);
}

export function unlistedSidebarPaths(
  directories: readonly string[],
  listed: Readonly<Record<string, unknown>>,
): string[] {
  return directories.filter((path) => !Object.hasOwn(listed, path));
}

/**
 * Tracks when every sidebar directory was last listed, so a focus event does not relist what a
 * startup or catalog listing already covered.
 */
export function createSidebarListingClock() {
  let lastFullListing = Number.NEGATIVE_INFINITY;
  return {
    /** Directories to list now; a request covering the whole catalog restarts the focus clock. */
    plan(
      directories: readonly string[],
      wanted: SidebarRefreshPaths | undefined,
      now: number,
      outside: ReadonlySet<string> = new Set(),
    ): string[] {
      // An empty request has nothing to narrow it, so it lists the whole catalog.
      if (!wanted || wanted.size === 0) {
        lastFullListing = now;
        return [...directories];
      }
      if (directories.length > 0 && directories.every((path) => wanted.has(path)))
        lastFullListing = now;
      // A directory outside the catalog gets its own listing only when a thread asked for it; a
      // directory that left the catalog while queued is dropped.
      return [...wanted].filter((path) => directories.includes(path) || outside.has(path));
    },
    focusRefreshDue(now: number): boolean {
      return sidebarFocusRefreshDue(lastFullListing, now);
    },
    /** Milliseconds until a focus refresh becomes due. */
    focusRefreshDelay(now: number): number {
      return SIDEBAR_FOCUS_REFRESH_MIN_AGE_MS - (now - lastFullListing);
    },
  };
}

/** Tells which listing pass owns each directory, so overlapping passes never overwrite newer data. */
export function createSidebarPassOwnership() {
  let generation = 0;
  const newest = new Map<string, number>();
  return {
    begin(paths: readonly string[]): number {
      generation += 1;
      for (const path of paths) newest.set(path, generation);
      return generation;
    },
    /** Directories of a finished pass that no newer pass has listed since. */
    owned(paths: readonly string[], pass: number): string[] {
      return paths.filter((path) => newest.get(path) === pass);
    },
  };
}

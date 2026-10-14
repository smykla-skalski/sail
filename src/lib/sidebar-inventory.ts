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
  listed: ReadonlySet<string>,
): string[] {
  return directories.filter((path) => !listed.has(path));
}

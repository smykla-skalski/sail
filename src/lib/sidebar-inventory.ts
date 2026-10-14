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

import type { AgentThread } from './acp.ts';
import type { AgentUsage, RateWindow } from './agent-usage.ts';
import type { AttentionMap, ThreadStatus } from './attention.ts';
import { locationName } from './command-palette.ts';
import { threadKey } from './recent-threads.ts';

export type AgentStatusItem = {
  key: string;
  agent: string;
  agentName: string;
  title: string;
  location: string;
  status: ThreadStatus;
  unread: boolean;
  context?: number;
  rates: RateWindow[];
  updated: number;
};

export type AgentStatusInput = {
  threads: AgentThread[];
  statuses: Record<string, ThreadStatus | null>;
  attention: AttentionMap;
  agentNames: Record<string, string>;
  usage: Record<string, AgentUsage>;
  openCodeUsage: Record<string, number>;
  rates: Record<string, RateWindow[]>;
};

const priority: Record<ThreadStatus, number> = {
  waiting: 0,
  working: 1,
  failed: 2,
  interrupted: 2,
  done: 3,
};

export function buildAgentStatusItems(input: AgentStatusInput): AgentStatusItem[] {
  const unique = new Map<string, AgentThread>();
  for (const thread of input.threads) {
    const key = threadKey(thread);
    const previous = unique.get(key);
    if (!previous || previous.updated < thread.updated) unique.set(key, thread);
  }
  return [...unique.entries()]
    .flatMap(([key, thread]) => {
      const status = input.statuses[key];
      const unread = input.attention[key]?.unread ?? false;
      if (!status || (!['working', 'waiting'].includes(status) && !unread)) return [];
      const context =
        thread.agent === 'opencode'
          ? input.openCodeUsage[`${thread.directory}:${thread.sessionId}`]
          : input.usage[key]?.context;
      return [
        {
          key,
          agent: thread.agent,
          agentName: input.agentNames[thread.agent] ?? thread.agent,
          title: thread.title,
          location: locationName(thread.directory),
          status,
          unread,
          ...(context === undefined ? {} : { context }),
          rates: input.rates[thread.agent] ?? [],
          updated: thread.updated,
        },
      ];
    })
    .toSorted((a, b) => priority[a.status] - priority[b.status] || b.updated - a.updated);
}

export function agentStatusCounts(items: AgentStatusItem[]) {
  return {
    working: items.filter((item) => item.status === 'working').length,
    waiting: items.filter((item) => item.status === 'waiting').length,
    ready: items.filter(
      (item) => item.unread && item.status !== 'working' && item.status !== 'waiting',
    ).length,
  };
}

export function resetLabel(resetsAt: number | undefined, now = Date.now()): string | null {
  if (resetsAt === undefined || resetsAt <= now) return null;
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

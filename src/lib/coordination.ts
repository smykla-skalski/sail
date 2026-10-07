import type { AgentThread } from './acp';
import type { AttentionMap, ThreadStatus } from './attention';
import type { ProjectCatalog } from './projects';
import { threadKey } from './recent-threads.ts';

export type RegisteredWorktree = { path: string; branch: string | null; present: boolean };
export type WorktreeInfo = {
  repository: string;
  path: string;
  branch: string | null;
  statusComment: string | null;
  stale: boolean;
  threadCount: number;
  threadStatuses: Record<ThreadStatus | 'unknown', number>;
};

export function projectWorktreeInfo(
  catalog: ProjectCatalog,
  project: string,
  registered: RegisteredWorktree[],
  threads: AgentThread[],
  attention: AttentionMap,
): WorktreeInfo[] {
  if (!catalog.repositories.includes(project)) return [];
  const live = new Map(registered.map((worktree) => [worktree.path, worktree]));
  return [
    { path: project, branch: '', statusComment: undefined },
    ...(catalog.worktrees[project] ?? []),
  ].map((worktree) => {
    const known = threads.filter((thread) => thread.directory === worktree.path);
    const threadStatuses: WorktreeInfo['threadStatuses'] = {
      working: 0,
      waiting: 0,
      done: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    };
    for (const thread of known) threadStatuses[attention[threadKey(thread)]?.status ?? 'unknown']++;
    const registeredWorktree = live.get(worktree.path);
    return {
      repository: project,
      path: worktree.path,
      branch: registeredWorktree ? registeredWorktree.branch : (worktree.branch ?? null),
      statusComment: worktree.statusComment ?? null,
      stale: !registeredWorktree?.present,
      threadCount: known.length,
      threadStatuses,
    };
  });
}

export type CoordinationMessage = {
  id: string;
  target: string;
  sender: string;
  text: string;
  created: number;
  delivered?: boolean;
};

export function coordinationKey(directory: string, threadId: string): string {
  return `${directory}\0${threadId}`;
}

export function coordinationPrompt(message: CoordinationMessage): string {
  return `Message ${message.id} from ${message.sender}:\n\n${message.text}`;
}

export function coordinationMessageForText(
  text: string,
  messages: CoordinationMessage[],
): CoordinationMessage | undefined {
  return messages.find((message) => text.includes(coordinationPrompt(message)));
}

export function enqueueCoordinationMessage(
  existing: CoordinationMessage[],
  message: CoordinationMessage,
  limit = 500,
): CoordinationMessage[] {
  const retained = [...existing];
  while (retained.length >= limit) {
    const delivered = retained.findIndex((item) => item.delivered);
    if (delivered < 0) throw new Error('Agent message queue is full.');
    retained.splice(delivered, 1);
  }
  return [...retained, message];
}

export function loadCoordinationMessages(raw: string | null): CoordinationMessage[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is CoordinationMessage =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.target === 'string' &&
        typeof item.sender === 'string' &&
        typeof item.text === 'string' &&
        typeof item.created === 'number' &&
        (item.delivered === undefined || typeof item.delivered === 'boolean'),
    );
  } catch {
    return [];
  }
}

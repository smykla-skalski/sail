import type { ThreadStatus } from './attention.ts';
import type { AgentActivity, AgentThread } from './acp.ts';
import { threadKey } from './recent-threads.ts';
import type { TaskSnapshot } from './session-tasks.ts';

export type AgentFocusDisplay = {
  text: string;
  source: 'Agent report' | 'Observed status';
  reportedAt: number | null;
};

const observed: Record<ThreadStatus, string> = {
  working: 'Working — no focus reported',
  waiting: 'Waiting for input',
  done: 'Turn completed',
  failed: 'Turn failed',
  interrupted: 'Turn interrupted',
};

export function agentFocusDisplay(
  snapshot: TaskSnapshot | null | undefined,
  status: ThreadStatus | null,
  activeTurnId: string | null = snapshot?.turnId ?? null,
): AgentFocusDisplay | null {
  if (!status) return null;
  const task =
    status === 'working' && snapshot?.turnId && snapshot.turnId === activeTurnId
      ? snapshot.tasks.find(
          (item) =>
            item.id === snapshot.focus &&
            item.origin === 'agent' &&
            item.turnId === activeTurnId &&
            item.status === 'in_progress',
        )
      : null;
  return task
    ? { text: task.title, source: 'Agent report', reportedAt: snapshot?.reportedAt ?? null }
    : { text: observed[status], source: 'Observed status', reportedAt: null };
}

export function restoredFocusActiveTurns(
  threads: AgentThread[],
  activity: Record<string, AgentActivity>,
): Record<string, string> {
  return Object.fromEntries(
    threads.flatMap((thread) => {
      const turn =
        activity[JSON.stringify([thread.directory, thread.agent])]?.activeTurns[thread.sessionId];
      return turn ? [[threadKey(thread), turn]] : [];
    }),
  );
}

export function focusReportTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(at);
}

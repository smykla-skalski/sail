import { z } from 'zod';
import { getSetting, commitSetting } from './settings.ts';

export const TASK_TOOLS = { read: 'sail_tasks_read', report: 'sail_tasks_report' } as const;
export type TaskScope = { agent: string; directory: string; sessionId: string };
export const taskScopeKey = (scope: TaskScope) =>
  JSON.stringify([scope.agent, scope.directory, scope.sessionId]);
const TaskStatus = z.enum(['pending', 'in_progress', 'done', 'blocked', 'skipped']);
const TaskInput = z.strictObject({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  status: TaskStatus,
});
const TaskSchema = TaskInput.extend({
  origin: z.enum(['sail', 'agent']),
  turnId: z.string(),
});
export type SessionTask = z.infer<typeof TaskSchema>;
const SnapshotSchema = z.strictObject({
  turnId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  tasks: z.array(TaskSchema).max(200),
  focus: z.string().nullable(),
  reportedAt: z.number().finite().nonnegative().nullable().optional(),
  reporting: z
    .object({
      turnId: z.string(),
      state: z.enum(['awaiting', 'correcting', 'reported', 'missing', 'interrupted', 'failed']),
      correctionRequested: z.boolean(),
    })
    .optional(),
});
export type TaskSnapshot = z.infer<typeof SnapshotSchema>;
const SavedSchema = z.object({
  scope: z.object({ agent: z.string(), directory: z.string(), sessionId: z.string() }),
  snapshot: SnapshotSchema,
  updated: z.number(),
});
const ReportSchema = z.strictObject({
  turnId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  tasks: z.array(TaskInput).max(100),
  focus: z.string().nullable(),
});
type Saved = z.infer<typeof SavedSchema>;
export interface TaskStorage {
  read(): string | null;
  write(value: string): Promise<void>;
}
const empty = (): TaskSnapshot => ({
  turnId: null,
  revision: 0,
  tasks: [],
  focus: null,
  reportedAt: null,
});
const storageKey = 'sai-session-tasks';
type TurnOutcome = 'done' | 'interrupted' | 'failed';
type FinishedTurn = { turnId: string; status: TurnOutcome };

function settledReporting(snapshot: TaskSnapshot, outcome: TurnOutcome) {
  return (
    snapshot.reporting && {
      ...snapshot.reporting,
      state:
        snapshot.reporting.state === 'reported'
          ? ('reported' as const)
          : snapshot.reporting.correctionRequested || outcome === 'done'
            ? ('missing' as const)
            : outcome,
    }
  );
}

export function createTaskStore(storage: TaskStorage, clock = Date.now) {
  let sessions = new Map<string, Saved>();
  try {
    const parsed: unknown = JSON.parse(storage.read() ?? '[]');
    if (Array.isArray(parsed))
      for (const item of parsed.slice(0, 100)) {
        const saved = SavedSchema.safeParse(item);
        if (saved.success) sessions.set(taskScopeKey(saved.data.scope), saved.data);
      }
  } catch {
    sessions.clear();
  }
  let writes = Promise.resolve();
  const listeners = new Set<(scope: TaskScope) => void>();
  const localTurns = new Map<string, string>();
  const snapshot = (scope: TaskScope): TaskSnapshot =>
    structuredClone(sessions.get(taskScopeKey(scope))?.snapshot ?? empty());

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = writes.catch(() => undefined).then(operation);
    writes = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function commit(scope: TaskScope, value: TaskSnapshot | null): Promise<TaskSnapshot> {
    const next = new Map(sessions);
    const key = taskScopeKey(scope);
    if (value) next.set(key, { scope, snapshot: value, updated: clock() });
    else next.delete(key);
    let retained = [...next.values()].toSorted((a, b) => b.updated - a.updated);
    while (retained.length > 100 || JSON.stringify(retained).length > 500_000) {
      const index = retained.findLastIndex(
        (item) => !item.snapshot.turnId && taskScopeKey(item.scope) !== key,
      );
      if (index < 0) throw new Error('Task storage is full with active sessions.');
      retained = retained.filter((_, at) => at !== index);
    }
    await storage.write(JSON.stringify(retained));
    sessions = new Map(retained.map((item) => [taskScopeKey(item.scope), item]));
    for (const listener of listeners) listener(scope);
    return snapshot(scope);
  }

  return {
    snapshot,
    scopes: (): TaskScope[] => [...sessions.values()].map((item) => structuredClone(item.scope)),
    reconcile(
      scope: TaskScope,
      activeTurnId: string | null,
      expectedRevision = snapshot(scope).revision,
      finished?: FinishedTurn,
    ) {
      const observed = snapshot(scope);
      return serialize(async () => {
        const before = snapshot(scope);
        if (
          !observed.turnId ||
          localTurns.get(taskScopeKey(scope)) === before.turnId ||
          before.revision !== expectedRevision ||
          before.turnId === activeTurnId
        )
          return before;
        return commit(scope, {
          ...before,
          turnId: null,
          focus: null,
          reportedAt: null,
          revision: before.revision + 1,
          reporting: settledReporting(
            before,
            finished?.turnId === before.turnId ? finished.status : 'interrupted',
          ),
        });
      });
    },
    start(scope: TaskScope, turnId: string) {
      return serialize(async () => {
        const before = snapshot(scope);
        if (before.turnId === turnId) {
          localTurns.set(taskScopeKey(scope), turnId);
          if (before.reporting) return before;
          return commit(scope, {
            ...before,
            revision: before.revision + 1,
            reporting: {
              turnId,
              state: before.tasks.some(
                (task) =>
                  task.turnId === turnId && (task.origin === 'agent' || task.status === 'done'),
              )
                ? 'reported'
                : 'awaiting',
              correctionRequested: false,
            },
          });
        }
        if (before.turnId) throw new Error('This session already has an active task turn.');
        const task: SessionTask = {
          id: `sail:${turnId}`,
          title: 'Starting task — waiting for agent report',
          status: 'in_progress',
          origin: 'sail',
          turnId,
        };
        const started = await commit(scope, {
          turnId,
          revision: before.revision + 1,
          tasks: [...before.tasks.filter((item) => item.id !== task.id).slice(-199), task],
          focus: task.id,
          reportedAt: null,
          reporting: {
            turnId,
            state: 'awaiting',
            correctionRequested:
              before.reporting?.turnId === turnId && before.reporting.correctionRequested,
          },
        });
        localTurns.set(taskScopeKey(scope), turnId);
        return started;
      });
    },
    report(scope: TaskScope, input: unknown) {
      return serialize(async () => {
        const parsed = ReportSchema.safeParse(input);
        if (!parsed.success) throw new Error(`Invalid task report: ${parsed.error.message}`);
        const report = parsed.data;
        const before = snapshot(scope);
        if (before.turnId !== report.turnId)
          throw new Error('Task report belongs to an inactive or different turn.');
        if (before.revision !== report.expectedRevision)
          throw new Error('Stale task revision; read tasks and retry.');
        const ids = report.tasks.map((task) => task.id);
        if (new Set(ids).size !== ids.length || ids.some((id) => id.startsWith('sail:')))
          throw new Error('Task IDs must be unique and must not use the Sail prefix.');
        const tasks = before.tasks.map((task) =>
          task.origin === 'sail' && task.turnId === report.turnId
            ? { ...task, status: 'done' as const }
            : task,
        );
        for (const inputTask of report.tasks) {
          const index = tasks.findIndex((task) => task.id === inputTask.id);
          const task: SessionTask = { ...inputTask, origin: 'agent', turnId: report.turnId };
          if (index < 0) tasks.push(task);
          else tasks[index] = task;
        }
        if (
          report.focus !== null &&
          !tasks.some(
            (task) =>
              task.id === report.focus &&
              task.turnId === report.turnId &&
              task.status === 'in_progress',
          )
        )
          throw new Error('Focus must reference an in-progress task in this turn.');
        const current = tasks.filter((task) => task.turnId === report.turnId);
        if (current.length > 200) throw new Error('A turn supports at most 200 tasks.');
        const history = tasks
          .filter((task) => task.turnId !== report.turnId)
          .slice(current.length === 200 ? tasks.length : -(200 - current.length));
        return commit(scope, {
          ...before,
          revision: before.revision + 1,
          tasks: [...history, ...current],
          focus: report.focus,
          reportedAt: clock(),
          reporting: {
            turnId: report.turnId,
            state: 'reported',
            correctionRequested: before.reporting?.correctionRequested ?? false,
          },
        });
      });
    },
    requestCorrection(scope: TaskScope, turnId: string) {
      return serialize(async () => {
        const before = snapshot(scope);
        if (
          before.turnId !== turnId ||
          before.reporting?.state !== 'awaiting' ||
          before.reporting.correctionRequested
        )
          return false;
        await commit(scope, {
          ...before,
          revision: before.revision + 1,
          reporting: { turnId, state: 'correcting', correctionRequested: true },
        });
        return true;
      });
    },
    finish(scope: TaskScope, turnId: string, outcome: TurnOutcome = 'done') {
      return serialize(async () => {
        const before = snapshot(scope);
        if (before.turnId !== turnId) return before;
        localTurns.delete(taskScopeKey(scope));
        return commit(scope, {
          ...before,
          turnId: null,
          focus: null,
          reportedAt: null,
          revision: before.revision + 1,
          reporting: settledReporting(before, outcome),
        });
      });
    },
    forget(scope: TaskScope) {
      return serialize(() => {
        localTurns.delete(taskScopeKey(scope));
        return commit(scope, null);
      });
    },
    subscribe(listener: (scope: TaskScope) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type TaskStore = ReturnType<typeof createTaskStore>;
let shared: TaskStore | undefined;
export function sessionTasks(): TaskStore {
  shared ??= createTaskStore({
    read: () => getSetting(storageKey),
    write: (value) => commitSetting(storageKey, value),
  });
  return shared;
}

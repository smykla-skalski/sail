import { z } from 'zod';

export const checkpointPhases = [
  'resolve',
  'orchestrate',
  'explore',
  'branch',
  'implement',
  'publish',
  'review',
  'test',
  'pr',
  'complete',
] as const;

export const checkpointStatuses = [
  'active',
  'blocked',
  'completed',
  'cancelled',
  'failed',
] as const;

const terminalCheckpointStatuses = new Set<string>(['completed', 'cancelled', 'failed']);

const taskCheckpointObjectSchema = z.object({
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  source: z.string().min(1),
  objective: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  phase: z.enum(checkpointPhases),
  status: z.enum(checkpointStatuses),
  revision: z.string().min(1).nullable(),
  requiredGates: z.array(z.string().min(1)),
  blocker: z.string().min(1).nullable(),
  unresolvedQuestions: z.array(z.string().min(1)),
  nextAction: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const taskCheckpointSchema = taskCheckpointObjectSchema.superRefine(
  (checkpoint, context) => {
    if ((checkpoint.status === 'blocked') !== (checkpoint.blocker !== null))
      context.addIssue({ code: 'custom', message: 'Only blocked checkpoints have a blocker.' });
    const complete = checkpoint.phase === 'complete';
    if (
      (complete && !terminalCheckpointStatuses.has(checkpoint.status)) ||
      (checkpoint.status === 'completed' && !complete)
    )
      context.addIssue({
        code: 'custom',
        message: 'Completed status and complete phase must occur together.',
      });
    if (checkpoint.updatedAt < checkpoint.createdAt)
      context.addIssue({ code: 'custom', message: 'Checkpoint time cannot move backwards.' });
  },
);

export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;

const checkpointPatchSchema = taskCheckpointObjectSchema
  .omit({
    schemaVersion: true,
    sequence: true,
    taskId: true,
    source: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
  })
  .partial()
  .strict();

export type CheckpointTask = { id: string; url: string; title: string };

export function initialTaskCheckpoint(task: CheckpointTask, now: number): TaskCheckpoint {
  return {
    schemaVersion: 1,
    sequence: 0,
    taskId: task.id,
    source: task.url,
    objective: task.title,
    acceptanceCriteria: [`Satisfy the acceptance criteria in ${task.url}.`],
    phase: 'resolve',
    status: 'active',
    revision: null,
    requiredGates: ['code-adversary', 'findings-adversary', 'test-adversary'],
    blocker: null,
    unresolvedQuestions: [],
    nextAction: 'Resolve the task source and confirm its acceptance criteria.',
    createdAt: now,
    updatedAt: now,
  };
}

export function updateTaskCheckpoint(
  checkpoint: TaskCheckpoint,
  patch: unknown,
  now: number,
): TaskCheckpoint {
  const changes = checkpointPatchSchema.parse(patch);
  return taskCheckpointSchema.parse({
    ...checkpoint,
    ...changes,
    sequence: checkpoint.sequence + 1,
    updatedAt: now,
  });
}

export function prepareTaskCheckpointUpdate(
  checkpoint: TaskCheckpoint,
  patch: unknown,
  currentRevision: string,
  expectedSequence: unknown,
  expectedRevision: unknown,
  rebindRevision: unknown,
  now: number,
): TaskCheckpoint {
  if (expectedSequence !== checkpoint.sequence)
    throw new Error('Checkpoint changed after it was read. Read it again before updating.');
  if (expectedRevision !== checkpoint.revision)
    throw new Error(
      'Checkpoint revision changed after it was read. Read it again before updating.',
    );
  if (checkpoint.revision !== currentRevision && rebindRevision !== true)
    throw new Error(
      'Worktree revision differs from the checkpoint. Inspect it and explicitly rebind before updating.',
    );
  return updateTaskCheckpoint({ ...checkpoint, revision: currentRevision }, patch, now);
}

export function reconcileTaskCheckpoint(
  checkpoint: TaskCheckpoint,
  currentRevision: string,
  external: {
    issueState?: string;
    pullRequest?: string | null;
    deliveryState: string;
    refreshError?: string | null;
  },
) {
  const revisionMatches = checkpoint.revision === currentRevision;
  const githubKnown =
    !external.refreshError && (external.issueState === 'OPEN' || external.issueState === 'CLOSED');
  const deliveryMatches =
    checkpoint.status === 'completed'
      ? external.deliveryState === 'merged' && external.issueState === 'CLOSED'
      : external.deliveryState !== 'merged' && external.issueState === 'OPEN';
  return {
    currentRevision,
    recordedRevision: checkpoint.revision,
    revisionMatches,
    issueState: external.issueState ?? 'UNKNOWN',
    pullRequest: external.pullRequest ?? null,
    deliveryState: external.deliveryState,
    resumable:
      revisionMatches &&
      githubKnown &&
      deliveryMatches &&
      checkpoint.status !== 'blocked' &&
      checkpoint.status !== 'cancelled' &&
      checkpoint.status !== 'failed',
    reason:
      checkpoint.revision === null
        ? 'The checkpoint has no revision baseline. Inspect the worktree and bind an update before resuming.'
        : !revisionMatches
          ? 'The worktree revision differs from the checkpoint. Inspect changes before resuming.'
          : external.refreshError
            ? `GitHub reconciliation failed: ${external.refreshError}`
            : !githubKnown
              ? 'GitHub issue state is unknown. Refresh it before resuming.'
              : !deliveryMatches
                ? 'The checkpoint no longer matches GitHub delivery state.'
                : checkpoint.status === 'blocked'
                  ? checkpoint.blocker
                  : checkpoint.status === 'cancelled' || checkpoint.status === 'failed'
                    ? `The checkpoint was ${checkpoint.status}. Retry the issue to resume it.`
                    : null,
  };
}

import type { PublishedGraph } from './issue-graph';
import type { RegisteredWorktree } from './coordination';
import type { SpawnState } from './agent-results';
import type { AgentActivity, InterruptedAgentTurn } from './acp';
import type { ShipEvent, ShipGate, ShipCheck } from './ship-progress';
import { initialTaskCheckpoint, type TaskCheckpoint } from './task-checkpoint.ts';
import type { ContextHandoff, ContextProvider } from './context-handoff.ts';
import type { EvidenceManifest } from './task-evidence.ts';
import type { ShipValidationPolicy } from './ship-risk-policy.ts';

export type ShipIssueState =
  'pending' | 'starting' | 'working' | 'awaiting_merge' | 'failed' | 'merged';

export interface ShippingClaim {
  id: string;
  instanceId?: string;
  holder: string;
  task: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  status: 'active' | 'released';
  releasedAt?: string;
  releaseReason?: string;
  takeoverOf?: string;
  releasedHeartbeatAt?: string;
  releasedExpiresAt?: string;
  releasedCommentUpdatedAtMillis?: number;
  commentId: number;
  commentUpdatedAtMillis?: number;
}

export interface ShippingClaimObservation {
  claim: ShippingClaim;
  active: boolean;
}

export interface DirectShipAuthorization {
  claim: ShippingClaim;
  key: string;
  generation: number;
  authorized: () => boolean;
  dispatch?: <T>(start: () => T) => T;
}

export interface PromptDispatchTracker {
  pending: (key: string) => boolean;
  track: <T>(key: string, start: () => T) => T;
}

export async function serializeShippingClaimOperation<T>(
  operations: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = operations.get(key);
  let finish!: () => void;
  const current = new Promise<void>((resolve) => {
    finish = resolve;
  });
  operations.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    finish();
    if (operations.get(key) === current) operations.delete(key);
  }
}

export type BoundedPromptDispatch<T> =
  | { status: 'acknowledged'; value: T }
  | { status: 'failed'; cause: unknown }
  | { status: 'timed_out' };

export function promptDispatchAdmissionVisible(
  turnId: string | null,
  inboxIds: ReadonlySet<string>,
  messageIds: ReadonlySet<string>,
): boolean {
  return turnId !== null && (inboxIds.has(turnId) || messageIds.has(turnId));
}

export function boundedPromptDispatch<T>(
  prompt: Promise<T>,
  timeout: Promise<void>,
  abort: () => void = () => undefined,
): Promise<BoundedPromptDispatch<T>> {
  return Promise.race([
    prompt.then<BoundedPromptDispatch<T>, BoundedPromptDispatch<T>>(
      (value) => ({ status: 'acknowledged', value }),
      (cause) => ({ status: 'failed', cause }),
    ),
    timeout.then<BoundedPromptDispatch<T>>(() => {
      abort();
      return { status: 'timed_out' };
    }),
  ]);
}

export function createPromptDispatchTracker(): PromptDispatchTracker {
  const pending = new Map<string, Set<Promise<void>>>();
  return {
    pending: (key) => !!pending.get(key)?.size,
    track: <T>(key: string, start: () => T): T => {
      let settle!: () => void;
      const barrier = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const barriers = pending.get(key) ?? new Set<Promise<void>>();
      barriers.add(barrier);
      pending.set(key, barriers);
      const finish = () => {
        settle();
        barriers.delete(barrier);
        if (!barriers.size) pending.delete(key);
      };
      let result: T;
      try {
        result = start();
      } catch (cause) {
        finish();
        throw cause;
      }
      void Promise.resolve(result).then(finish, finish);
      return result;
    },
  };
}

export function assertDirectShipPromptAuthorization(
  authorization: DirectShipAuthorization | undefined,
): void {
  if (authorization && !authorization.authorized())
    throw new Error('Direct shipping authorization expired before prompt dispatch.');
}

export function dispatchAuthorizedDirectShipPrompt<T>(
  authorization: DirectShipAuthorization | undefined,
  dispatch: () => T,
): T {
  assertDirectShipPromptAuthorization(authorization);
  return authorization?.dispatch
    ? authorization.dispatch(() => {
        assertDirectShipPromptAuthorization(authorization);
        return dispatch();
      })
    : dispatch();
}

export async function beginAuthorizedCoordinationPrompt<T>(
  authorize: () => DirectShipAuthorization,
  persistReplacement: () => Promise<void>,
  restoreReceipt: () => Promise<void>,
  dispatch: () => T,
): Promise<{ turn: T }> {
  const authorization = authorize();
  assertDirectShipPromptAuthorization(authorization);
  try {
    await persistReplacement();
    return { turn: dispatchAuthorizedDirectShipPrompt(authorization, dispatch) };
  } catch (cause) {
    await restoreReceipt();
    throw cause;
  }
}

export function compensatedOpenCodePromptReceiptChanges(
  admission: 'queued' | 'working' | null,
):
  | { state: 'queued' | 'working'; dispatchPending: false }
  | { state: 'starting'; turnId: null; dispatchPending: false } {
  return admission
    ? { state: admission, dispatchPending: false }
    : { state: 'starting', turnId: null, dispatchPending: false };
}

export async function recoverOpenCodePromptAdmission(
  admission: 'queued' | 'working',
  authorization: DirectShipAuthorization,
  steer: () => Promise<void>,
  resume: () => Promise<void>,
  compensateSteer: () => Promise<void>,
  persist: (state: 'queued' | 'working') => Promise<void>,
): Promise<void> {
  await dispatchAuthorizedDirectShipPrompt(authorization, async () => {
    let steered = false;
    try {
      if (admission === 'queued') {
        await steer();
        steered = true;
        assertDirectShipPromptAuthorization(authorization);
        await resume();
      }
      assertDirectShipPromptAuthorization(authorization);
      await persist(admission);
    } catch (cause) {
      if (steered) await compensateSteer();
      throw cause;
    }
  });
}

export function openCodePromptRecoveryFailure(
  targetId: string | null,
  prompt: string | null,
): string | null {
  if (!targetId) return 'Recovered OpenCode worker has no target session.';
  if (prompt === null) return 'Recovered OpenCode worker has no persisted prompt.';
  return null;
}

export async function completeAuthorizedPromptRecovery(
  authorization: DirectShipAuthorization,
  recover: () => Promise<void>,
  complete: () => Promise<void>,
): Promise<void> {
  await recover();
  assertDirectShipPromptAuthorization(authorization);
  await complete();
}

export interface ShipIssue {
  id: string;
  number: number;
  url: string;
  title: string;
  dependsOn: string[];
  state: ShipIssueState;
  branch: string;
  path: string | null;
  worktreeUnavailable?: boolean;
  receiptId: string | null;
  threadId: string | null;
  pullRequest: string | null;
  pullRequestHead?: string;
  workerSettled?: boolean;
  setupStarted?: boolean;
  setupCompleted?: boolean;
  archivePath?: string | null;
  error: string | null;
  stage?: string;
  blockedReason?: string | null;
  models?: string[];
  workerModel?: string;
  workerState?: SpawnState;
  workerUpdatedAt?: number;
  modelUncertain?: boolean;
  gates?: ShipGate[];
  events?: ShipEvent[];
  issueState?: 'OPEN' | 'CLOSED';
  checks?: ShipCheck[];
  refreshedAt?: number;
  refreshError?: string | null;
  claimFencePending?: boolean;
  claimRevalidationPending?: boolean;
  claimHandoffPending?: boolean;
  dispatchFencePending?: boolean;
  claim?: ShippingClaim;
  checkpoint?: TaskCheckpoint;
  checkpointThreadIds?: string[];
  contextCompactions?: Partial<Record<ContextProvider, number>>;
  contextEventIds?: string[];
  contextHandoffs?: ContextHandoff[];
  contextCheckpointRequestedAt?: number;
  contextCheckpointRequestedSequence?: number;
  contextHandoffOfferedAt?: number;
  contextHandoffOfferedSequence?: number;
  contextPercent?: number;
  contextPercentByThread?: Record<string, number>;
  handoffRecoveryRequired?: boolean;
  retryCount?: number;
  lostStateFailures?: number;
  evidenceManifests?: EvidenceManifest[];
  evidenceRevision?: string;
  evidenceCommit?: string;
  validationPolicyRequired?: boolean;
  validationPolicy?: ShipValidationPolicy;
  shippingTarget?: ShippingTarget;
}

export type ShippingTarget = {
  repository: string;
  remote: string;
  baseBranch: string;
  baseRef: string;
  baseRevision: string;
};

export interface ShipRun {
  id: string;
  source: string;
  repository: string;
  remote: string;
  provider: 'claude' | 'codex' | 'opencode';
  limit: number;
  approvedAt: number;
  externalClosed: Record<string, boolean>;
  dependencyErrors?: Record<string, string>;
  issues: ShipIssue[];
  umbrella?: { number: number; title: string; url: string };
}

export type DirectShipRunInput = {
  id: string;
  project: string;
  directory: string;
  branch: string;
  repository: string;
  number: number;
  provider: ShipRun['provider'];
  threadId: string;
  workerModel?: string;
  approvedAt: number;
};

export function registeredShipBranch(worktrees: RegisteredWorktree[], path: string): string {
  const branch = worktrees.find((worktree) => worktree.path === path && worktree.present)?.branch;
  if (!branch) throw new Error('The Ship worktree has no registered branch.');
  return branch;
}

export function adoptDirectShipRun(runs: ShipRun[], input: DirectShipRunInput): ShipRun[] {
  const existing = runs.find((run) =>
    run.issues.some((issue) => issue.path === input.directory && issue.threadId === input.threadId),
  );
  if (existing) {
    const existingIssue = existing.issues.find(
      (issue) => issue.path === input.directory && issue.threadId === input.threadId,
    );
    if (!input.workerModel || existingIssue?.workerModel === input.workerModel) return runs;
    return runs.map((run) =>
      run !== existing
        ? run
        : {
            ...run,
            issues: run.issues.map((issue) =>
              issue.path === input.directory && issue.threadId === input.threadId
                ? { ...issue, workerModel: input.workerModel }
                : issue,
            ),
          },
    );
  }
  return [
    ...runs,
    {
      id: input.id,
      source: `direct:${input.threadId}`,
      repository: input.project,
      remote: input.repository,
      provider: input.provider,
      limit: 1,
      approvedAt: input.approvedAt,
      externalClosed: {},
      dependencyErrors: {},
      issues: [
        {
          id: `${input.repository}#${input.number}`,
          number: input.number,
          url: `https://github.com/${input.repository}/issues/${input.number}`,
          title: `Issue #${input.number}`,
          dependsOn: [],
          state: 'working',
          branch: input.branch,
          path: input.directory,
          receiptId: null,
          threadId: input.threadId,
          pullRequest: null,
          workerSettled: false,
          workerModel: input.workerModel,
          error: null,
          stage: 'implementing',
          validationPolicyRequired: true,
          events: [{ at: input.approvedAt, stage: 'implementing' }],
          checkpoint: initialTaskCheckpoint(
            {
              id: `${input.repository}#${input.number}`,
              url: `https://github.com/${input.repository}/issues/${input.number}`,
              title: `Issue #${input.number}`,
            },
            input.approvedAt,
          ),
        },
      ],
    },
  ];
}

export async function adoptRegisteredDirectShipRun(
  registration: Promise<RegisteredWorktree[]>,
  input: Omit<DirectShipRunInput, 'branch'>,
  getRuns: () => ShipRun[],
  setRuns: (runs: ShipRun[]) => void,
  saveRuns: () => Promise<void>,
): Promise<boolean> {
  const branch = registeredShipBranch(await registration, input.directory);
  const current = getRuns();
  const previousIssue = current
    .flatMap((run) => run.issues)
    .find((issue) => issue.path === input.directory && issue.threadId === input.threadId);
  const adopted = adoptDirectShipRun(current, { ...input, branch });
  if (adopted === current) return previousIssue !== undefined;
  setRuns(adopted);
  try {
    await saveRuns();
  } catch (cause) {
    const latest = getRuns();
    setRuns(
      previousIssue
        ? latest.map((run) => ({
            ...run,
            issues: run.issues.map((issue) =>
              issue.path === input.directory &&
              issue.threadId === input.threadId &&
              issue.workerModel === input.workerModel
                ? { ...issue, workerModel: previousIssue.workerModel }
                : issue,
            ),
          }))
        : latest.filter((run) => run.id !== input.id),
    );
    throw cause;
  }
  return true;
}

export function isDirectShipRun(run: ShipRun): boolean {
  return run.source.startsWith('direct:');
}

export function directShipClaimPrompt(claim: ShippingClaim): string {
  return `\n\nSail holds visible claim ${claim.id} for task ${claim.task} on behalf of this worker. Use this exact claim as your /ship-it ownership; do not acquire another claim. Sail renews and releases it.`;
}

export function directClaimHandoffChanges(
  issue: ShipIssue,
  claim: ShippingClaim,
): Partial<ShipIssue> {
  return issue.state === 'failed'
    ? {
        claim,
        state: 'working',
        workerSettled: false,
        error: null,
        claimHandoffPending: true,
      }
    : { claim };
}

export function directClaimHandoffWaiting(
  issue: ShipIssue,
  workerState: SpawnState,
  monotonicNow: number,
  monotonicLeaseDeadline: number | undefined,
): boolean {
  return (
    !!issue.claimHandoffPending &&
    !['working', 'waiting', 'queued'].includes(workerState) &&
    monotonicLeaseDeadline !== undefined &&
    monotonicNow < monotonicLeaseDeadline
  );
}

export async function settleDirectClaimHandoff(
  issue: ShipIssue,
  workerState: SpawnState,
  fence: () => Promise<void>,
  finish: () => Promise<void>,
  monotonicNow: number,
  monotonicLeaseDeadline: number | undefined,
): Promise<boolean> {
  if (!issue.claimHandoffPending) return true;
  if (monotonicLeaseDeadline === undefined || monotonicNow >= monotonicLeaseDeadline) {
    await fence();
    return false;
  }
  if (directClaimHandoffWaiting(issue, workerState, monotonicNow, monotonicLeaseDeadline))
    return false;
  await finish();
  return true;
}

export function claimMonotonicLeaseDeadline(monotonicStart: number, claim: ShippingClaim): number {
  const submittedDuration = Date.parse(claim.expiresAt) - Date.parse(claim.heartbeatAt);
  const remaining =
    claim.commentUpdatedAtMillis === undefined
      ? submittedDuration
      : Math.min(submittedDuration, Date.parse(claim.expiresAt) - claim.commentUpdatedAtMillis);
  return monotonicStart + Math.max(0, remaining);
}

export function shippingClockWasSuspended(
  previousWall: number,
  previousMonotonic: number,
  wallNow: number,
  monotonicNow: number,
  tolerance = 1_000,
): boolean {
  const wallElapsed = wallNow - previousWall;
  const monotonicElapsed = monotonicNow - previousMonotonic;
  return wallElapsed >= 0 && monotonicElapsed >= 0 && wallElapsed - monotonicElapsed > tolerance;
}

export function directShipPromptAuthorized(
  issue: ShipIssue | undefined,
  claimId: string,
  expectedGeneration: number,
  currentGeneration: number | undefined,
  monotonicNow: number,
  monotonicLeaseDeadline: number | undefined,
): boolean {
  return (
    currentGeneration === expectedGeneration &&
    !!issue &&
    ['starting', 'working'].includes(issue.state) &&
    issue.claim?.status === 'active' &&
    issue.claim.id === claimId &&
    !issue.claimFencePending &&
    monotonicLeaseDeadline !== undefined &&
    monotonicNow < monotonicLeaseDeadline
  );
}

export function shippingClaimOwnedByInstance(
  claim: ShippingClaim | undefined,
  instanceId: string,
): boolean {
  return claim?.status === 'active' && claim.instanceId === instanceId;
}

export async function fencePredecessorWorkerBeforeTakeover(
  observe: () => Promise<ShippingClaimObservation>,
  fence: () => Promise<void>,
  releaseFence: () => Promise<void>,
): Promise<{ observation: ShippingClaimObservation; fenced: boolean }> {
  const observation = await observe();
  if (!observation.active) {
    await fence();
    await releaseFence();
  }
  return { observation, fenced: !observation.active };
}

export function predecessorTakeoverChanges(): Partial<ShipIssue> {
  return {
    state: 'pending',
    claim: undefined,
    receiptId: null,
    threadId: null,
    workerSettled: false,
    workerState: undefined,
    claimFencePending: false,
    claimRevalidationPending: false,
    claimHandoffPending: false,
    dispatchFencePending: false,
    blockedReason: null,
    refreshError: null,
    error: null,
  };
}

export function resumedShippingIssueChanges(issue: ShipIssue): Partial<ShipIssue> {
  const terminal = issue.state === 'merged' || issue.state === 'failed';
  return {
    ...(terminal ? {} : { state: 'failed' as const }),
    claimFencePending: false,
    claimRevalidationPending: false,
    workerSettled: true,
    ...(terminal
      ? {}
      : { error: 'Worker was interrupted after system resume. Retry after claim revalidation.' }),
    blockedReason: null,
    refreshError: null,
  };
}

export function monotonicDeadlineExpired(monotonicNow: number, deadline: number): boolean {
  return monotonicNow >= deadline;
}

export async function persistAcquiredClaim(
  claim: ShippingClaim,
  persist: (claim: ShippingClaim) => Promise<void>,
  release: (claim: ShippingClaim) => Promise<void>,
): Promise<void> {
  try {
    await persist(claim);
  } catch (cause) {
    try {
      await release(claim);
    } catch (releaseCause) {
      throw new Error(
        `Shipping claim persistence failed: ${String(cause)}; compensating release failed: ${String(releaseCause)}`,
        { cause: releaseCause },
      );
    }
    throw cause;
  }
}

export function resolvedWorkerModel(issue: ShipIssue): string | undefined {
  if (issue.workerModel) return issue.workerModel;
  return issue.models?.length === 1 ? issue.models[0] : undefined;
}

export function shippingWorkerSettled(state: SpawnState): boolean {
  return ['completed', 'failed', 'interrupted'].includes(state);
}

export function closedPullRequestRequiresFence(state: SpawnState): boolean {
  return !shippingWorkerSettled(state);
}

export async function settleClosedPullRequest(
  workerState: SpawnState,
  fence: () => Promise<boolean>,
  fail: () => Promise<void>,
): Promise<boolean> {
  if (closedPullRequestRequiresFence(workerState) && !(await fence())) return false;
  await fail();
  return true;
}

export function acpWorkerTerminationConfirmed(
  activity: AgentActivity | undefined,
  interrupted: InterruptedAgentTurn[],
  agent: string,
  sessionId: string,
  turnId: string | null,
): boolean {
  if (!activity?.alive) return false;
  if (activity.active.includes(sessionId) || activity.waiting.includes(sessionId)) return false;
  if (!turnId) return true;
  if (activity.finished[sessionId]?.turnId === turnId) return true;
  return interrupted.some(
    (turn) => turn.agent === agent && turn.sessionId === sessionId && turn.turnId === turnId,
  );
}

export type OpenCodeWorkerSnapshot = {
  running: boolean;
  queued: string[];
};

export async function confirmOpenCodeWorkerStopped(
  interrupt: () => Promise<{ interrupted: boolean }>,
  inspect: () => Promise<OpenCodeWorkerSnapshot>,
  cancelQueued: (id: string) => Promise<void>,
  pause: () => Promise<void>,
  maximumAttempts = 50,
  dispatchPending: () => boolean = () => false,
): Promise<boolean> {
  await interrupt();
  const confirm = async (
    attempt: number,
    idleObservations: number,
    interruptAfterDispatch = false,
  ): Promise<boolean> => {
    if (dispatchPending()) {
      if (attempt >= maximumAttempts) return false;
      await pause();
      return confirm(attempt + 1, 0, true);
    }
    if (interruptAfterDispatch) await interrupt();
    const snapshot = await inspect();
    if (snapshot.queued.length) await Promise.all(snapshot.queued.map((id) => cancelQueued(id)));
    if (snapshot.running) await interrupt();
    const idle = !snapshot.running && !snapshot.queued.length;
    const observations = idle ? idleObservations + 1 : 0;
    if (observations >= 2) return true;
    if (attempt >= maximumAttempts) return false;
    await pause();
    return confirm(attempt + 1, observations);
  };
  return confirm(1, 0);
}

export function claimRefreshRequiresFence(
  _claim: ShippingClaim,
  cause: unknown,
  monotonicNow?: number,
  monotonicLeaseDeadline?: number,
): boolean {
  if (
    monotonicNow !== undefined &&
    monotonicLeaseDeadline !== undefined &&
    monotonicNow >= monotonicLeaseDeadline
  )
    return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    message === 'Shipping claim fence is no longer owned by this claim.' ||
    /superseded|expired|released|comment no longer exists|identity no longer matches|heartbeat is stale|update revision is stale|id already belongs/i.test(
      message,
    )
  );
}

export function settledLostClaimFence(
  claim: ShippingClaim,
  cause: unknown,
): Partial<ShipIssue> | null {
  if (!claimRefreshRequiresFence(claim, cause)) return null;
  return {
    state: 'failed',
    claim: undefined,
    claimFencePending: false,
    claimRevalidationPending: false,
    claimHandoffPending: false,
    workerSettled: true,
    refreshError: null,
  };
}

export function nextClaimHeartbeatDeadline(
  monotonicNow: number,
  monotonicLeaseDeadline?: number,
): number {
  if (monotonicLeaseDeadline === undefined) return monotonicNow + 45_000;
  const remaining = Math.max(0, monotonicLeaseDeadline - monotonicNow);
  return monotonicNow + Math.min(45_000, remaining / 2);
}

export function claimHeartbeatDue(
  monotonicNow: number,
  monotonicDeadline: number | undefined,
  force = false,
): boolean {
  return force || monotonicDeadline === undefined || monotonicNow >= monotonicDeadline;
}

export function terminalClaimReleaseReady(
  issue: ShipIssue,
  promptDispatchPending = false,
  taskWorkersSettled = false,
): boolean {
  return (
    (issue.state === 'merged' || issue.state === 'failed') &&
    issue.workerSettled === true &&
    taskWorkersSettled &&
    !issue.claimFencePending &&
    !issue.claimHandoffPending &&
    !issue.dispatchFencePending &&
    !promptDispatchPending
  );
}

export async function fenceShippingTaskThreads(
  threadIds: (string | null | undefined)[],
  stop: (threadId: string) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(threadIds.filter((threadId): threadId is string => Boolean(threadId)))].map(stop),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

export async function fenceResumedShippingClaim(
  stopWorkers: () => Promise<void>,
  revalidate: () => Promise<boolean>,
  settle: () => Promise<void>,
): Promise<boolean> {
  await stopWorkers();
  if (!(await revalidate())) return false;
  await settle();
  return true;
}

export async function fenceExpiredShippingLease(
  monotonicNow: number,
  monotonicLeaseDeadline: number | undefined,
  fence: () => Promise<void>,
  wallNow?: number,
  wallLeaseDeadline?: number,
): Promise<boolean> {
  const monotonicExpired =
    monotonicLeaseDeadline !== undefined && monotonicNow >= monotonicLeaseDeadline;
  const wallExpired =
    wallLeaseDeadline !== undefined && wallNow !== undefined && wallNow >= wallLeaseDeadline;
  if (!monotonicExpired && !wallExpired) return false;
  await fence();
  return true;
}

export function workerStateSettled(state: SpawnState, promptDispatchPending = false): boolean {
  return !promptDispatchPending && ['completed', 'failed', 'interrupted'].includes(state);
}

export async function persistVerifiedHeartbeat(
  claim: ShippingClaim,
  persist: (claim: ShippingClaim) => Promise<void>,
): Promise<boolean> {
  await persist(claim);
  return claim.status === 'active';
}

export async function persistStartedShippingWorker(
  threadId: string,
  persistWorking: (threadId: string) => Promise<void>,
  stopWorker: (threadId: string) => Promise<void>,
  persistFence: (threadId: string, cause: unknown) => Promise<void>,
): Promise<{ error: unknown; fencePending: boolean } | null> {
  try {
    await persistWorking(threadId);
    return null;
  } catch (cause) {
    try {
      await stopWorker(threadId);
    } catch (stopCause) {
      await persistFence(threadId, stopCause);
      return { error: cause, fencePending: true };
    }
    return { error: cause, fencePending: false };
  }
}

export async function refreshShippingIssueAfterClaim(
  issue: ShipIssue,
  refreshClaim: (revalidate: boolean) => Promise<boolean>,
  acquireClaim: () => Promise<boolean>,
  refreshIssue: () => Promise<void>,
  retryFence: () => Promise<void> = async () => undefined,
  retryRevalidation: () => Promise<void> = async () => undefined,
  claimOwnedByInstance = true,
): Promise<void> {
  const recovering = ['starting', 'working'].includes(issue.state);
  if (issue.claim?.status === 'active' && !claimOwnedByInstance) return;
  if (recovering && issue.claimRevalidationPending) {
    await retryRevalidation();
    return;
  }
  if (recovering && issue.claimFencePending) {
    await retryFence();
    return;
  }
  if (recovering) {
    if (issue.claim?.status === 'active') {
      if (!(await refreshClaim(true))) return;
    } else if (!(await acquireClaim())) return;
  }
  await refreshIssue();
  if (!recovering) await refreshClaim(false);
}

export function shippingSetupAction(issue: ShipIssue, setup: string): 'run' | 'skip' {
  if (!setup.trim() || issue.setupCompleted) return 'skip';
  if (issue.setupStarted)
    throw new Error('Worktree setup was interrupted. Inspect its worktree before retrying.');
  return 'run';
}

export function createShipRun(
  graph: PublishedGraph,
  repository: string,
  remote: string,
  source: string,
  provider: ShipRun['provider'],
  limit: number,
  id: string,
  approvedAt: number,
): ShipRun {
  if (!graph.issues.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 8)
    throw new Error('Choose 1–8 concurrent workers.');
  if (graph.issues.some((issue) => issue.repository !== remote || issue.state !== 'OPEN'))
    throw new Error('Only open issues in this repository can be shipped together.');
  for (const issue of graph.issues) {
    if (
      issue.dependsOn.some(
        (dependency) => !/^(?:[1-9]\d*|[^/#]+\/[^/#]+#[1-9]\d*|[^/#]+)$/.test(dependency),
      )
    )
      throw new Error(`Invalid blocker for #${issue.number}.`);
  }
  return {
    id,
    source,
    repository,
    remote,
    provider,
    limit,
    approvedAt,
    externalClosed: {},
    dependencyErrors: {},
    umbrella: graph.umbrella
      ? { number: graph.umbrella.number, title: graph.umbrella.title, url: graph.umbrella.url }
      : undefined,
    issues: graph.issues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      dependsOn: [...issue.dependsOn],
      state: 'pending',
      branch: `ship-issue-${issue.number}-${id.slice(0, 8)}`,
      path: null,
      receiptId: null,
      threadId: null,
      pullRequest: null,
      workerSettled: false,
      setupStarted: false,
      setupCompleted: false,
      archivePath: null,
      error: null,
      checkpoint: initialTaskCheckpoint(
        { id: issue.id, url: issue.url, title: issue.title },
        approvedAt,
      ),
      validationPolicyRequired: true,
    })),
  };
}

export function readyShipIssues(
  run: ShipRun,
  unsettledReceiptIds: ReadonlySet<string> = new Set(),
): ShipIssue[] {
  const aliases = new Map<string, ShipIssue>();
  for (const issue of run.issues) {
    aliases.set(issue.id, issue);
    aliases.set(String(issue.number), issue);
    aliases.set(`${run.remote}#${issue.number}`, issue);
  }
  const active = run.issues.filter(
    (issue) =>
      ['starting', 'working'].includes(issue.state) ||
      (issue.receiptId !== null && unsettledReceiptIds.has(issue.receiptId)) ||
      (issue.state === 'merged' &&
        issue.workerSettled !== true &&
        (!!issue.path || issue.workerSettled === false)),
  ).length;
  return run.issues
    .filter(
      (issue) =>
        issue.state === 'pending' &&
        issue.dependsOn.every(
          (dependency) =>
            aliases.get(dependency)?.state === 'merged' ||
            (!aliases.has(dependency) && run.externalClosed[dependency]),
        ),
    )
    .slice(0, Math.max(0, run.limit - active));
}

export function shipIssueStatus(run: ShipRun, issue: ShipIssue): string {
  if (issue.state !== 'pending') return issue.state.replace('_', ' ');
  const aliases = new Map(
    run.issues.flatMap((item) => [
      [item.id, item],
      [String(item.number), item],
      [`${run.remote}#${item.number}`, item],
    ]),
  );
  if (issue.dependsOn.some((dependency) => aliases.get(dependency)?.state === 'failed'))
    return 'paused by failed dependency';
  return issue.dependsOn.length ? 'waiting for dependencies' : 'queued';
}

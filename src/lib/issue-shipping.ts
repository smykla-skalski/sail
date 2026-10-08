import type { PublishedGraph } from './issue-graph';
import type { RegisteredWorktree } from './coordination';
import type { SpawnState } from './agent-results';
import type { ShipEvent, ShipGate, ShipCheck } from './ship-progress';
import { initialTaskCheckpoint, type TaskCheckpoint } from './task-checkpoint.ts';
import type { ContextHandoff, ContextProvider } from './context-handoff.ts';
import type { EvidenceManifest } from './task-evidence.ts';
import type { ShipValidationPolicy } from './ship-risk-policy.ts';

export type ShipIssueState =
  'pending' | 'starting' | 'working' | 'awaiting_merge' | 'failed' | 'merged';

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
  if (adopted === current) return false;
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

export function resolvedWorkerModel(issue: ShipIssue): string | undefined {
  if (issue.workerModel) return issue.workerModel;
  return issue.models?.length === 1 ? issue.models[0] : undefined;
}

export function shippingWorkerSettled(state: SpawnState): boolean {
  return ['completed', 'failed', 'interrupted'].includes(state);
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

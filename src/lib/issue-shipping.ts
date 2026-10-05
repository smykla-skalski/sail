import type { PublishedGraph } from './issue-graph';
import type { SpawnState } from './agent-results';

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
  receiptId: string | null;
  threadId: string | null;
  pullRequest: string | null;
  workerSettled?: boolean;
  archivePath?: string | null;
  error: string | null;
}

export interface ShipRun {
  id: string;
  source: string;
  repository: string;
  remote: string;
  provider: 'claude' | 'codex' | 'opencode';
  limit: number;
  approvedAt: number;
  externalClosed: Record<string, boolean>;
  issues: ShipIssue[];
}

export function shippingWorkerSettled(state: SpawnState): boolean {
  return ['completed', 'failed', 'interrupted'].includes(state);
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
      archivePath: null,
      error: null,
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

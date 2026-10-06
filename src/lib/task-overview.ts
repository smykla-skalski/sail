import type { AgentThread } from './acp.ts';
import type { SpawnReceipt } from './agent-results.ts';
import type { ThreadStatus } from './attention.ts';
import type { PostTurnCheck } from './post-turn-checks.ts';
import type { ProjectCatalog } from './projects.ts';
import { threadKey } from './recent-threads.ts';

export type TaskOverviewSort = 'attention' | 'recent' | 'repository' | 'pinned';

export type TaskOverviewCheckState = 'passed' | 'failed' | 'running' | 'other' | 'none';

export type TaskOverviewCard = {
  id: string;
  path: string;
  repository: string;
  repositoryName: string;
  branch: string;
  task: string;
  threadKey: string | null;
  agent: string | null;
  agentName: string;
  status: ThreadStatus | null;
  nextAction: string;
  latestEvent: string;
  updated: number;
  checkState: TaskOverviewCheckState;
  check: PostTurnCheck | null;
  setupFailed: boolean;
};

export type TaskOverviewPreferences = {
  sort: TaskOverviewSort;
  pinned: string[];
  selected: string | null;
};

const statusPriority: Record<ThreadStatus, number> = {
  waiting: 0,
  failed: 1,
  working: 2,
  done: 3,
};

function name(path: string): string {
  return path.split(/[\\/]/).findLast((part) => !!part) ?? path;
}

function latest<T extends { updated: number }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>(
    (recent, item) => (!recent || item.updated > recent.updated ? item : recent),
    undefined,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cardStatus(
  threads: AgentThread[],
  statuses: Record<string, ThreadStatus | null>,
): { thread: AgentThread; status: ThreadStatus } | null {
  return (
    threads
      .flatMap((thread) => {
        const status = statuses[threadKey(thread)];
        return status ? [{ thread, status }] : [];
      })
      .toSorted(
        (left, right) =>
          statusPriority[left.status] - statusPriority[right.status] ||
          right.thread.updated - left.thread.updated,
      )[0] ?? null
  );
}

function currentChecks(checks: PostTurnCheck[]): PostTurnCheck[] {
  const newest = latest(checks);
  if (!newest) return [];
  return checks.filter((check) => check.thread === newest.thread && check.turn === newest.turn);
}

function combinedCheckState(checks: PostTurnCheck[]): TaskOverviewCheckState {
  if (!checks.length) return 'none';
  if (checks.some((check) => check.status === 'failed' || check.status === 'timed_out'))
    return 'failed';
  if (checks.some((check) => check.status === 'running')) return 'running';
  if (checks.every((check) => check.status === 'passed')) return 'passed';
  return 'other';
}

export function buildTaskOverviewCards(input: {
  catalog: ProjectCatalog;
  threads: Record<string, AgentThread[]>;
  statuses: Record<string, ThreadStatus | null>;
  agentNames: Record<string, string>;
  checks: PostTurnCheck[];
  receipts: SpawnReceipt[];
}): TaskOverviewCard[] {
  const locations = input.catalog.repositories.flatMap((repository) => [
    {
      path: repository,
      repository,
      branch: 'Default branch',
      setupFailed: false,
      statusComment: undefined as string | undefined,
    },
    ...(input.catalog.worktrees[repository] ?? []).map((worktree) => ({
      path: worktree.path,
      repository,
      branch: worktree.branch,
      setupFailed: worktree.setupStatus === 'failed',
      statusComment: worktree.statusComment,
    })),
  ]);

  return locations.map((location) => {
    const threads = input.threads[location.path] ?? [];
    const recentThread = latest(threads);
    const active = cardStatus(threads, input.statuses);
    const locationChecks = currentChecks(
      input.checks.filter((check) => check.directory === location.path),
    );
    const recentCheck = latest(locationChecks);
    const failedCheck = locationChecks.find(
      (check) => check.status === 'failed' || check.status === 'timed_out',
    );
    const recentReceipt = latest(
      input.receipts.filter(
        (receipt) =>
          receipt.sourceDirectory === location.path || receipt.targetDirectory === location.path,
      ),
    );
    const events = [
      ...(recentThread
        ? [{ updated: recentThread.updated, text: `Thread updated: ${recentThread.title}` }]
        : []),
      ...(recentCheck
        ? [
            {
              updated: recentCheck.updated,
              text: `Check ${recentCheck.status}: ${recentCheck.command}`,
            },
          ]
        : []),
      ...(recentReceipt
        ? [
            {
              updated: recentReceipt.updated,
              text: recentReceipt.activity?.trim() || `Subagent ${recentReceipt.state}`,
            },
          ]
        : []),
    ];
    const recentEvent = latest(events);
    const selectedThread = active?.thread ?? recentThread;
    const agent = selectedThread?.agent ?? null;
    const status = active?.status ?? null;
    const currentCheckState = combinedCheckState(locationChecks);
    let nextAction = 'Start an agent';
    if (location.setupFailed) nextAction = 'Repair worktree setup';
    else if (status === 'waiting')
      nextAction = `Respond to ${input.agentNames[agent ?? ''] ?? agent}`;
    else if (currentCheckState === 'failed') nextAction = 'Review failed check';
    else if (status === 'failed') nextAction = 'Review agent failure';
    else if (status === 'working') nextAction = 'Agent is working';
    else if (recentThread) nextAction = 'Continue task';

    return {
      id: location.path,
      path: location.path,
      repository: location.repository,
      repositoryName: name(location.repository),
      branch: location.branch,
      task: selectedThread?.title ?? location.statusComment ?? 'No active task',
      threadKey: selectedThread ? threadKey(selectedThread) : null,
      agent,
      agentName: agent ? (input.agentNames[agent] ?? agent) : 'No agent',
      status,
      nextAction,
      latestEvent: recentEvent?.text ?? location.statusComment ?? 'No recent activity',
      updated: recentEvent?.updated ?? 0,
      checkState: currentCheckState,
      check: failedCheck ?? recentCheck ?? null,
      setupFailed: location.setupFailed,
    };
  });
}

export function filterTaskOverviewCards(
  cards: TaskOverviewCard[],
  query: string,
): TaskOverviewCard[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return cards;
  return cards.filter((card) =>
    [card.task, card.repositoryName, card.repository, card.branch, card.agentName, card.path].some(
      (value) => value.toLocaleLowerCase().includes(needle),
    ),
  );
}

export function sortTaskOverviewCards(
  cards: TaskOverviewCard[],
  sort: TaskOverviewSort,
  pinned: string[],
): TaskOverviewCard[] {
  const pins = new Set(pinned);
  const attention = (card: TaskOverviewCard) => {
    if (card.setupFailed || card.status === 'waiting') return 0;
    if (card.checkState === 'failed' || card.status === 'failed') return 1;
    if (card.status === 'working' || card.checkState === 'running') return 2;
    if (!card.status) return 3;
    return 4;
  };
  return cards.toSorted((left, right) => {
    if (sort === 'pinned') {
      const pinOrder = Number(pins.has(right.id)) - Number(pins.has(left.id));
      if (pinOrder) return pinOrder;
    }
    if (sort === 'repository') {
      const repositoryOrder = left.repositoryName.localeCompare(right.repositoryName);
      if (repositoryOrder) return repositoryOrder;
      return left.branch.localeCompare(right.branch);
    }
    if (sort === 'attention' || sort === 'pinned') {
      const attentionOrder = attention(left) - attention(right);
      if (attentionOrder) return attentionOrder;
    }
    return right.updated - left.updated || left.repositoryName.localeCompare(right.repositoryName);
  });
}

export function loadTaskOverviewPreferences(raw: string | null): TaskOverviewPreferences {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!isRecord(value)) throw new Error('Invalid preferences');
    const saved = value;
    const sort: TaskOverviewSort =
      saved.sort === 'recent' ||
      saved.sort === 'repository' ||
      saved.sort === 'pinned' ||
      saved.sort === 'attention'
        ? saved.sort
        : 'attention';
    return {
      sort,
      pinned: Array.isArray(saved.pinned)
        ? [...new Set(saved.pinned.filter((item): item is string => typeof item === 'string'))]
        : [],
      selected: typeof saved.selected === 'string' ? saved.selected : null,
    };
  } catch {
    return { sort: 'attention', pinned: [], selected: null };
  }
}

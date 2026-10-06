<script lang="ts">
  import { onMount } from 'svelte';
  import TaskOverview from '../../src/TaskOverview.svelte';
  import type { AgentThread } from '../../src/lib/acp';
  import type { ThreadStatus } from '../../src/lib/attention';
  import type { ProjectCatalog } from '../../src/lib/projects';
  import { threadKey } from '../../src/lib/recent-threads';

  const catalog: ProjectCatalog = { repositories: [], groups: [], worktrees: {} };
  const paths: string[] = [];
  for (let repositoryIndex = 0; repositoryIndex < 10; repositoryIndex += 1) {
    const repository = `/fixture/repo-${repositoryIndex}`;
    catalog.repositories.push(repository);
    paths.push(repository);
    catalog.worktrees[repository] = Array.from({ length: 9 }, (_, worktreeIndex) => {
      const path = `${repository}/worktree-${worktreeIndex}`;
      paths.push(path);
      return {
        path,
        branch: `feature/${repositoryIndex}-${worktreeIndex}`,
        setupStatus:
          repositoryIndex === 0 && worktreeIndex === 0
            ? ('pending' as const)
            : repositoryIndex === 0 && worktreeIndex === 1
              ? ('failed' as const)
              : ('ready' as const),
      };
    });
  }

  const initialThreads: Record<string, AgentThread[]> = {};
  const statuses: Record<string, ThreadStatus | null> = {};
  for (const [index, path] of paths.entries()) {
    if (index < 5) {
      initialThreads[path] = [];
      continue;
    }
    const count = index < 10 ? 10 : 5;
    initialThreads[path] = Array.from({ length: count }, (_, threadIndex) => {
      const thread: AgentThread = {
        directory: path,
        title: `Task ${index} thread ${threadIndex}`,
        agent: threadIndex % 2 ? 'codex' : 'claude',
        sessionId: `session-${index}-${threadIndex}`,
        updated: index * 100 + threadIndex,
      };
      statuses[threadKey(thread)] = threadIndex === count - 1 ? 'working' : 'done';
      return thread;
    });
  }
  const threadCount = Object.values(initialThreads).reduce(
    (total, items) => total + items.length,
    0,
  );

  let threads = $state(initialThreads);
  let burst = $state(0);
  let releaseOverview: (() => void) | undefined;
  const overviewPending = new Promise<[]>((resolve) => {
    releaseOverview = () => resolve([]);
  });

  onMount(() => {
    const target = window as typeof window & {
      sailTaskOverviewBurst?: () => void;
      sailTaskOverviewReleaseRefresh?: () => void;
    };
    target.sailTaskOverviewReleaseRefresh = () => releaseOverview?.();
    target.sailTaskOverviewBurst = () => {
      for (let index = 0; index < 50; index += 1)
        queueMicrotask(() => {
          const path = paths[index + 5];
          const current = threads[path];
          threads = Object.assign({}, threads, {
            [path]: current.map((thread, threadIndex) =>
              threadIndex === current.length - 1
                ? Object.assign({}, thread, {
                    title: `Burst ${index}`,
                    updated: 20_000 + index,
                  })
                : thread,
            ),
          });
          burst += 1;
        });
    };
    return () => {
      delete target.sailTaskOverviewBurst;
      delete target.sailTaskOverviewReleaseRefresh;
    };
  });
</script>

<TaskOverview
  {catalog}
  {threads}
  {statuses}
  agentNames={{ claude: 'Claude', codex: 'Codex' }}
  checks={[]}
  receipts={[]}
  directory=""
  onopen={async () => {}}
  onopencheck={async () => {}}
  loadOverviews={() => overviewPending}
/>
<output aria-label="Scale fixture state">{threadCount} threads · {burst} updates</output>

<style>
  output {
    position: fixed;
    left: -10000px;
  }
</style>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import ActivityStatus from './ActivityStatus.svelte';
  import HarnessIcon from './HarnessIcon.svelte';
  import type { AgentThread } from './lib/acp';
  import type { SpawnReceipt } from './lib/agent-results';
  import type { ThreadStatus } from './lib/attention';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import type { ProjectCatalog } from './lib/projects';
  import { checkState } from './lib/pull-request-checks';
  import { getSetting, setSetting } from './lib/settings';
  import {
    buildTaskOverviewCards,
    filterTaskOverviewCards,
    loadTaskOverviewPreferences,
    sortTaskOverviewCards,
    type TaskOverviewCard,
    type TaskOverviewSort,
  } from './lib/task-overview';

  type WorktreeOverview = {
    path: string;
    branch: string | null;
    changedFiles: number | null;
    error: string | null;
  };
  type PullRequestCheck = { name: string; state: string; url: string };
  type PullRequestChecks = { number: number; url: string; checks: PullRequestCheck[] };
  type RepositoryChecks = {
    checks: Record<string, PullRequestChecks | null>;
    errors: Record<string, string>;
  };
  type Props = {
    catalog: ProjectCatalog;
    threads: Record<string, AgentThread[]>;
    statuses: Record<string, ThreadStatus | null>;
    agentNames: Record<string, string>;
    checks: PostTurnCheck[];
    receipts: SpawnReceipt[];
    directory: string;
    onopen: (path: string, threadKey: string | null) => Promise<void>;
    onopencheck: (check: PostTurnCheck) => Promise<void>;
  };

  let {
    catalog,
    threads,
    statuses,
    agentNames,
    checks,
    receipts,
    directory,
    onopen,
    onopencheck,
  }: Props = $props();
  const preferenceKey = 'sai-task-overview';
  const saved = loadTaskOverviewPreferences(getSetting(preferenceKey));
  let query = $state('');
  let sort = $state<TaskOverviewSort>(saved.sort);
  let pinned = $state<string[]>(saved.pinned);
  let selected = $state<string | null>(saved.selected);
  let metadata = $state<Record<string, WorktreeOverview>>({});
  let pullRequests = $state<Record<string, PullRequestChecks | null>>({});
  let pullRequestErrors = $state<Record<string, string>>({});
  let loading = $state(true);
  let generation = 0;
  let searchInput: HTMLInputElement;
  let baseCards = $derived(
    buildTaskOverviewCards({ catalog, threads, statuses, agentNames, checks, receipts }),
  );
  let searchableCards = $derived(
    baseCards.map((card) => ({
      ...card,
      branch: metadata[card.path]?.branch ?? card.branch,
    })),
  );
  let cards = $derived(
    sortTaskOverviewCards(filterTaskOverviewCards(searchableCards, query), sort, pinned),
  );
  let locationsKey = $derived(JSON.stringify(baseCards.map((card) => card.path)));

  $effect(() => {
    setSetting(preferenceKey, JSON.stringify({ sort, pinned, selected }));
  });

  $effect(() => {
    void refresh(locationsKey);
  });

  onMount(() => {
    const timer = setInterval(() => void refresh(), 30_000);
    void tick().then(() => searchInput?.focus());
    return () => clearInterval(timer);
  });

  async function refresh(_locationsKey = locationsKey) {
    if (_locationsKey !== locationsKey) return;
    const current = ++generation;
    const paths = baseCards.map((card) => card.path);
    loading = true;
    const repositories = Object.entries(catalog.worktrees).filter(
      ([, worktrees]) => worktrees.length,
    );
    const [overviewResult, checkResults] = await Promise.all([
      invoke<WorktreeOverview[]>('worktree_overviews', { paths }).catch(() => []),
      Promise.allSettled(
        repositories.map(([repository, worktrees]) =>
          invoke<RepositoryChecks>('pull_request_checks', {
            repository,
            worktrees: worktrees.map(({ path, branch }) => ({ path, branch })),
          }),
        ),
      ),
    ]);
    if (current !== generation) return;
    metadata = Object.fromEntries(overviewResult.map((entry) => [entry.path, entry]));
    const nextChecks: Record<string, PullRequestChecks | null> = {};
    const nextErrors: Record<string, string> = {};
    checkResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        Object.assign(nextChecks, result.value.checks);
        Object.assign(nextErrors, result.value.errors);
      } else {
        for (const worktree of repositories[index][1]) nextErrors[worktree.path] = 'Unavailable';
      }
    });
    pullRequests = nextChecks;
    pullRequestErrors = nextErrors;
    loading = false;
  }

  function togglePin(path: string) {
    pinned = pinned.includes(path) ? pinned.filter((item) => item !== path) : [...pinned, path];
    persistPreferences();
  }

  function persistPreferences() {
    setSetting(preferenceKey, JSON.stringify({ sort, pinned, selected }));
  }

  function changeSort(event: Event) {
    sort = (event.currentTarget as HTMLSelectElement).value as TaskOverviewSort;
    persistPreferences();
  }

  function cardBranch(card: TaskOverviewCard): string {
    return metadata[card.path]?.branch ?? card.branch;
  }

  function repositoryState(card: TaskOverviewCard): string | null {
    return (
      metadata[card.path]?.error ??
      pullRequestErrors[card.path] ??
      (!loading && !(card.path in metadata) ? 'Repository status unavailable' : null)
    );
  }

  function pullRequestState(card: TaskOverviewCard): 'passing' | 'failing' | 'pending' | null {
    const pullRequest = pullRequests[card.path];
    if (!pullRequest) return null;
    if (pullRequest.checks.some((check) => checkState(check) === 'failing')) return 'failing';
    if (
      pullRequest.checks.length &&
      pullRequest.checks.every((check) => checkState(check) === 'passing')
    )
      return 'passing';
    return 'pending';
  }

  function checkLabel(card: TaskOverviewCard): string {
    const state = visibleCheckState(card);
    return state ? `Checks ${state}` : 'Checks not run';
  }

  function visibleCheckState(card: TaskOverviewCard): 'passing' | 'failing' | 'pending' | null {
    const pullRequest = pullRequestState(card);
    if (pullRequest === 'failing' || card.checkState === 'failed') return 'failing';
    if (pullRequest === 'pending' || card.checkState === 'running') return 'pending';
    if (pullRequest === 'passing' || card.checkState === 'passed') return 'passing';
    return null;
  }

  function actionLabel(card: TaskOverviewCard): string {
    return visibleCheckState(card) === 'failing' ? 'Review failed check' : card.nextAction;
  }

  async function open(card: TaskOverviewCard) {
    selected = card.id;
    persistPreferences();
    await onopen(card.path, card.threadKey);
  }

  async function openAction(card: TaskOverviewCard) {
    selected = card.id;
    persistPreferences();
    const failingPullRequest = pullRequests[card.path]?.checks.find(
      (check) => checkState(check) === 'failing' && check.url,
    );
    if (failingPullRequest) {
      await invoke('open_check_url', { url: failingPullRequest.url });
      return;
    }
    if (card.checkState === 'failed' && card.check) {
      await onopencheck(card.check);
      return;
    }
    await onopen(card.path, card.threadKey);
  }
</script>

<main class="task-overview" aria-label="Task overview">
  <header class="task-overview-header">
    <div>
      <p class="eyebrow">ALL WORKTREES</p>
      <h1>Task overview</h1>
    </div>
    <span class="task-overview-count" aria-live="polite">{cards.length} shown</span>
  </header>
  <div class="task-overview-controls">
    <label class="task-overview-search">
      <span class="sr-only">Search tasks</span>
      <input
        bind:this={searchInput}
        bind:value={query}
        placeholder="Search task, repository, branch, or agent…"
      />
    </label>
    <label class="task-overview-sort">
      <span>Sort</span>
      <select value={sort} aria-label="Sort task overview" onchange={changeSort}>
        <option value="attention">Needs input</option>
        <option value="recent">Recent activity</option>
        <option value="repository">Repository</option>
        <option value="pinned">Pinned first</option>
      </select>
    </label>
    <button class="task-overview-refresh" disabled={loading} onclick={() => void refresh()}>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
  <section class="task-card-grid" aria-label="Worktree tasks" aria-busy={loading}>
    {#each cards as card (card.id)}
      {@const unavailable = repositoryState(card)}
      <article class:selected={selected === card.id || directory === card.path} class="task-card">
        <div class="task-card-topline">
          <span class="task-card-repository" title={card.repository}>{card.repositoryName}</span>
          <button
            class:active={pinned.includes(card.id)}
            class="task-card-pin"
            aria-label={`${pinned.includes(card.id) ? 'Unpin' : 'Pin'} ${card.task}`}
            aria-pressed={pinned.includes(card.id)}
            onclick={() => togglePin(card.id)}>★</button
          >
        </div>
        <button class="task-card-main" onclick={() => void open(card)}>
          <strong>{card.task}</strong>
          <span class="task-card-branch" title={card.path}>⑂ {cardBranch(card)}</span>
          <span class="task-card-agent">
            {#if card.agent}<HarnessIcon agent={card.agent} size={14} />{/if}
            {card.agentName}
            <ActivityStatus status={unavailable ? 'offline' : card.status} compact />
          </span>
          <span class="task-card-event">{card.latestEvent}</span>
        </button>
        <dl class="task-card-facts">
          <div>
            <dt>Changes</dt>
            <dd>{metadata[card.path]?.changedFiles ?? '—'}</dd>
          </div>
          <div>
            <dt>Checks</dt>
            <dd data-state={visibleCheckState(card)}>{checkLabel(card)}</dd>
          </div>
        </dl>
        {#if unavailable}<p class="task-card-unavailable" role="status">
            Unavailable · {unavailable}
          </p>{/if}
        <button class="task-card-action" onclick={() => void openAction(card)}
          >{actionLabel(card)}</button
        >
      </article>
    {:else}
      <div class="task-overview-empty">
        <strong>No matching worktrees</strong>
        <span>Try another task, repository, branch, or agent.</span>
      </div>
    {/each}
  </section>
</main>

<style>
  .task-overview {
    min-width: 0;
    height: 100%;
    overflow: auto;
    padding: 28px;
    background: var(--surface);
  }
  .task-overview-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 20px;
    max-width: 1180px;
    margin: 0 auto 20px;
  }
  .task-overview-header h1 {
    margin: 2px 0 0;
    font-size: clamp(24px, 3vw, 36px);
    letter-spacing: -0.04em;
  }
  .task-overview-header .eyebrow {
    margin: 0;
    color: var(--shell-selected-ink);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
  }
  .task-overview-count {
    color: var(--shell-muted);
    font-size: 12px;
  }
  .task-overview-controls {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) auto auto;
    gap: 10px;
    max-width: 1180px;
    margin: 0 auto 18px;
  }
  .task-overview-search input,
  .task-overview-sort select,
  .task-overview-refresh {
    min-height: 38px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
  }
  .task-overview-search input {
    width: 100%;
    box-sizing: border-box;
    padding: 0 12px;
  }
  .task-overview-sort {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--shell-muted);
    font-size: 12px;
  }
  .task-overview-sort select {
    padding: 0 30px 0 10px;
  }
  .task-overview-refresh {
    padding: 0 13px;
    font-weight: 700;
  }
  .task-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
    align-items: start;
    gap: 14px;
    max-width: 1180px;
    margin: 0 auto;
  }
  .task-card {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-raised, var(--surface));
    box-shadow: 0 5px 18px color-mix(in srgb, var(--text) 6%, transparent);
    overflow: hidden;
  }
  .task-card.selected {
    border-color: color-mix(in srgb, var(--primary) 60%, var(--border));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .task-card-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 12px 2px 15px;
  }
  .task-card-repository {
    color: var(--shell-muted);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-card-pin {
    width: 30px;
    height: 30px;
    border: 0;
    background: transparent;
    color: var(--shell-muted);
    opacity: 0.55;
  }
  .task-card-pin.active {
    color: var(--activity-waiting);
    opacity: 1;
  }
  .task-card-main {
    display: grid;
    width: 100%;
    gap: 7px;
    padding: 3px 15px 12px;
    border: 0;
    text-align: left;
    background: transparent;
    color: inherit;
  }
  .task-card-main strong {
    overflow: hidden;
    font-size: 16px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-card-branch,
  .task-card-agent {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--shell-muted);
    font-size: 12px;
  }
  .task-card-branch {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-card-agent :global(.activity-status) {
    margin-left: auto;
  }
  .task-card-event {
    min-height: 34px;
    color: var(--text);
    font-size: 12px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .task-card-facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    margin: 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .task-card-facts div {
    padding: 9px 15px;
  }
  .task-card-facts div + div {
    border-left: 1px solid var(--border);
  }
  .task-card-facts dt {
    color: var(--shell-muted);
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .task-card-facts dd {
    margin: 3px 0 0;
    font-size: 12px;
    font-weight: 700;
  }
  .task-card-facts dd[data-state='passing'],
  .task-card-facts dd[data-state='passed'] {
    color: var(--activity-completed);
  }
  .task-card-facts dd[data-state='failing'],
  .task-card-facts dd[data-state='failed'] {
    color: var(--activity-failed);
  }
  .task-card-facts dd[data-state='pending'],
  .task-card-facts dd[data-state='running'] {
    color: var(--activity-working);
  }
  .task-card-unavailable {
    margin: 10px 15px 0;
    color: var(--activity-failed);
    font-size: 11px;
    line-height: 1.35;
  }
  .task-card-action {
    width: calc(100% - 20px);
    min-height: 34px;
    margin: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: color-mix(in srgb, var(--primary) 7%, var(--surface));
    color: var(--text);
    font-weight: 700;
  }
  .task-overview-empty {
    grid-column: 1 / -1;
    display: grid;
    place-items: center;
    gap: 6px;
    min-height: 240px;
    color: var(--shell-muted);
    text-align: center;
  }
  @media (max-width: 700px) {
    .task-overview {
      padding: 18px 14px;
    }
    .task-overview-controls {
      grid-template-columns: 1fr;
    }
    .task-overview-sort {
      justify-content: space-between;
    }
    .task-overview-sort select {
      flex: 1;
    }
  }
</style>

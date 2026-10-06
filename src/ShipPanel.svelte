<script lang="ts">
  import { tick } from 'svelte';
  import WorkerDependencyMap from './WorkerDependencyMap.svelte';
  import { resolvedWorkerModel, type ShipIssue, type ShipRun } from './lib/issue-shipping';
  import {
    ciStatus,
    dependencyIssue,
    dependencyUrl,
    gateNames,
    shipActivity,
    shipStatus,
  } from './lib/ship-progress';

  let {
    repository,
    active = true,
    runs,
    busy,
    onclose,
    onrefresh,
    onopen,
    onsettings,
  }: {
    repository: string;
    active?: boolean;
    runs: ShipRun[];
    busy: boolean;
    onclose: () => void;
    onrefresh: () => Promise<void>;
    onopen: (path: string, threadId?: string | null) => Promise<void>;
    onsettings: () => Promise<void>;
  } = $props();
  let error = $state('');
  let panel: HTMLDivElement;
  let scope = $state<'current' | 'all'>('current');
  let selectedRun = $state('');
  let selectedIssue = $state('');
  let wasActive = false;
  const visible = $derived(
    runs.filter((run) => scope === 'all' || !repository || run.repository === repository),
  );
  const run = $derived(visible.find((item) => item.id === selectedRun) ?? visible.at(-1));
  const issue = $derived(run?.issues.find((item) => item.id === selectedIssue) ?? run?.issues[0]);
  const merged = $derived(run?.issues.filter((item) => item.state === 'merged').length ?? 0);
  const issues = $derived(run?.issues ?? []);

  function issueLabel(item: ShipIssue): string {
    return item.title === `Issue #${item.number}`
      ? `#${item.number}`
      : `#${item.number} ${item.title}`;
  }

  $effect(() => {
    if (active && !wasActive) error = '';
    wasActive = active;
  });

  async function act(action: () => Promise<void>) {
    error = '';
    try {
      await action();
    } catch (cause) {
      error = String(cause);
    }
  }

  async function selectIssue(id: string) {
    selectedIssue = id;
    await tick();
    panel.querySelector<HTMLElement>('.ship-issue-detail')?.focus();
  }
</script>

{#snippet dependencies(owner: ShipRun, item: ShipIssue)}
  {#if item.dependsOn.length}<div class="ship-dependencies">
      <span>Depends on →</span>
      {#each item.dependsOn as ref (ref)}
        {@const dependency = dependencyIssue(owner, ref)}
        {@const url = dependencyUrl(owner.remote, ref)}
        {#if dependency}<button onclick={() => selectIssue(dependency.id)}
            >#{dependency.number} · {shipStatus(owner, dependency)}</button
          >
        {:else if url}<a href={url} target="_blank" rel="noreferrer"
            >{ref} · {owner.externalClosed[ref] ? 'Closed' : 'Waiting'}</a
          >
        {:else}<span>{ref} · {owner.externalClosed[ref] ? 'Closed' : 'Waiting'}</span>{/if}
      {/each}
    </div>{:else}<small>Independent issue</small>{/if}
{/snippet}

<div class="ship-panel" bind:this={panel} aria-label="Ship runs">
  <header>
    <div>
      <h2>Ship runs</h2>
      <p>{scope === 'all' || !repository ? 'All repositories' : repository}</p>
    </div>
    <div class="ship-actions">
      <button onclick={() => act(onrefresh)} disabled={busy}
        >{busy ? 'Refreshing…' : 'Refresh'}</button
      >
      <button onclick={() => act(onsettings)}>Validation settings</button>
      <button aria-label="Close Ship runs" onclick={onclose}>Close</button>
    </div>
  </header>
  {#if error}<p class="ship-error" role="alert">{error}</p>{/if}
  {#if repository}<div class="ship-scope" role="group" aria-label="Repository scope">
      <button aria-pressed={scope === 'current'} onclick={() => (scope = 'current')}
        >Current repository</button
      ><button aria-pressed={scope === 'all'} onclick={() => (scope = 'all')}
        >All repositories</button
      >
    </div>{/if}
  {#if !run}
    <section class="ship-empty">
      <h3>No Ship runs yet</h3>
      <p>Publish an issue graph from an approved plan, then choose Ship issue graph.</p>
    </section>
  {:else}
    <label class="ship-run-select"
      >Run
      <select
        value={run.id}
        onchange={(event) => {
          selectedRun = event.currentTarget.value;
          selectedIssue = '';
        }}
      >
        {#each visible as item (item.id)}<option value={item.id}
            >{item.remote} · {item.umbrella?.title ?? item.issues[0]?.title ?? 'Ship run'} · {new Date(
              item.approvedAt,
            ).toLocaleString()}</option
          >{/each}
      </select>
    </label>
    <section class="ship-summary" aria-label="Run progress">
      <div>
        <h3>{run.umbrella?.title ?? run.issues[0]?.title ?? 'Ship run'}</h3>
        {#if run.umbrella}<a href={run.umbrella.url} target="_blank" rel="noreferrer"
            >Umbrella #{run.umbrella.number}</a
          >{/if}
        <p>{run.remote} · {run.provider} · up to {run.limit} workers</p>
      </div>
      <div>
        <strong>{merged} / {run.issues.length} merged</strong><progress
          value={merged}
          max={run.issues.length || 1}
          aria-label="Merged issues"
        ></progress>
        <p>
          {run.issues.filter((item) => ['starting', 'working'].includes(item.state)).length} active ·
          {run.issues.filter((item) => ['Blocked', 'Failed'].includes(shipStatus(run, item)))
            .length} need attention
        </p>
      </div>
    </section>
    <section class="ship-now" aria-label="Current shipping activity">
      <div>
        <h3>Happening now</h3>
        <p>Latest worker, gate, blocker, and merge state for every issue.</p>
      </div>
      <div class="ship-now-list">
        {#each issues as item (item.id)}
          {@const activity = shipActivity(run, item)}
          <button
            class="ship-now-item"
            data-state={activity.state}
            aria-pressed={item.id === issue?.id}
            onclick={() => selectIssue(item.id)}
          >
            <strong>{issueLabel(item)}</strong>
            <span>{activity.title}</span>
            <small>{activity.detail}</small>
            {#if activity.at}<time datetime={new Date(activity.at).toISOString()}
                >Last signal {new Date(activity.at).toLocaleTimeString()}</time
              >{/if}
          </button>
        {:else}<p class="ship-muted">No shipping work is active.</p>{/each}
      </div>
    </section>
    <WorkerDependencyMap {run} selected={issue?.id} onselect={selectIssue} {onopen} />
    <div class="ship-content">
      {#if issue}
        <section
          class="ship-issue-detail"
          tabindex="-1"
          aria-label={`Issue ${issue.number} details`}
        >
          <h3>Issue details</h3>
          {#if issue.blockedReason || issue.error}<p class="ship-error" role="status">
              {issue.blockedReason || issue.error}
            </p>{/if}
          {#if issue.state === 'pending' && issue.dependsOn.some((ref) => dependencyIssue(run, ref)?.state === 'failed')}<p
              class="ship-error"
            >
              Waiting for failed dependencies to recover. Independent issues continue.
            </p>{/if}
          {#if issue.refreshError}<p class="ship-error" role="status">
              Refresh failed: {issue.refreshError}. Showing last known state.
            </p>{/if}
          <p class="ship-muted">
            {issue.refreshedAt
              ? `Last refreshed ${new Date(issue.refreshedAt).toLocaleString()}`
              : 'Not refreshed yet'}
          </p>
          <div class="ship-actions">
            <a href={issue.url} target="_blank" rel="noreferrer">Open GitHub issue</a>
            <button
              disabled={!issue.path || issue.worktreeUnavailable}
              onclick={() => act(() => onopen(issue!.path!))}>Open worktree</button
            >
            <button
              disabled={!issue.path || !issue.threadId || issue.worktreeUnavailable}
              onclick={() => act(() => onopen(issue!.path!, issue!.threadId))}
              >Open worker session</button
            >
            {#if issue.pullRequest}<a href={issue.pullRequest} target="_blank" rel="noreferrer"
                >Open PR</a
              >{/if}
          </div>
          <p class="ship-path">
            {issue.worktreeUnavailable
              ? `Worktree unavailable: ${issue.path}`
              : (issue.path ??
                (issue.state === 'merged'
                  ? 'Worktree removed after merge'
                  : 'Worktree not created'))} ·
            {issue.branch}
          </p>
          {#if issue.archivePath}<p class="ship-path">Archived files: {issue.archivePath}</p>{/if}
          {@render dependencies(run, issue)}
          <h4>Implementation</h4>
          <p>Worker: {run.provider} / {resolvedWorkerModel(issue) ?? 'Unknown model'}</p>
          <p>
            Models that changed files: {issue.models?.join(', ') ||
              (resolvedWorkerModel(issue)
                ? `Awaiting file-change attribution from ${resolvedWorkerModel(issue)}`
                : 'Awaiting worker model attribution')}{issue.modelUncertain
              ? ' · Attribution uncertain'
              : ''}
          </p>
          <h4>Validation gates</h4>
          <ol class="ship-gates">
            {#each gateNames as name (name)}
              <li>
                <strong>{name.replaceAll('-', ' ')}</strong>
                {#each (issue.gates ?? []).filter((gate) => gate.gate === name) as gate (gate.id)}
                  <div class="ship-gate">
                    <span>{gate.state} · {gate.verdict ?? 'No verdict reported'}</span>
                    <span
                      >{gate.provider} / {gate.model ??
                        `Unverified (requested ${gate.requestedModel})`}</span
                    >
                    {#if gate.reason || gate.error}<span class="ship-error"
                        >{gate.reason || gate.error}</span
                      >{/if}
                    <button
                      disabled={!issue.path || !gate.threadId}
                      onclick={() => act(() => onopen(gate.directory!, gate.threadId))}
                      >Open gate session</button
                    >
                  </div>
                {:else}<p class="ship-muted">Not started / no recorded history</p>{/each}
              </li>
            {/each}
          </ol>
          <details class="ship-checks">
            <summary>CI: {ciStatus(issue.checks)}</summary>
            {#each issue.checks ?? [] as check, index (`${index}:${check.name}`)}<p>
                <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> · {check.state}
              </p>{:else}<p>No check results recorded.</p>{/each}
          </details>
          <details>
            <summary>Stage history</summary>
            <ol>
              {#each issue.events ?? [] as event, index (index)}<li>
                  {new Date(event.at).toLocaleTimeString()} · {event.stage}{event.reason
                    ? ` — ${event.reason}`
                    : ''}
                </li>{:else}<li>No stage history recorded.</li>{/each}
            </ol>
          </details>
        </section>{/if}
    </div>
  {/if}
</div>

<style>
  .ship-panel {
    box-sizing: border-box;
    height: 100%;
    overflow: auto;
    padding: 16px;
    background: var(--sui-surface);
    color: var(--sui-foreground);
  }
  :global(.native-details) .ship-panel {
    flex: 1;
    min-height: 0;
    height: auto;
  }
  header,
  .ship-summary {
    display: flex;
    flex-direction: column;
    gap: 20px;
    align-items: start;
  }
  .ship-now {
    display: grid;
    gap: 12px;
    margin-top: 20px;
  }
  .ship-now h3,
  .ship-now p {
    margin: 0;
  }
  .ship-now-list {
    display: grid;
    gap: 8px;
  }
  .ship-now-item {
    display: grid;
    gap: 4px;
    padding: 12px;
    text-align: left;
    border-left: 3px solid var(--sui-primary);
  }
  .ship-now-item[data-state='blocked'] {
    border-left-color: var(--sui-danger);
  }
  .ship-now-item[data-state='waiting'] {
    border-left-color: var(--sui-warning, var(--sui-primary));
  }
  .ship-now-item time {
    opacity: 0.7;
    font-size: 12px;
  }
  h2,
  h3 {
    margin: 0 0 8px;
  }
  p {
    margin: 8px 0;
  }
  a {
    color: var(--sui-primary);
  }
  button,
  select {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--shell-divider);
    border-radius: 6px;
    padding: 7px 10px;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ship-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .ship-run-select {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 20px 0;
    align-items: center;
  }
  .ship-scope {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
  .ship-scope button[aria-pressed='true'] {
    border-color: var(--sui-primary);
    color: var(--sui-primary);
  }
  select {
    min-width: 0;
    flex: 1;
  }
  .ship-summary {
    padding: 16px 0;
    border-block: 1px solid var(--shell-divider);
  }
  progress {
    display: block;
    width: 100%;
    margin-top: 8px;
  }
  .ship-content {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
    margin-top: 20px;
  }
  .ship-dependencies {
    display: grid;
    gap: 6px;
    font-size: 12px;
  }
  .ship-dependencies button {
    text-align: left;
  }
  .ship-error {
    color: var(--sui-danger);
    overflow-wrap: anywhere;
  }
  .ship-muted,
  small,
  .ship-path {
    opacity: 0.7;
    font-size: 12px;
  }
  .ship-path,
  header p {
    overflow-wrap: anywhere;
  }
  .ship-gates {
    padding-left: 22px;
  }
  .ship-gates > li {
    margin-bottom: 16px;
  }
  .ship-gate {
    display: grid;
    justify-items: start;
    gap: 6px;
    margin: 8px 0;
    padding-left: 12px;
    border-left: 2px solid var(--shell-divider);
  }
  details {
    padding: 12px 0;
    border-top: 1px solid var(--shell-divider);
  }
  summary {
    cursor: pointer;
  }
  .ship-empty {
    padding: 40px 0;
  }
</style>

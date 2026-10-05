<script lang="ts">
  import { tick } from 'svelte';
  import type { ShipIssue, ShipRun } from './lib/issue-shipping';
  import {
    ciStatus,
    dependencyIssue,
    dependencyUrl,
    gateNames,
    shipStatus,
  } from './lib/ship-progress';

  let {
    open,
    repository,
    runs,
    busy,
    onclose,
    onrefresh,
    onopen,
    onsettings,
  }: {
    open: boolean;
    repository: string;
    runs: ShipRun[];
    busy: boolean;
    onclose: () => void;
    onrefresh: () => Promise<void>;
    onopen: (path: string, threadId?: string | null) => Promise<void>;
    onsettings: () => Promise<void>;
  } = $props();
  let dialog: HTMLDialogElement;
  let error = $state('');
  let selectedRun = $state('');
  let selectedIssue = $state('');
  const visible = $derived(runs.filter((run) => !repository || run.repository === repository));
  const run = $derived(visible.find((item) => item.id === selectedRun) ?? visible.at(-1));
  const issue = $derived(run?.issues.find((item) => item.id === selectedIssue) ?? run?.issues[0]);
  const merged = $derived(run?.issues.filter((item) => item.state === 'merged').length ?? 0);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      error = '';
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
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
    dialog.querySelector<HTMLElement>('.ship-issue-detail')?.focus();
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

<dialog class="ship-panel" bind:this={dialog} {onclose} aria-labelledby="ship-title">
  <header>
    <div>
      <h2 id="ship-title">Ship runs</h2>
      <p>{repository || 'All repositories'}</p>
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
    <div class="ship-content">
      <nav class="ship-graph" aria-label="Issue dependency graph">
        {#each run.issues as item (item.id)}
          <div
            class="ship-node"
            class:selected={item.id === issue?.id}
            data-state={shipStatus(run, item)}
          >
            <button
              class="ship-node-select"
              aria-pressed={item.id === issue?.id}
              onclick={() => selectIssue(item.id)}
              ><strong>#{item.number} {item.title}</strong><span class="ship-status"
                >{shipStatus(run, item)}</span
              ></button
            >
            {@render dependencies(run, item)}
          </div>
        {/each}
      </nav>
      {#if issue}<section
          class="ship-issue-detail"
          tabindex="-1"
          aria-label={`Issue ${issue.number} details`}
        >
          <h3>
            <a href={issue.url} target="_blank" rel="noreferrer">#{issue.number} {issue.title}</a>
          </h3>
          <p>
            <strong>{shipStatus(run, issue)}</strong> · Stage: {issue.stage?.replaceAll('_', ' ') ??
              issue.state.replaceAll('_', ' ')} · GitHub issue: {issue.issueState ?? 'Unknown'}
          </p>
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
            <button disabled={!issue.path} onclick={() => act(() => onopen(issue!.path!))}
              >Open worktree</button
            >
            <button
              disabled={!issue.path || !issue.threadId}
              onclick={() => act(() => onopen(issue!.path!, issue!.threadId))}
              >Open worker session</button
            >
            {#if issue.pullRequest}<a href={issue.pullRequest} target="_blank" rel="noreferrer"
                >Open PR</a
              >{/if}
          </div>
          <p class="ship-path">
            {issue.path ??
              (issue.state === 'merged' ? 'Worktree removed after merge' : 'Worktree not created')} ·
            {issue.branch}
          </p>
          {#if issue.archivePath}<p class="ship-path">Archived files: {issue.archivePath}</p>{/if}
          {@render dependencies(run, issue)}
          <h4>Implementation</h4>
          <p>Worker: {run.provider} / {issue.workerModel ?? 'Unknown model'}</p>
          <p>
            Models that changed files: {issue.models?.join(', ') ||
              'Not recorded'}{issue.modelUncertain ? ' · Attribution uncertain' : ''}
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
</dialog>

<style>
  .ship-panel {
    width: min(1120px, 94vw);
    max-height: 90vh;
    padding: 24px;
    border: 1px solid var(--shell-divider);
    border-radius: 12px;
    background: var(--sui-surface);
    color: var(--sui-foreground);
  }
  .ship-panel::backdrop {
    background: #0008;
  }
  header,
  .ship-summary {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    align-items: start;
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
    gap: 12px;
    margin: 20px 0;
    align-items: center;
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
    grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr);
    gap: 24px;
    margin-top: 20px;
  }
  .ship-node {
    padding: 12px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
    margin-bottom: 12px;
  }
  .ship-node.selected {
    border-color: var(--sui-primary);
  }
  .ship-node-select {
    display: grid;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    padding: 0 0 8px;
  }
  .ship-status {
    font-size: 12px;
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
  @media (max-width: 750px) {
    header,
    .ship-summary {
      flex-direction: column;
    }
    .ship-content {
      grid-template-columns: 1fr;
    }
  }
</style>

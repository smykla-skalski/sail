<script lang="ts">
  import ActivityStatus from './ActivityStatus.svelte';
  import ShipActions from './ShipActions.svelte';
  import { locationName } from './lib/command-palette';
  import type { MergeOwner, ShipIssue, ShipRun } from './lib/issue-shipping';
  import {
    shipPoolHint,
    shipPoolLabel,
    shipPoolUsage,
    type ShipActionId,
  } from './lib/ship-actions';
  import { shipArchiveNoticeText } from './lib/ship-archive';
  import { shipGroupLabels, shipRowName } from './lib/ship-list';
  import { shipQueueHiddenDone, shipQueueRows, shipQueueRuns, shipRunName } from './lib/ship-queue';

  let {
    runs,
    busy,
    mergeOwner = 'you',
    archiveNotice = 0,
    onrefresh,
    onopen,
    onaction,
    ondismissnotice,
    onsettings,
    onclose,
  }: {
    runs: ShipRun[];
    busy: boolean;
    mergeOwner?: MergeOwner;
    archiveNotice?: number;
    onrefresh: () => Promise<void>;
    onopen: (runId: string, issueId: string) => void;
    onaction: (id: ShipActionId, run: ShipRun, issue: ShipIssue | null) => Promise<string>;
    ondismissnotice: () => void;
    onsettings: () => Promise<void>;
    onclose: () => void;
  } = $props();

  let archived = $state(false);
  let runId = $state('');
  let showDone = $state(false);
  let message = $state('');
  let failed = $state(false);

  const options = $derived({ mergeOwner });
  const scoped = $derived(shipQueueRuns(runs, { repository: null, archived }));
  const archivedCount = $derived(runs.filter((run) => run.archivedAt !== undefined).length);
  const selected = $derived(scoped.find((run) => run.id === runId) ?? null);
  const rows = $derived(
    shipQueueRows(scoped, { runId: selected?.id ?? null, showDone, archived }, options),
  );
  const hiddenDone = $derived(archived || showDone ? 0 : shipQueueHiddenDone(scoped, options));
  const usage = $derived(shipPoolUsage(runs));

  function result(text: string, isFailure: boolean) {
    message = text;
    failed = isFailure;
  }

  async function refresh() {
    try {
      await onrefresh();
      result('', false);
    } catch (cause) {
      result(String(cause), true);
    }
  }

  function showArchived() {
    archived = true;
    runId = '';
    ondismissnotice();
  }
</script>

<section class="ship-queue" aria-label="Ship queue">
  <header class="queue-header">
    <div>
      <p class="eyebrow">ALL REPOSITORIES</p>
      <h1>Ship queue</h1>
    </div>
    <div class="queue-tools">
      <p class="queue-pool" title={shipPoolHint} data-testid="ship-pool">{shipPoolLabel(usage)}</p>
      <button onclick={refresh} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      <button onclick={() => void onsettings()}>Archive settings</button>
      <button onclick={onclose}>Back to workspace</button>
    </div>
  </header>
  {#if archiveNotice > 0}<p class="queue-notice" role="status" data-ship-archive-notice>
      {shipArchiveNoticeText(archiveNotice)} ·
      <button class="queue-link" onclick={showArchived}>Show</button>
      <button class="queue-link" aria-label="Dismiss archive notice" onclick={ondismissnotice}
        >Dismiss</button
      >
    </p>{/if}
  {#if message}<p class:queue-error={failed} role={failed ? 'alert' : 'status'} data-ship-result>
      {message}
    </p>{/if}
  <div class="queue-filters">
    <div role="group" aria-label="Run state">
      <button
        aria-pressed={!archived}
        onclick={() => {
          archived = false;
          runId = '';
        }}>Active</button
      ><button
        aria-pressed={archived}
        onclick={() => {
          archived = true;
          runId = '';
        }}>Archived ({archivedCount})</button
      >
    </div>
    <label
      >Run
      <select bind:value={runId} aria-label="Filter by run">
        <option value="">All runs ({scoped.length})</option>
        {#each scoped as run (run.id)}
          <option value={run.id}>{shipRunName(run)} · {run.remote}</option>
        {/each}
      </select>
    </label>
    {#if !archived}<label class="queue-check"
        ><input type="checkbox" bind:checked={showDone} /> Show merged and closed{hiddenDone
          ? ` (${hiddenDone})`
          : ''}</label
      >{/if}
    {#if selected}<span class="queue-run-actions"
        ><ShipActions run={selected} {onaction} onresult={result} /></span
      >{/if}
  </div>
  {#if rows.length}
    <table>
      <caption class="queue-caption"
        >Issues across {scoped.length} {scoped.length === 1 ? 'run' : 'runs'}</caption
      >
      <thead>
        <tr>
          <th scope="col">Issue</th>
          <th scope="col">Run</th>
          <th scope="col">State</th>
          <th scope="col">Next</th>
          <th scope="col">Pull request</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (`${row.run.id}:${row.issue.id}`)}
          <tr data-ship-issue-id={row.issue.id} data-group={row.group}>
            <th scope="row">
              <button
                class="queue-link"
                aria-label={`Open ${shipRowName(row)}`}
                onclick={() => onopen(row.run.id, row.issue.id)}
                >#{row.issue.number}
                {row.issue.title === `Issue #${row.issue.number}` ? '' : row.issue.title}</button
              >
              <small>{shipGroupLabels[row.group]}</small>
            </th>
            <td>
              <span class="queue-run">{shipRunName(row.run)}</span>
              <small>{locationName(row.run.repository)} · {row.run.remote}</small>
              {#if archived}<ShipActions run={row.run} {onaction} onresult={result} />{/if}
            </td>
            <td
              ><ActivityStatus
                status={row.presentation.status}
                label={row.presentation.label}
                compact
              /></td
            >
            <td class="queue-line" data-kind={row.line.kind}>{row.line.text}</td>
            <td
              >{#if row.issue.pullRequest}<a
                  href={row.issue.pullRequest}
                  target="_blank"
                  rel="noreferrer">Open PR</a
                >{:else}<small>None</small>{/if}</td
            >
            <td>
              <div class="queue-action-list">
                <ShipActions run={row.run} issue={row.issue} {onaction} onresult={result} />
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if archived}
    <p class="queue-empty">No archived runs.</p>
  {:else if scoped.length}
    <p class="queue-empty">
      All issues are merged or closed ·
      <button class="queue-link" onclick={() => (showDone = true)}>Show merged and closed</button>
    </p>
  {:else}
    <p class="queue-empty">No Ship runs yet. Ask an agent to run <code>/ship-it</code>.</p>
  {/if}
</section>

<style>
  .ship-queue {
    box-sizing: border-box;
    min-width: 0;
    height: 100%;
    overflow: auto;
    padding: 28px;
    background: var(--sui-canvas);
    color: var(--sui-foreground);
  }
  .queue-header {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: 12px 20px;
    margin-bottom: 16px;
  }
  .queue-header h1 {
    margin: 2px 0 0;
    font-size: clamp(24px, 3vw, 36px);
    letter-spacing: -0.04em;
  }
  .eyebrow {
    margin: 0;
    color: var(--shell-selected-ink);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
  }
  .queue-tools,
  .queue-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .queue-filters {
    margin-bottom: 16px;
  }
  .queue-pool {
    margin: 0;
    color: var(--shell-muted);
    font-size: 12px;
  }
  .queue-notice,
  .queue-error {
    margin: 0 0 12px;
  }
  .queue-error {
    color: var(--sui-danger);
  }
  .queue-check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .queue-caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  th,
  td {
    padding: 8px 10px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--shell-divider);
    overflow-wrap: anywhere;
  }
  thead th {
    color: var(--shell-muted);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  tbody th {
    font-weight: 600;
  }
  small {
    display: block;
    color: var(--shell-muted);
    font-size: 11px;
    font-weight: 400;
  }
  .queue-run {
    display: block;
  }
  .queue-line {
    max-width: 36ch;
    color: var(--shell-muted);
  }
  .queue-line[data-kind='blocker'] {
    color: var(--sui-danger);
  }
  .queue-action-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  tr[data-group='needs-input'] th {
    box-shadow: inset 3px 0 0 var(--activity-waiting);
  }
  .queue-empty {
    padding: 24px 0;
  }
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--shell-divider);
    border-radius: 6px;
    padding: 5px 10px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button[aria-pressed='true'] {
    border-color: var(--sui-primary);
    color: var(--sui-primary);
  }
  button.queue-link {
    padding: 2px 4px;
    border: 0;
    color: var(--sui-primary);
    text-align: left;
    text-decoration: underline;
  }
  a {
    color: var(--sui-primary);
  }
  button:focus-visible,
  a:focus-visible,
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--sui-primary);
    outline-offset: 2px;
  }
</style>

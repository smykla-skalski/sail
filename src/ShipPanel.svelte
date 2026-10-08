<script lang="ts">
  import { tick } from 'svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import WorkerDependencyMap from './WorkerDependencyMap.svelte';
  import { resolvedWorkerModel, type ShipIssue, type ShipRun } from './lib/issue-shipping';
  import type { NativeSubagent } from './lib/native-subagents';
  import {
    ciStatus,
    dependencyIssue,
    dependencyUrl,
    gateNames,
    shipActivity,
    shipEvidenceReadiness,
    shipIssuePresentation,
    shipMergeClaim,
    shipStatus,
    sortShipIssues,
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
    nativeSubagents = [],
  }: {
    repository: string;
    active?: boolean;
    runs: ShipRun[];
    busy: boolean;
    onclose: () => void;
    onrefresh: () => Promise<void>;
    onopen: (path: string, threadId?: string | null) => Promise<void>;
    onsettings: () => Promise<void>;
    nativeSubagents?: NativeSubagent[];
  } = $props();
  let error = $state('');
  let panel: HTMLDivElement;
  let scope = $state<'current' | 'all'>('current');
  let selectedRun = $state('');
  let selectedIssue = $state('');
  const detailId = `ship-selected-issue-${crypto.randomUUID()}`;
  let wasActive = false;
  const visible = $derived(
    runs.filter((run) => scope === 'all' || !repository || run.repository === repository),
  );
  const orderedRuns = $derived(
    visible.toSorted((left, right) => right.approvedAt - left.approvedAt),
  );
  const run = $derived(orderedRuns.find((item) => item.id === selectedRun) ?? orderedRuns[0]);
  const issue = $derived(
    run?.issues.find((item) => item.id === selectedIssue) ??
      (run ? sortShipIssues(run)[0] : undefined),
  );
  const merged = $derived(run?.issues.filter((item) => item.state === 'merged').length ?? 0);
  const issues = $derived(run ? sortShipIssues(run) : []);

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
    const scrollTop = panel.scrollTop;
    selectedIssue = id;
    await tick();
    panel.scrollTop = scrollTop;
  }

  function runPresentation(item: ShipRun) {
    const first = sortShipIssues(item)[0];
    return first
      ? shipIssuePresentation(item, first)
      : {
          status: 'completed',
          label: 'Empty',
          priority: 4,
          nextAction: 'No issues',
          updated: null,
        };
  }

  function workerClaim(item: ShipIssue): string {
    if (item.state === 'merged') return 'Complete';
    if (!item.workerState) {
      if (item.workerSettled) return 'Complete';
      return item.threadId ? 'Unknown' : 'Not started';
    }
    const label = item.workerState.replaceAll('_', ' ');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function gateClaim(item: ShipIssue): string {
    const gates = item.gates ?? [];
    if (!gates.length) return 'Not started';
    const latest = gates.toSorted((left, right) => right.updated - left.updated)[0];
    return `${latest.gate.replaceAll('-', ' ')} · ${latest.verdict ?? latest.state}`;
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
    <section class="ship-run-chooser" aria-label="Choose Ship run">
      <h3>Runs</h3>
      <div class="ship-run-list">
        {#each orderedRuns as item (item.id)}
          {@const presentation = runPresentation(item)}
          <button
            class="ship-run-option"
            aria-pressed={item.id === run.id}
            onclick={() => {
              selectedRun = item.id;
              selectedIssue = '';
            }}
          >
            <span class="ship-run-task"
              ><strong>{item.umbrella?.title ?? item.issues[0]?.title ?? 'Ship run'}</strong>
              <ActivityStatus
                status={presentation.status}
                label={presentation.label}
                compact
              /></span
            >
            <span class="ship-run-meta"
              ><span>{item.remote}</span><time datetime={new Date(item.approvedAt).toISOString()}
                >Launched {new Date(item.approvedAt).toLocaleString()}</time
              ></span
            >
          </button>
        {/each}
      </div>
    </section>
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
    <section class="ship-now" aria-label="Shipping issues">
      <div>
        <h3>Issues</h3>
        <p>Needs attention first. Each claim comes from its recorded source.</p>
      </div>
      <div class="ship-now-list">
        {#each issues as item (item.id)}
          {@const activity = shipActivity(run, item)}
          {@const presentation = shipIssuePresentation(run, item)}
          <button
            class="ship-now-item"
            data-state={presentation.status}
            data-ship-issue-id={item.id}
            aria-pressed={item.id === issue?.id}
            aria-controls={detailId}
            onclick={() => selectIssue(item.id)}
          >
            <span class="ship-issue-heading"
              ><strong>{issueLabel(item)}</strong><ActivityStatus
                status={presentation.status}
                label={presentation.label}
                compact
              /></span
            >
            <span class="ship-latest"><b>Latest</b> {activity.title} · {activity.detail}</span>
            <span class="ship-next"><b>Next</b> {presentation.nextAction}</span>
            <span class="ship-claims" aria-label={`Issue ${item.number} recorded states`}>
              <span><b>Worker</b>{workerClaim(item)}</span>
              <span><b>Review</b>{gateClaim(item)}</span>
              <span><b>CI</b>{ciStatus(item.checks)}</span>
              <span><b>Merge</b>{shipMergeClaim(item)}</span>
            </span>
            <time datetime={new Date(presentation.updated ?? run.approvedAt).toISOString()}
              >{presentation.updated
                ? `Updated ${new Date(presentation.updated).toLocaleString()}`
                : 'No confirmed update'}</time
            >
          </button>
        {:else}<p class="ship-muted">No shipping work is active.</p>{/each}
      </div>
    </section>
    <WorkerDependencyMap
      {run}
      {nativeSubagents}
      selected={issue?.id}
      onselect={selectIssue}
      {onopen}
    />
    <div class="ship-content">
      {#if issue}
        {@const evidence = shipEvidenceReadiness(issue)}
        {@const manifest = (issue.evidenceManifests ?? []).find(
          (candidate) => candidate.revision === issue.evidenceRevision && !candidate.stale,
        )}
        <section
          id={detailId}
          class="ship-issue-detail"
          tabindex="-1"
          aria-label={`Issue ${issue.number} details`}
        >
          <h3>{issueLabel(issue)}</h3>
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
          <h4>Revision evidence</h4>
          <p class:ship-error={!evidence.ready}>
            {issue.evidenceRevision ?? 'Revision unknown'} ·
            {evidence.ready ? 'Merge evidence ready' : evidence.reason}
          </p>
          <ol class="ship-gates">
            {#each issue.checkpoint?.acceptanceCriteria ?? [] as criterion (criterion)}
              <li>
                <strong
                  >{evidence.unverifiedCriteria.includes(criterion)
                    ? 'Unverified'
                    : 'Verified'}</strong
                >
                <span>{criterion}</span>
              </li>
            {:else}<li>Acceptance criteria not recorded.</li>{/each}
          </ol>
          <details>
            <summary>Evidence manifest ({manifest?.evidence.length ?? 0})</summary>
            {#each manifest?.evidence ?? [] as item (item.id)}
              <p>
                {item.kind}: {item.name} · {item.result} · {item.provider} / {item.model ??
                  'No model'}
                · {new Date(item.timestamp).toLocaleString()} · {item.outputReference}
              </p>
            {:else}<p>No evidence recorded for this revision.</p>{/each}
          </details>
          <h4>Validation policy</h4>
          {#if issue.validationPolicy}
            <dl class="ship-policy">
              <div>
                <dt>Selected risk</dt>
                <dd>{issue.validationPolicy.risk}</dd>
              </div>
              <div>
                <dt>Required gates</dt>
                <dd>{issue.validationPolicy.requiredGates.join(', ') || 'None'}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>{issue.validationPolicy.revision}</dd>
              </div>
              <div>
                <dt>Policy source</dt>
                <dd>{issue.validationPolicy.sources.join(' · ')}</dd>
              </div>
            </dl>
          {:else}<p class="ship-muted">Risk not selected. Validation cannot start.</p>{/if}
          <h4>Validation gates</h4>
          <ol class="ship-gates">
            {#each gateNames as name (name)}
              <li>
                <strong>{name.replaceAll('-', ' ')}</strong
                >{issue.validationPolicy?.requiredGates.includes(name)
                  ? ' · Required'
                  : ' · Not required'}
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
    overflow-x: hidden;
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
    min-width: 0;
    gap: 7px;
    padding: 12px;
    text-align: left;
    border-left: 3px solid var(--sui-primary);
    overflow-wrap: anywhere;
  }
  .ship-now-item[aria-pressed='true'],
  .ship-run-option[aria-pressed='true'] {
    border-color: var(--sui-primary);
    background: color-mix(in srgb, var(--sui-primary) 7%, transparent);
  }
  .ship-now-item[data-state='failed'],
  .ship-now-item[data-state='offline'] {
    border-left-color: var(--sui-danger);
  }
  .ship-now-item[data-state='waiting'] {
    border-left-color: var(--sui-warning, var(--sui-primary));
  }
  .ship-issue-heading,
  .ship-run-task,
  .ship-run-meta {
    display: flex;
    min-width: 0;
    gap: 8px;
    align-items: start;
    justify-content: space-between;
  }
  .ship-issue-heading strong,
  .ship-run-task strong,
  .ship-run-meta span,
  .ship-run-meta time {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .ship-latest,
  .ship-next {
    line-height: 1.4;
  }
  .ship-latest b,
  .ship-next b {
    display: inline-block;
    min-width: 42px;
    color: var(--sui-muted);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .ship-claims {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .ship-claims > span {
    display: grid;
    min-width: 0;
    gap: 2px;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--sui-foreground) 4%, transparent);
    overflow-wrap: anywhere;
    font-size: 11px;
  }
  .ship-claims b {
    color: var(--sui-muted);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
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
  button {
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
  .ship-run-chooser {
    display: grid;
    gap: 8px;
    margin: 20px 0;
  }
  .ship-run-list {
    display: grid;
    gap: 6px;
  }
  .ship-run-option {
    display: grid;
    min-width: 0;
    gap: 6px;
    padding: 10px 12px;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .ship-run-meta {
    color: var(--sui-muted);
    font-size: 11px;
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
  .ship-issue-detail {
    min-width: 0;
    overflow-wrap: anywhere;
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

  .ship-policy {
    display: grid;
    gap: 0.4rem;
    margin: 0;
  }

  .ship-policy div {
    display: grid;
    grid-template-columns: minmax(7rem, auto) 1fr;
    gap: 0.65rem;
  }

  .ship-policy dt {
    color: var(--sui-text-muted);
  }

  .ship-policy dd {
    margin: 0;
    overflow-wrap: anywhere;
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
  @media (max-width: 520px) {
    .ship-panel {
      padding: 12px;
    }
    .ship-claims {
      grid-template-columns: minmax(0, 1fr);
    }
    .ship-issue-heading,
    .ship-run-task,
    .ship-run-meta {
      flex-direction: column;
      gap: 5px;
    }
  }
</style>

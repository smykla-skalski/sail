<script lang="ts">
  import { tick } from 'svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import ShipActions from './ShipActions.svelte';
  import WorkerDependencyMap from './WorkerDependencyMap.svelte';
  import { locationName } from './lib/command-palette';
  import {
    resolvedWorkerModel,
    type MergeOwner,
    type ShipIssue,
    type ShipRun,
  } from './lib/issue-shipping';
  import type { NativeSubagent } from './lib/native-subagents';
  import type { ShipActionId } from './lib/ship-actions';
  import { shipArchiveNoticeText, shipRunArchived } from './lib/ship-archive';
  import {
    ciStatus,
    dependencyIssue,
    dependencyUrl,
    gateNames,
    shipBlock,
    shipClosedBeforeLaunch,
    shipEvidenceReadiness,
    shipStatus,
  } from './lib/ship-progress';
  import {
    adjacentRowId,
    shipAllMerged,
    shipDeliveryMismatch,
    shipGroups,
    shipOrderSnapshot,
    shipRowLine,
    shipRowName,
    shipRows,
    shipSplitWidth,
    shipStageIndicator,
    shipTaskCriteria,
    shipTaskObjective,
    type ShipOrderSnapshot,
    type ShipRow,
  } from './lib/ship-list';
  import {
    exportTaskEconomics,
    summarizeTaskEconomics,
    totalEconomicsTokens,
    type TaskEconomicsSummary,
  } from './lib/task-economics.ts';

  let {
    repository,
    active = true,
    runs,
    busy,
    mergeOwner = 'you',
    onclose,
    onrefresh,
    onopen,
    onsettings,
    onhandoff,
    onaction,
    ondismissnotice,
    archiveNotice = 0,
    nativeSubagents = [],
    focusRequest = null,
  }: {
    repository: string;
    active?: boolean;
    runs: ShipRun[];
    busy: boolean;
    mergeOwner?: MergeOwner;
    onclose: () => void;
    onrefresh: () => Promise<void>;
    onopen: (path: string, threadId?: string | null) => Promise<void>;
    onsettings: () => Promise<void>;
    onhandoff: (run: ShipRun, issue: ShipIssue) => Promise<void>;
    onaction: (id: ShipActionId, run: ShipRun, issue: ShipIssue | null) => Promise<string>;
    ondismissnotice: () => void;
    archiveNotice?: number;
    nativeSubagents?: NativeSubagent[];
    focusRequest?: {
      id: number;
      runId: string;
      issueId: string;
      focus: 'issue' | 'pull-request';
    } | null;
  } = $props();
  let error = $state('');
  let panel: HTMLDivElement;
  let listElement = $state<HTMLElement>();
  let heading = $state<HTMLElement>();
  let panelWidth = $state(0);
  let scope = $state<'current' | 'all'>('current');
  let selectedRun = $state('');
  let selectedIssue = $state('');
  let detailOpen = $state(false);
  let view = $state<'list' | 'graph'>('list');
  let showDone = $state(false);
  let showArchived = $state(false);
  let result = $state({ text: '', failed: false });
  let focusedId = $state('');
  let frozen = $state<ShipOrderSnapshot | null>(null);
  const detailId = `ship-selected-issue-${crypto.randomUUID()}`;
  const headingId = `${detailId}-heading`;
  let wasActive = false;
  const wide = $derived(panelWidth >= shipSplitWidth);
  const inScope = $derived(
    runs.filter((run) => scope === 'all' || !repository || run.repository === repository),
  );
  const archivedCount = $derived(inScope.filter((run) => shipRunArchived(run)).length);
  const visible = $derived(inScope.filter((run) => shipRunArchived(run) === showArchived));
  const orderedRuns = $derived(
    visible.toSorted((left, right) => right.approvedAt - left.approvedAt),
  );
  const run = $derived(orderedRuns.find((item) => item.id === selectedRun) ?? orderedRuns[0]);
  const rows = $derived(run ? shipRows(run, { mergeOwner }, frozen) : []);
  const pinned = $derived(new Set([selectedIssue, focusedId].filter(Boolean)));
  const groups = $derived(shipGroups(rows, { showDone, pinned }));
  const visibleIds = $derived(groups.flatMap((group) => group.rows.map((row) => row.issue.id)));
  const issue = $derived(
    run?.issues.find((item) => item.id === selectedIssue) ??
      (wide ? rows.find((row) => row.group !== 'done')?.issue : undefined),
  );
  const merged = $derived(run?.issues.filter((item) => item.state === 'merged').length ?? 0);
  const allDone = $derived(!!run && shipAllMerged(run, { mergeOwner }));
  const doneCount = $derived(rows.filter((row) => row.group === 'done').length);
  const showDetail = $derived(!!issue && view === 'list' && (wide || detailOpen));
  const showList = $derived(view === 'graph' || wide || !detailOpen);

  function issueLabel(item: ShipIssue): string {
    return item.title === `Issue #${item.number}`
      ? `#${item.number}`
      : `#${item.number} ${item.title}`;
  }

  type FocusRequest = NonNullable<typeof focusRequest>;
  let handledFocus = 0;
  let pendingFocus = $state<FocusRequest | null>(null);

  $effect(() => {
    const request = focusRequest;
    if (!request || request.id === handledFocus) return;
    handledFocus = request.id;
    selectedRun = request.runId;
    selectedIssue = request.issueId;
    detailOpen = request.focus === 'pull-request';
    view = 'list';
    pendingFocus = request;
  });

  $effect(() => {
    const request = pendingFocus;
    if (
      !request ||
      !active ||
      run?.id !== request.runId ||
      !run.issues.some((item) => item.id === request.issueId)
    )
      return;
    void focusPending(request);
  });

  async function focusPending(request: FocusRequest) {
    await tick();
    const row = panel?.querySelector<HTMLElement>(
      `[data-ship-issue-id="${CSS.escape(request.issueId)}"]`,
    );
    const link =
      request.focus === 'pull-request'
        ? panel?.querySelector<HTMLElement>('.ship-issue-detail .ship-pull-request')
        : null;
    const target = link ?? row;
    if (!target?.getClientRects().length) return;
    target.scrollIntoView({ block: 'center' });
    target.focus();
    if (pendingFocus === request) pendingFocus = null;
  }

  $effect(() => {
    if (active && !wasActive) error = '';
    wasActive = active;
  });

  $effect(() => {
    const measure = () => (panelWidth = panel.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  });

  function keydown(event: KeyboardEvent) {
    panelKeydown(event);
    listKeydown(event);
  }

  $effect(() => {
    panel.addEventListener('keydown', keydown);
    panel.addEventListener('focusin', listFocusIn);
    panel.addEventListener('focusout', listFocusOut);
    return () => {
      panel.removeEventListener('keydown', keydown);
      panel.removeEventListener('focusin', listFocusIn);
      panel.removeEventListener('focusout', listFocusOut);
    };
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
    detailOpen = true;
    await tick();
    heading?.focus();
  }

  async function returnToRow() {
    const id = issue?.id;
    detailOpen = false;
    await tick();
    if (id) panel.querySelector<HTMLElement>(`[data-ship-issue-id="${CSS.escape(id)}"]`)?.focus();
  }

  function panelKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    if (!(target instanceof Node) || !panel.querySelector(`#${detailId}`)?.contains(target)) return;
    event.preventDefault();
    void returnToRow();
  }

  function rowId(target: EventTarget | null): string {
    return target instanceof Element
      ? (target.closest<HTMLElement>('[data-ship-issue-id]')?.dataset.shipIssueId ?? '')
      : '';
  }

  function listFocusIn(event: FocusEvent) {
    const id = rowId(event.target);
    if (!id || !run || !listElement?.contains(event.target as Node)) return;
    focusedId = id;
    frozen ??= shipOrderSnapshot(shipRows(run, { mergeOwner }));
  }

  function listFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && listElement?.contains(next)) return;
    if (!(event.target instanceof Node && listElement?.contains(event.target))) return;
    focusedId = '';
    frozen = null;
  }

  function listKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    const id = rowId(event.target);
    if (!id || !listElement?.contains(event.target as Node)) return;
    event.preventDefault();
    if (event.key === 'Enter') {
      void selectIssue(id);
      return;
    }
    const next = adjacentRowId(visibleIds, id, event.key === 'ArrowDown' ? 1 : -1);
    if (next)
      listElement
        ?.querySelector<HTMLElement>(`[data-ship-issue-id="${CSS.escape(next)}"]`)
        ?.focus();
  }

  function showResult(text: string, failed: boolean) {
    result = { text, failed };
  }

  function chooseArchived(archived: boolean) {
    showArchived = archived;
    selectedRun = '';
    selectedIssue = '';
    detailOpen = false;
    showDone = false;
    frozen = null;
    if (archived) ondismissnotice();
  }

  function chooseRun(id: string) {
    selectedRun = id;
    selectedIssue = '';
    detailOpen = false;
    showDone = false;
    frozen = null;
  }

  function runPresentation(item: ShipRun) {
    const first = shipRows(item, { mergeOwner })[0];
    return first
      ? first.presentation
      : {
          status: 'completed',
          label: 'Empty',
          priority: 4,
          nextAction: 'No issues',
          updated: null,
        };
  }

  function exportEconomics(owner: ShipRun) {
    const exported = exportTaskEconomics(
      owner.issues.map((item) => ({
        task: item.id,
        acceptedRevision: item.evidenceRevision,
        manifests: item.evidenceManifests ?? [],
        outcomeAccepted: shipEvidenceReadiness(item).ready,
      })),
    );
    const link = document.createElement('a');
    const href = URL.createObjectURL(
      new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
    );
    link.href = href;
    link.download = `sail-task-economics-${owner.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }

  function duration(milliseconds: number): string {
    if (milliseconds < 1_000) return `${milliseconds} ms`;
    if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
    return `${(milliseconds / 60_000).toFixed(1)} min`;
  }

  function incompleteEconomicsReason(economics: TaskEconomicsSummary): string {
    const reasons: string[] = [];
    if (economics.missingSamples > 0)
      reasons.push(`${economics.missingSamples} evidence records lack metrics`);
    if (!economics.identityCoverageComplete)
      reasons.push('archived identity coverage was truncated');
    if (!economics.attributionCoverageComplete)
      reasons.push('provider/model attribution was compacted into overflow buckets');
    if (economics.overflowed) reasons.push('one or more totals exceeded the safe integer limit');
    return `Lifetime economics are incomplete: ${reasons.join('; ')}.`;
  }

  function coordinationClaim(item: ShipIssue): string {
    if (!item.claim) return item.state === 'pending' ? 'Not acquired' : 'Unavailable';
    if (item.claim.status === 'released') return 'Released';
    return Date.parse(item.claim.expiresAt) > Date.now() ? 'Active' : 'Expired';
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

{#snippet row(entry: ShipRow)}
  {@const line = shipRowLine(run!, entry.issue)}
  <button
    class="ship-now-item"
    data-state={entry.presentation.status}
    data-ship-issue-id={entry.issue.id}
    aria-pressed={entry.issue.id === issue?.id}
    aria-controls={detailId}
    aria-label={shipRowName(entry)}
    title={issueLabel(entry.issue)}
    onclick={() => selectIssue(entry.issue.id)}
  >
    <span class="ship-issue-heading"
      ><strong>{issueLabel(entry.issue)}</strong><ActivityStatus
        status={entry.presentation.status}
        label={entry.presentation.label}
        compact
      /></span
    >
    <span class="ship-line" data-kind={line.kind}>{line.text}</span>
  </button>
{/snippet}

<div class="ship-panel" class:wide bind:this={panel} aria-label="Ship runs" role="group">
  <header>
    <div>
      <h2>Ship runs</h2>
      {#if scope === 'all' || !repository}<p>All repositories</p>{:else}<p
          class="ship-repository"
          title={repository}
        >
          {locationName(repository)}
        </p>{/if}
    </div>
    <div class="ship-actions">
      <button onclick={() => act(onrefresh)} disabled={busy}
        >{busy ? 'Refreshing…' : 'Refresh'}</button
      >
      {#if run}<button onclick={() => exportEconomics(run)}>Export task economics</button>{/if}
      <button onclick={() => act(onsettings)}>Validation settings</button>
      <button aria-label="Hide Ship panel" onclick={onclose}>Hide panel</button>
    </div>
  </header>
  {#if error}<p class="ship-error" role="alert">{error}</p>{/if}
  {#if archiveNotice > 0}<p class="ship-notice" role="status" data-ship-archive-notice>
      {shipArchiveNoticeText(archiveNotice)} ·
      <button class="ship-link" onclick={() => chooseArchived(true)}>Show</button>
      <button class="ship-link" aria-label="Dismiss archive notice" onclick={ondismissnotice}
        >Dismiss</button
      >
    </p>{/if}
  {#if result.text}<p
      class:ship-error={result.failed}
      role={result.failed ? 'alert' : 'status'}
      data-ship-result
    >
      {result.text}
    </p>{/if}
  {#if archivedCount || showArchived}<div class="ship-scope" role="group" aria-label="Run state">
      <button aria-pressed={!showArchived} onclick={() => chooseArchived(false)}>Active</button
      ><button aria-pressed={showArchived} onclick={() => chooseArchived(true)}
        >Archived ({archivedCount})</button
      >
    </div>{/if}
  {#if repository}<div class="ship-scope" role="group" aria-label="Repository scope">
      <button aria-pressed={scope === 'current'} onclick={() => (scope = 'current')}
        >Current repository</button
      ><button aria-pressed={scope === 'all'} onclick={() => (scope = 'all')}
        >All repositories</button
      >
    </div>{/if}
  {#if !run}
    <section class="ship-empty">
      {#if showArchived}
        <h3>No archived runs</h3>
        <p>Runs archive after all their issues are merged or closed.</p>
      {:else}
        <h3>No Ship runs yet</h3>
        <p>Start one of two ways:</p>
        <ul>
          <li>Ask an agent to run <code>/ship-it &lt;issue-url&gt;</code> for one issue.</li>
          <li>Publish an issue graph from an approved plan, then choose Ship issue graph.</li>
        </ul>
      {/if}
    </section>
  {:else}
    {#if orderedRuns.length > 1}<section class="ship-run-chooser" aria-label="Choose Ship run">
        <h3>Runs</h3>
        <div class="ship-run-list">
          {#each orderedRuns as item (item.id)}
            {@const presentation = runPresentation(item)}
            <button
              class="ship-run-option"
              aria-pressed={item.id === run.id}
              onclick={() => chooseRun(item.id)}
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
      </section>{/if}
    <section class="ship-summary" aria-label="Run progress">
      <div>
        <h3>{run.umbrella?.title ?? run.issues[0]?.title ?? 'Ship run'}</h3>
        <p>
          {#if run.umbrella}<a href={run.umbrella.url} target="_blank" rel="noreferrer"
              >Umbrella #{run.umbrella.number}</a
            >
            ·
          {/if}{run.remote} · {run.provider} · up to {run.limit} workers
        </p>
      </div>
      <div class="ship-progress">
        <strong>{merged} / {run.issues.length} merged</strong><progress
          value={merged}
          max={run.issues.length || 1}
          aria-label="Merged issues"
        ></progress>
      </div>
      <div class="ship-actions"><ShipActions {run} {onaction} onresult={showResult} /></div>
      {#if wide || !showDetail}<div class="view-toggle" role="group" aria-label="Issue view">
          <button aria-pressed={view === 'list'} onclick={() => (view = 'list')}>List</button>
          <button aria-pressed={view === 'graph'} onclick={() => (view = 'graph')}>Graph</button>
        </div>{/if}
    </section>
    <div class="ship-content" class:split={wide && view === 'list'}>
      {#if showList}
        {#if view === 'graph'}
          <WorkerDependencyMap
            {run}
            {nativeSubagents}
            selected={issue?.id}
            onselect={async (id) => {
              view = 'list';
              await selectIssue(id);
            }}
            {onopen}
          />
        {:else}
          <section class="ship-now" aria-label="Shipping issues">
            {#if allDone && !showDone && !pinned.size}
              <p class="ship-all-done">
                All {run.issues.length} issues {merged === run.issues.length ? 'merged' : 'done'} ·
                <button class="ship-link" onclick={() => (showDone = true)}>Show done</button>
              </p>
            {:else}
              <div
                class="ship-now-list"
                role="group"
                aria-label="Issues by state"
                bind:this={listElement}
              >
                {#each groups as group (group.id)}
                  <section
                    class="ship-group"
                    data-group={group.id}
                    aria-labelledby={`${detailId}-${group.id}`}
                  >
                    <h4 id={`${detailId}-${group.id}`}>
                      {group.label} <span>{group.rows.length + group.hidden}</span>
                    </h4>
                    {#each group.rows as entry (entry.issue.id)}{@render row(entry)}{/each}
                  </section>
                {:else}<p class="ship-muted">No shipping work is active.</p>{/each}
                {#if doneCount}<button
                    class="ship-link ship-done-toggle"
                    aria-pressed={showDone}
                    onclick={() => (showDone = !showDone)}
                    >{showDone ? 'Hide done' : `Show done (${doneCount})`}</button
                  >{/if}
              </div>
            {/if}
          </section>
        {/if}
      {/if}
      {#if showDetail && issue}
        {@const pendingHandoff = issue.contextHandoffs?.findLast(
          (handoff) =>
            handoff.fromThreadId === issue.threadId &&
            !handoff.toThreadId &&
            handoff.outcome === 'pending',
        )}
        {@const recoveryHandoff = issue.contextHandoffs?.findLast(
          (handoff) =>
            issue.handoffRecoveryRequired === true &&
            handoff.toThreadId === issue.threadId &&
            handoff.outcome === 'pending',
        )}
        {@const evidence = shipEvidenceReadiness(issue)}
        {@const manifest = (issue.evidenceManifests ?? []).find(
          (candidate) => candidate.revision === issue.evidenceRevision && !candidate.stale,
        )}
        {@const economics = summarizeTaskEconomics(
          issue.evidenceManifests ?? [],
          evidence,
          issue.evidenceRevision,
        )}
        {@const stage = shipStageIndicator(issue)}
        {@const objective = shipTaskObjective(issue)}
        {@const criteria = shipTaskCriteria(issue)}
        {@const mismatch = shipDeliveryMismatch(issue)}
        <section id={detailId} class="ship-issue-detail" aria-labelledby={headingId}>
          {#if !wide}<button class="ship-back" onclick={returnToRow}>← All issues</button>{/if}
          <h3 id={headingId} tabindex="-1" bind:this={heading}>{issueLabel(issue)}</h3>
          <ol class="ship-stage" role="img" aria-label={stage.label}>
            {#each stage.steps as step (step.id)}
              <li data-state={step.state}>
                {step.label}{#if step.state === 'not-required'}
                  · not required{:else if step.state === 'current' && stage.round > 0}
                  · round {stage.round}{/if}
              </li>
            {/each}
          </ol>
          {#if !shipClosedBeforeLaunch(issue) && (shipBlock(issue) || issue.error)}<p
              class="ship-error"
              role="status"
            >
              {shipBlock(issue) || issue.error}
            </p>{/if}
          {#if issue.state === 'pending' && issue.dependsOn.some((ref) => dependencyIssue(run, ref)?.state === 'failed')}
            <p class="ship-error">
              Waiting for failed dependencies to recover. Independent issues continue.
            </p>{/if}
          {#if mismatch}<p class="ship-error" role="status">{mismatch}</p>{/if}
          {#if issue.refreshError}<p class="ship-error" role="status">
              Refresh failed: {issue.refreshError}. Showing last known state.
            </p>{/if}
          <p class="ship-muted">
            {issue.refreshedAt
              ? `Last refreshed ${new Date(issue.refreshedAt).toLocaleString()}`
              : 'Not refreshed yet'}
          </p>
          <div class="ship-actions">
            <ShipActions {run} {issue} {onaction} onresult={showResult} />
            {#if issue.pullRequest}<a
                class="ship-pull-request"
                href={issue.pullRequest}
                target="_blank"
                rel="noreferrer">Open PR</a
              >{/if}
            <button
              disabled={!issue.path || issue.worktreeUnavailable}
              onclick={() => act(() => onopen(issue!.path!))}>Open worktree</button
            >
            <button
              disabled={!issue.path || !issue.threadId || issue.worktreeUnavailable}
              onclick={() => act(() => onopen(issue!.path!, issue!.threadId))}
              >Open worker thread</button
            >
            <a href={issue.url} target="_blank" rel="noreferrer">Open GitHub issue</a>
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
          <section class="ship-contract" aria-labelledby={`${detailId}-contract`}>
            <h4 id={`${detailId}-contract`}>Task contract</h4>
            {#if objective}<p class="ship-objective">{objective}</p>{:else}<p class="ship-muted">
                The worker has not recorded the task contract yet.
              </p>{/if}
            {#if criteria.length}<ol class="ship-gates">
                {#each criteria as criterion, index (`${index}:${criterion}`)}
                  <li>
                    <strong
                      >{evidence.unverifiedCriteria.includes(criterion)
                        ? 'Unverified'
                        : 'Verified'}</strong
                    >
                    <span>{criterion}</span>
                  </li>
                {/each}
              </ol>{/if}
            <h5>Risk and gates</h5>
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
            <h5>Evidence</h5>
            <p class:ship-error={!evidence.ready}>
              {issue.evidenceRevision ?? 'Revision unknown'} ·
              {evidence.ready ? 'Merge evidence ready' : evidence.reason}
            </p>
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
            <h5>Claim</h5>
            {#if issue.claim}
              <p>{issue.claim.holder} · {issue.claim.task} · {coordinationClaim(issue)}</p>
              <p>
                Acquired {new Date(issue.claim.acquiredAt).toLocaleString()} · heartbeat {new Date(
                  issue.claim.heartbeatAt,
                ).toLocaleString()} · expires {new Date(issue.claim.expiresAt).toLocaleString()}
              </p>
              {#if issue.claim.takeoverOf}<p>Audited takeover of {issue.claim.takeoverOf}</p>{/if}
              {#if issue.claim.releasedAt}<p>
                  Released {new Date(issue.claim.releasedAt).toLocaleString()} ·
                  {issue.claim.releaseReason}
                </p>{/if}
            {:else}<p class="ship-muted">No visible claim recorded.</p>{/if}
            <h5>Handoff</h5>
            {#if !pendingHandoff && !recoveryHandoff && !issue.contextHandoffs?.length}<p
                class="ship-muted"
              >
                No context handoff.
              </p>{/if}
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
            {#if pendingHandoff}<section class="ship-handoff" aria-label="Context handoff">
                <h4>Context handoff</h4>
                <p>
                  Context reached {pendingHandoff.context}% after {pendingHandoff.compactions}
                  compaction{pendingHandoff.compactions === 1 ? '' : 's'}.
                </p>
                <button
                  disabled={(issue.checkpoint?.sequence ?? 0) <= pendingHandoff.checkpointSequence}
                  onclick={() => act(() => onhandoff(run!, issue!))}>Start fresh worker</button
                >
                {#if (issue.checkpoint?.sequence ?? 0) <= pendingHandoff.checkpointSequence}<p
                    class="ship-muted"
                  >
                    Waiting for the current worker to update the canonical checkpoint.
                  </p>{/if}
              </section>{/if}
            {#if recoveryHandoff}<section
                class="ship-handoff"
                aria-label="Context handoff recovery"
              >
                <h4>Context handoff needs inspection</h4>
                <p>
                  Open the worker session and inspect its transcript. Retry only if its uncertain
                  work must not be adopted.
                </p>
                <button onclick={() => act(() => onhandoff(run!, issue!))}
                  >Cancel inspected session and retry</button
                >
              </section>{/if}
            {#if issue.contextHandoffs?.length}<details>
                <summary>Context history</summary>
                <p>
                  Compactions: Claude {issue.contextCompactions?.claude ?? 0} · Codex
                  {issue.contextCompactions?.codex ?? 0} · OpenCode
                  {issue.contextCompactions?.opencode ?? 0}
                </p>
                <ol>
                  {#each issue.contextHandoffs as handoff (handoff.id)}<li>
                      {handoff.provider} · {handoff.context}% · {handoff.outcome.replaceAll(
                        '_',
                        ' ',
                      )} · retries
                      {handoff.retriesBefore}→{handoff.retriesAfter ?? 'pending'} · lost-state
                      {handoff.lostStateFailuresBefore}→{handoff.lostStateFailuresAfter ??
                        'pending'}
                    </li>{/each}
                </ol>
              </details>{/if}
          </section>
          <h4>Accepted-task economics</h4>
          <p class:ship-error={!economics.accepted}>
            {economics.accepted
              ? 'Accepted outcome with complete economics'
              : economics.outcomeAccepted
                ? economics.overflowed
                  ? 'Outcome accepted · economics totals overflowed'
                  : !economics.attributionCoverageComplete
                    ? 'Outcome accepted · provider/model attribution compacted'
                    : !economics.identityCoverageComplete
                      ? 'Outcome accepted · archived identity coverage incomplete'
                      : `Outcome accepted · economics incomplete (${economics.missingSamples} missing samples)`
                : 'Outcome not accepted yet'} · {economics.samples} metric
            {economics.samples === 1 ? 'sample' : 'samples'} ·
            {totalEconomicsTokens(economics.totals.tokens).toLocaleString()} tokens ·
            {duration(economics.totals.elapsedMs)} elapsed
          </p>
          <p>
            {economics.totals.turns} turns · {economics.totals.toolCalls} tools ·
            {economics.totals.permissionRequests} permissions · {economics.totals.compactions}
            compactions · {economics.totals.retries} retries · {economics.totals.findings}
            findings · {economics.totals.checks} checks ·
            {economics.totals.humanInterventions} human interventions
          </p>
          {#if economics.lifetimeEconomicsComplete}<p
              class:ship-error={economics.totals.failedCommands > 0 ||
                economics.totals.approvalLatencyMs > 0 ||
                economics.totals.repeatedWork > 0}
            >
              Cost hotspots: {economics.totals.failedCommands} failed commands ·
              {duration(economics.totals.approvalLatencyMs)} approval latency ·
              {economics.totals.repeatedWork} repeated work units
            </p>{:else}<p class="ship-error">
              Cost hotspots unavailable until lifetime economics are complete.
            </p>{/if}
          {#if economics.lifetimeTruncated}<p class="ship-muted">
              Lifetime totals include compacted evidence history.
            </p>{/if}
          {#if !economics.lifetimeEconomicsComplete}<p class="ship-error">
              {incompleteEconomicsReason(economics)}
            </p>{/if}
          {#if economics.overflowed}<p class="ship-error">
              One or more lifetime totals reached the safe integer limit.
            </p>{/if}
          <details>
            <summary>Activity by role</summary>
            {#each Object.entries(economics.byRole) as [role, totals] (role)}<p>
                {role} · {totals.turns} turns · {totals.toolCalls} tools ·
                {totalEconomicsTokens(totals.tokens).toLocaleString()} tokens ·
                {duration(totals.elapsedMs)}
              </p>{:else}<p>No economics samples recorded for this revision.</p>{/each}
          </details>
          <details>
            <summary>Economics samples</summary>
            {#each (issue.evidenceManifests ?? []).flatMap( (candidate) => candidate.evidence.filter((item) => item.economics) ) as item (item.id)}
              {@const metric = item.economics!}
              <p>
                {item.provider} / {item.model ?? 'No model'} · {metric.role} / {metric.phase} ·
                {metric.turns} turns · {metric.toolCalls} tools · {metric.permissionRequests}
                permissions · {metric.compactions} compactions ·
                {totalEconomicsTokens(metric.tokens).toLocaleString()} tokens · {duration(
                  metric.elapsedMs,
                )} ·
                {metric.retries} retries · {metric.findings} findings · {metric.checks} checks ·
                {metric.humanInterventions} human interventions
              </p>
            {:else}<p>No economics samples recorded for this revision.</p>{/each}
          </details>
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
  header {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: start;
    justify-content: space-between;
  }
  header h2,
  header p {
    margin: 0;
  }
  .ship-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    padding: 10px 0;
    border-block: 1px solid var(--shell-divider);
  }
  .ship-summary h3,
  .ship-summary p {
    margin: 0;
  }
  .ship-summary p {
    color: var(--sui-muted);
    font-size: 12px;
  }
  .ship-progress {
    display: grid;
    min-width: 120px;
    gap: 4px;
  }
  progress {
    display: block;
    width: 100%;
  }
  .view-toggle {
    display: flex;
  }
  .view-toggle button:first-child {
    border-radius: 6px 0 0 6px;
  }
  .view-toggle button:last-child {
    border-radius: 0 6px 6px 0;
    border-left-width: 0;
  }
  .view-toggle button[aria-pressed='true'] {
    border-color: var(--sui-primary);
    color: var(--sui-primary);
  }
  .ship-content {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    margin-top: 12px;
  }
  .ship-content.split {
    grid-template-columns: minmax(240px, 2fr) minmax(0, 3fr);
    align-items: start;
  }
  .ship-now {
    min-width: 0;
  }
  .ship-now-list {
    display: grid;
    gap: 12px;
  }
  .ship-group {
    display: grid;
    gap: 4px;
  }
  .ship-group h4 {
    display: flex;
    gap: 6px;
    align-items: baseline;
    margin: 0;
    color: var(--sui-muted);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .ship-group h4 span {
    font-weight: 400;
  }
  .ship-group[data-group='needs-input'] h4 {
    color: var(--activity-waiting);
  }
  .ship-now-item {
    display: grid;
    min-width: 0;
    gap: 3px;
    padding: 6px 10px;
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
  .ship-now-item[data-state='offline'],
  .ship-now-item[data-state='interrupted'] {
    border-left-color: var(--sui-danger);
  }
  .ship-now-item[data-state='waiting'],
  .ship-now-item[data-state='ready'],
  .ship-now-item[data-state='queued'] {
    border-left-color: var(--activity-waiting);
  }
  .ship-now-item[data-state='fixing'] {
    border-left-color: var(--activity-fixing);
  }
  .ship-now-item[data-state='completed'] {
    border-left-color: var(--activity-completed);
  }
  .ship-issue-heading,
  .ship-run-task,
  .ship-run-meta {
    display: flex;
    min-width: 0;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  .ship-issue-heading strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ship-run-task strong,
  .ship-run-meta span,
  .ship-run-meta time {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .ship-line {
    overflow: hidden;
    color: var(--sui-muted);
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ship-line[data-kind='blocker'] {
    color: var(--sui-danger);
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
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button:focus-visible,
  a:focus-visible,
  h3:focus-visible {
    outline: 2px solid var(--sui-primary);
    outline-offset: 2px;
  }
  .ship-link {
    border: 0;
    padding: 2px 4px;
    color: var(--sui-primary);
    text-decoration: underline;
  }
  .ship-done-toggle {
    justify-self: start;
  }
  .ship-all-done {
    margin: 0;
    padding: 16px 0;
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
    margin: 12px 0 0;
  }
  .ship-run-chooser h3 {
    margin: 0;
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
    margin-top: 12px;
  }
  .ship-scope button[aria-pressed='true'] {
    border-color: var(--sui-primary);
    color: var(--sui-primary);
  }
  .ship-issue-detail {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .ship-back {
    margin-bottom: 8px;
  }
  .ship-stage {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin: 0 0 8px;
    padding: 0;
    list-style: none;
    font-size: 12px;
  }
  .ship-stage li {
    color: var(--sui-muted);
  }
  .ship-stage li[data-state='done'] {
    color: var(--activity-completed);
  }
  .ship-stage li[data-state='current'] {
    color: var(--sui-foreground);
    font-weight: 700;
  }
  .ship-stage li[data-state='not-required'] {
    opacity: 0.7;
  }
  .ship-contract h4,
  .ship-contract h5 {
    margin: 12px 0 4px;
  }
  .ship-objective {
    font-weight: 600;
  }
  .ship-dependencies {
    display: grid;
    gap: 6px;
    font-size: 12px;
  }
  .ship-dependencies button {
    text-align: left;
  }
  .ship-notice {
    margin: 8px 0 0;
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
    color: var(--sui-muted);
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
    padding: 24px 0;
  }
  @media (max-width: 520px) {
    .ship-panel {
      padding: 12px;
    }
    .ship-run-task,
    .ship-run-meta {
      flex-direction: column;
      align-items: start;
      gap: 5px;
    }
  }
</style>

<script lang="ts">
  import Markdown from './Markdown.svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import { activityState } from './lib/activity-state';
  import type { SpawnReceipt } from './lib/agent-results';
  import { boundedSpawnOutput, receiptNeedsLiveActivity } from './lib/agent-results';

  let {
    receipts,
    onopen,
  }: { receipts: SpawnReceipt[]; onopen?: (receipt: SpawnReceipt) => Promise<void> } = $props();
  const active = $derived(receipts.filter(receiptNeedsLiveActivity));
  let expanded = $state<string[]>([]);
  let opening = $state<string[]>([]);
  let openErrors = $state<Record<string, string>>({});

  function label(receipt: SpawnReceipt): string {
    return receipt.provider === 'opencode'
      ? 'OpenCode'
      : receipt.provider === 'codex'
        ? 'Codex'
        : 'Claude';
  }

  function activity(receipt: SpawnReceipt): string {
    if (receipt.state === 'waiting') return 'Needs your input';
    if (receipt.activity) return receipt.activity;
    if (receipt.result) return 'Writing response…';
    if (receipt.state === 'queued' || receipt.state === 'starting') return 'Waiting to start…';
    if (['completed', 'failed', 'interrupted', 'unavailable'].includes(receipt.state))
      return activityState(receipt.state).label;
    return 'Starting task…';
  }

  function signalDate(receipt: SpawnReceipt): Date {
    const updated = Number.isFinite(receipt.updated) ? receipt.updated : 0;
    const date = new Date(updated);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
  }

  function toggle(id: string) {
    expanded = expanded.includes(id)
      ? expanded.filter((receiptId) => receiptId !== id)
      : [...expanded, id];
  }

  function keepComposerSelection(event: PointerEvent) {
    if (event.button === 0) event.preventDefault();
  }

  async function open(receipt: SpawnReceipt) {
    if (
      !onopen ||
      !receipt.targetId ||
      !receipt.targetDirectory ||
      opening.includes(receipt.receiptId)
    )
      return;
    opening = [...opening, receipt.receiptId];
    const nextErrors = { ...openErrors };
    delete nextErrors[receipt.receiptId];
    openErrors = nextErrors;
    try {
      await onopen(receipt);
    } catch (cause) {
      openErrors = {
        ...openErrors,
        [receipt.receiptId]: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      opening = opening.filter((id) => id !== receipt.receiptId);
    }
  }
</script>

{#if active.length}
  <section class="spawn-activity" aria-label="Subagent activity">
    <h2>Subagents ({active.length})</h2>
    {#each active as receipt (receipt.receiptId)}
      <article
        class="spawn-active state-{receipt.state}"
        role="group"
        aria-label={`${label(receipt)} subagent`}
      >
        <div class="spawn-heading">
          <button
            class="spawn-toggle"
            aria-label={`${expanded.includes(receipt.receiptId) ? 'Collapse' : 'Expand'} ${label(receipt)} subagent task: ${receipt.prompt ?? 'Task details unavailable'}`}
            aria-expanded={expanded.includes(receipt.receiptId)}
            aria-controls={`spawn-details-${receipt.receiptId}`}
            onpointerdown={keepComposerSelection}
            onclick={() => toggle(receipt.receiptId)}
          >
            <span class="spawn-chevron" aria-hidden="true"
              >{expanded.includes(receipt.receiptId) ? '▾' : '▸'}</span
            >
            <span class="spawn-avatar" aria-hidden="true">↳</span>
            <strong>{label(receipt)} <span class="spawn-kind">subagent</span></strong>
          </button>
          <ActivityStatus status={receipt.state} compact />
          {#if receipt.targetId && receipt.targetDirectory && onopen}<button
              class="spawn-open"
              aria-label={`Open ${label(receipt)} subagent thread for ${receipt.prompt ?? 'task details unavailable'}`}
              disabled={opening.includes(receipt.receiptId)}
              onpointerdown={keepComposerSelection}
              onclick={() => void open(receipt)}
              >{opening.includes(receipt.receiptId) ? 'Opening…' : 'Open thread'}</button
            >{/if}
        </div>
        <p class="spawn-task">
          <strong>Task</strong>
          {receipt.prompt ?? 'Task details unavailable'}
        </p>
        <div class="spawn-signal" role="status" aria-live="polite">
          <span>{activity(receipt)}</span>
          <time
            datetime={signalDate(receipt).toISOString()}
            title={signalDate(receipt).toLocaleString()}
            >Last signal {signalDate(receipt).toLocaleTimeString()}</time
          >
        </div>
        {#if !receipt.targetId || !receipt.targetDirectory}<p class="spawn-unavailable">
            Thread unavailable — the child has not confirmed a target yet.
          </p>{/if}
        {#if openErrors[receipt.receiptId]}<p class="spawn-error" role="alert">
            Thread unavailable — {openErrors[receipt.receiptId]}
          </p>{/if}
        <div
          class="spawn-details"
          id={`spawn-details-${receipt.receiptId}`}
          hidden={!expanded.includes(receipt.receiptId)}
        >
          {#if boundedSpawnOutput(receipt)}<div class="spawn-output">
              <Markdown source={boundedSpawnOutput(receipt)} />
            </div>{:else}<p class="spawn-empty">No output confirmed yet.</p>{/if}
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .spawn-activity {
    margin: 12px 0 16px 42px;
  }
  .spawn-activity h2 {
    margin: 0 0 8px;
    font-size: 0.85rem;
  }
  .spawn-active {
    --spawn-color: var(--activity-working);
    width: min(100%, 720px);
    margin-bottom: 8px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--spawn-color) 35%, transparent);
    border-left: 3px solid var(--spawn-color);
    border-radius: 8px;
    background: color-mix(in srgb, var(--spawn-color) 5%, var(--sui-surface));
  }
  .spawn-active.state-waiting {
    --spawn-color: var(--activity-waiting);
  }
  .spawn-active.state-completed {
    --spawn-color: var(--activity-completed);
  }
  .spawn-active.state-failed {
    --spawn-color: var(--activity-failed);
  }
  .spawn-active.state-interrupted,
  .spawn-active.state-unavailable,
  .spawn-active.state-queued,
  .spawn-active.state-starting {
    --spawn-color: var(--activity-neutral);
  }
  .spawn-heading {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spawn-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .spawn-toggle strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spawn-chevron {
    width: 10px;
    color: var(--sui-muted);
  }
  .spawn-avatar {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    color: var(--spawn-color);
    background: color-mix(in srgb, var(--spawn-color) 15%, transparent);
  }
  .spawn-kind,
  .spawn-prompt {
    color: var(--sui-muted);
  }
  .spawn-kind {
    font-weight: 400;
  }
  .spawn-open {
    border: 0;
    padding: 3px 5px;
    color: var(--sui-accent);
    background: transparent;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .spawn-open:disabled {
    cursor: wait;
    opacity: 0.6;
  }
  .spawn-task {
    margin: 8px 0 0 42px;
    font-size: 0.83rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spawn-task strong {
    margin-right: 5px;
    color: var(--sui-muted);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .spawn-signal {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin: 5px 0 0 42px;
    color: var(--sui-muted);
    font-size: 0.76rem;
  }
  .spawn-signal span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spawn-signal time {
    flex: none;
  }
  .spawn-unavailable,
  .spawn-error,
  .spawn-empty {
    margin: 7px 0 0 42px;
    color: var(--sui-muted);
    font-size: 0.76rem;
  }
  .spawn-error {
    color: var(--sui-danger);
  }
  .spawn-details {
    margin: 9px -12px -10px;
    padding: 9px 12px 10px;
    border-top: 1px solid color-mix(in srgb, var(--spawn-color) 20%, transparent);
  }
  .spawn-output {
    max-height: 240px;
    overflow: auto;
    overflow-wrap: anywhere;
  }
  .spawn-output :global(:first-child) {
    margin-top: 0;
  }
  .spawn-output :global(:last-child) {
    margin-bottom: 0;
  }
  @media (max-width: 620px) {
    .spawn-signal {
      display: block;
    }
    .spawn-signal time {
      display: block;
      margin-top: 3px;
    }
    .spawn-open {
      font-size: 0;
    }
    .spawn-open::after {
      content: 'Open';
      font-size: 0.78rem;
    }
  }
</style>

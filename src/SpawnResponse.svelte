<script lang="ts">
  import Markdown from './Markdown.svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import { activityState } from './lib/activity-state';
  import type { SpawnReceipt } from './lib/agent-results';
  import {
    providerLabel,
    subagentDurationMs,
    subagentType,
    toolCountLabel,
  } from './lib/subagent-display';
  import { formatDuration } from './lib/task-notification';

  let {
    receipt,
    onopen,
  }: { receipt: SpawnReceipt; onopen?: (receipt: SpawnReceipt) => Promise<void> } = $props();
  const type = $derived(subagentType(receipt));
  const duration = $derived(subagentDurationMs(receipt, receipt.updated));
  const stats = $derived(
    [
      duration === null ? '' : formatDuration(duration),
      receipt.toolCount === undefined ? '' : toolCountLabel(receipt.toolCount),
    ].filter(Boolean),
  );
  // Only a state the child has not already shown as its badge adds information.
  const note = $derived(
    receipt.result || receipt.error
      ? ''
      : receipt.activity && receipt.activity !== activityState(receipt.state).label
        ? receipt.activity
        : '',
  );
  const canOpen = $derived(!!onopen && !!receipt.targetId && !!receipt.targetDirectory);
  let expanded = $state(false);
  let overflowing = $state(false);
  let opening = $state(false);
  let openError = $state('');
  let result = $state<HTMLElement | null>(null);

  $effect(() => {
    const element = result;
    void receipt.result;
    if (!element) {
      overflowing = false;
      return;
    }
    const measure = () => {
      if (!expanded) overflowing = element.scrollHeight > element.clientHeight + 1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  function keepComposerSelection(event: PointerEvent) {
    if (event.button === 0) event.preventDefault();
  }

  async function open() {
    if (!onopen || opening) return;
    opening = true;
    openError = '';
    try {
      await onopen(receipt);
    } catch (cause) {
      openError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      opening = false;
    }
  }
</script>

<article
  class="message assistant-message spawn-response state-{receipt.state}"
  data-spawn-id={receipt.receiptId}
  tabindex="-1"
  aria-label={`${type} subagent response`}
>
  <div class="avatar agent-avatar spawn-avatar">↳</div>
  <div class="message-body">
    <div class="message-author">
      {type}
      <span>{receipt.name ? `${providerLabel(receipt.provider)} subagent` : 'subagent'}</span>
      {#if receipt.model}<span class="spawn-model">{receipt.model}</span>{/if}
      <ActivityStatus status={receipt.state} compact />
      {#if canOpen}<button
          class="spawn-response-open"
          aria-label={`Open ${type} subagent thread for ${receipt.prompt ?? 'task details unavailable'}`}
          disabled={opening}
          onpointerdown={keepComposerSelection}
          onclick={() => void open()}>{opening ? 'Opening…' : 'Open'}</button
        >{/if}
    </div>
    {#if receipt.prompt}<p class="spawn-task" title={receipt.prompt}>
        <strong>Task</strong>
        {receipt.prompt}
      </p>{/if}
    {#if stats.length}<p class="spawn-stats">
        {#each stats as stat, index (stat)}{index ? ' · ' : ''}{stat}{/each}
      </p>{/if}
    {#if receipt.routing}
      <p class="spawn-route">
        {receipt.routing.role} · {receipt.routing.risk} · requested {receipt.routing.requested
          .provider}
        / {receipt.routing.requested.model}{receipt.routing.requested.variant
          ? ` / ${receipt.routing.requested.variant}`
          : ''}{#if receipt.routing.actual}
          · actual {receipt.routing.actual.provider} / {receipt.routing.actual.model}{receipt
            .routing.actual.variant
            ? ` / ${receipt.routing.actual.variant}`
            : ''}{/if}
        {#if receipt.routing.independentReviewRequired}
          · independent review required{/if}
      </p>
    {/if}
    {#if receipt.result}
      <div
        class="spawn-result"
        class:clamped={!expanded}
        id={`spawn-result-${receipt.receiptId}`}
        bind:this={result}
      >
        <Markdown source={receipt.result} />
      </div>
      {#if overflowing || expanded}<button
          class="spawn-expand"
          aria-expanded={expanded}
          aria-controls={`spawn-result-${receipt.receiptId}`}
          onpointerdown={keepComposerSelection}
          onclick={() => (expanded = !expanded)}>{expanded ? 'Collapse' : 'Expand'}</button
        >{/if}
    {/if}
    {#if receipt.error}<p class="spawn-error">{receipt.error}</p>{/if}
    {#if note}<p class="spawn-note">{note}</p>{/if}
    {#if openError}<p class="spawn-error" role="alert">Thread unavailable — {openError}</p>{/if}
  </div>
</article>

<style>
  .spawn-response {
    --spawn-color: var(--activity-completed);
    width: 100%;
    border-left: 3px solid var(--spawn-color);
    padding-left: 10px;
    background: color-mix(in srgb, var(--spawn-color) 5%, transparent);
  }
  .spawn-response.state-failed {
    --spawn-color: var(--activity-failed);
  }
  .spawn-response.state-interrupted,
  .spawn-response.state-unavailable {
    --spawn-color: var(--activity-neutral);
  }
  .spawn-avatar {
    color: var(--spawn-color);
    background: color-mix(in srgb, var(--spawn-color) 15%, transparent);
  }
  .message-author span {
    color: var(--sui-muted);
    font-weight: 400;
  }
  .spawn-error {
    color: var(--sui-danger);
  }
  .spawn-route,
  .spawn-note,
  .spawn-stats,
  .spawn-task {
    margin: 4px 0 0;
    color: var(--sui-muted);
    font-size: 0.78rem;
  }
  .spawn-task {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spawn-task strong {
    margin-right: 5px;
    font-size: var(--type-12);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .spawn-stats {
    font-variant-numeric: tabular-nums;
  }
  .spawn-result {
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .spawn-result.clamped {
    max-height: 4.5em;
    overflow: hidden;
  }
  .spawn-result :global(:first-child) {
    margin-top: 0;
  }
  .spawn-result :global(:last-child) {
    margin-bottom: 0;
  }
  .spawn-response-open,
  .spawn-expand {
    border: 0;
    padding: 3px 5px;
    color: var(--sui-primary);
    background: transparent;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .spawn-response-open {
    margin-left: auto;
  }
  .spawn-response-open:disabled {
    cursor: wait;
    opacity: 0.6;
  }
  .spawn-expand {
    padding-left: 0;
  }
</style>

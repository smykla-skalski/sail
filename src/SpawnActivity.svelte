<script lang="ts">
  import Markdown from './Markdown.svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import type { SpawnReceipt } from './lib/agent-results';
  import { receiptIsSettled } from './lib/agent-results';

  let { receipts }: { receipts: SpawnReceipt[] } = $props();
  const active = $derived(receipts.filter((receipt) => !receiptIsSettled(receipt.state)));

  function label(receipt: SpawnReceipt): string {
    return receipt.provider === 'opencode'
      ? 'OpenCode'
      : receipt.provider === 'codex'
        ? 'Codex'
        : 'Claude';
  }
</script>

{#if active.length}
  <section class="spawn-activity" aria-label="Subagent activity">
    <h2>Subagents ({active.length})</h2>
    {#each active as receipt (receipt.receiptId)}
      <article
        class="spawn-active state-{receipt.state}"
        role="status"
        aria-label={`${label(receipt)} subagent ${receipt.state}`}
      >
        <div class="spawn-heading">
          <span class="spawn-avatar" aria-hidden="true">↳</span>
          <strong>{label(receipt)} <span class="spawn-kind">subagent</span></strong>
          <ActivityStatus status={receipt.state} compact />
        </div>
        <p class="spawn-activity-line">
          {receipt.state === 'waiting'
            ? 'Needs your input'
            : (receipt.activity ??
              (receipt.result
                ? 'Writing response…'
                : receipt.state === 'queued' || receipt.state === 'starting'
                  ? 'Waiting to start…'
                  : 'Starting task…'))}
        </p>
        {#if receipt.result}<div class="spawn-output">
            <Markdown source={receipt.result} />
          </div>{/if}
        {#if receipt.prompt}<details class="spawn-prompt">
            <summary>Task</summary>
            <p>{receipt.prompt}</p>
          </details>{/if}
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
  .spawn-active.state-queued,
  .spawn-active.state-starting {
    --spawn-color: var(--activity-neutral);
  }
  .spawn-heading {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .spawn-heading strong {
    flex: 1;
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
  .spawn-activity-line {
    margin: 8px 0 0 36px;
  }
  .spawn-prompt {
    margin: 8px 0 0 36px;
    overflow-wrap: anywhere;
  }
  .spawn-prompt p {
    margin: 6px 0 0;
  }
  .spawn-output {
    margin: 8px 0 0 36px;
    max-height: 240px;
    overflow: auto;
  }
</style>

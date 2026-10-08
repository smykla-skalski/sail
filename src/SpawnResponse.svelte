<script lang="ts">
  import Markdown from './Markdown.svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import type { SpawnReceipt } from './lib/agent-results';

  let { receipt }: { receipt: SpawnReceipt } = $props();
  const name = $derived(
    receipt.provider === 'opencode'
      ? 'OpenCode'
      : receipt.provider === 'codex'
        ? 'Codex'
        : 'Claude',
  );
</script>

<article
  class="message assistant-message spawn-response state-{receipt.state}"
  data-spawn-id={receipt.receiptId}
  tabindex="-1"
  aria-label={`${name} subagent response`}
>
  <div class="avatar agent-avatar spawn-avatar">↳</div>
  <div class="message-body">
    <div class="message-author">
      {name} <span>subagent</span>
      <ActivityStatus status={receipt.state} compact />
    </div>
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
    {#if receipt.result}<Markdown source={receipt.result} />{/if}
    {#if receipt.error}<p class="spawn-error">{receipt.error}</p>{/if}
    {#if !receipt.result && !receipt.error}<p>{receipt.state}</p>{/if}
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
  .spawn-route {
    color: var(--sui-muted);
    font-size: 0.78rem;
  }
</style>

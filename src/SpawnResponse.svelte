<script lang="ts">
  import Markdown from './Markdown.svelte';
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

<article class="message assistant-message spawn-response" aria-label={`${name} subagent response`}>
  <div class="avatar agent-avatar spawn-avatar">↳</div>
  <div class="message-body">
    <div class="message-author">{name} <span>subagent · {receipt.state}</span></div>
    {#if receipt.result}<Markdown source={receipt.result} />{/if}
    {#if receipt.error}<p class="spawn-error">{receipt.error}</p>{/if}
    {#if !receipt.result && !receipt.error}<p>{receipt.state}</p>{/if}
  </div>
</article>

<style>
  .spawn-response {
    width: 100%;
    border-left: 3px solid var(--sui-primary);
    padding-left: 10px;
    background: color-mix(in srgb, var(--sui-primary) 5%, transparent);
  }
  .spawn-avatar {
    color: var(--sui-primary);
    background: color-mix(in srgb, var(--sui-primary) 15%, transparent);
  }
  .message-author span {
    color: var(--sui-muted);
    font-weight: 400;
  }
  .spawn-error {
    color: var(--sui-danger);
  }
</style>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import HarnessIcon from './HarnessIcon.svelte';
  import { formatMessageTime, providerName } from './lib/transcript';

  let {
    author,
    kind,
    created,
    messageId,
    provider,
    children,
  }: {
    author: string;
    kind: 'user' | 'assistant' | 'thought';
    created?: number;
    messageId?: string;
    provider?: string;
    children: Snippet;
  } = $props();

  const time = $derived(formatMessageTime(created));
  const known = $derived(provider === 'claude' || provider === 'codex' || provider === 'opencode');
</script>

<article
  class="message agent-message"
  class:user-message={kind === 'user'}
  class:assistant-message={kind !== 'user'}
  class:thought={kind === 'thought'}
  data-created={created}
  data-message-id={messageId}
  data-provider={provider}
  tabindex="-1"
>
  <div
    class="avatar"
    class:user-avatar={kind === 'user'}
    class:agent-avatar={kind !== 'user'}
    class:provider-avatar={kind !== 'user' && known}
    title={kind !== 'user' && provider ? providerName(provider) : undefined}
  >
    {#if kind === 'user'}{author.startsWith('From ') ? '↗' : 'You'}
    {:else if known && provider}<HarnessIcon agent={provider} size={18} />
    {:else}<span aria-hidden="true">◇</span>{/if}
  </div>
  <div class="message-body">
    <div class="message-author">
      {author}{#if time}<time class="message-time" datetime={new Date(created ?? 0).toISOString()}
          >{time}</time
        >{/if}
    </div>
    {#if kind === 'thought'}
      <details class="thought-details">
        <summary>Show thinking</summary>
        {@render children()}
      </details>
    {:else}
      {@render children()}
    {/if}
  </div>
</article>

<style>
  .agent-message {
    width: 100%;
  }
  .thought {
    opacity: 0.65;
  }
  .thought-details > summary {
    cursor: pointer;
    color: var(--sui-muted);
    font-size: 12px;
  }
  .message-time {
    margin-left: 8px;
    color: var(--sui-muted);
    font-size: 11px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .provider-avatar {
    background: var(--sui-subtle);
    border: 1px solid var(--shell-divider);
  }
</style>

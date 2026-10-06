<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    author,
    kind,
    created,
    messageId,
    children,
  }: {
    author: string;
    kind: 'user' | 'assistant' | 'thought';
    created?: number;
    messageId?: string;
    children: Snippet;
  } = $props();
</script>

<article
  class="message agent-message"
  class:user-message={kind === 'user'}
  class:assistant-message={kind !== 'user'}
  class:thought={kind === 'thought'}
  data-created={created}
  data-message-id={messageId}
  tabindex="-1"
>
  <div class="avatar" class:user-avatar={kind === 'user'} class:agent-avatar={kind !== 'user'}>
    {kind === 'user' ? (author.startsWith('From ') ? '↗' : 'You') : 'S.'}
  </div>
  <div class="message-body">
    <div class="message-author">{author}</div>
    {@render children()}
  </div>
</article>

<style>
  .agent-message {
    width: 100%;
  }
  .thought {
    opacity: 0.65;
  }
</style>

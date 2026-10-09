<script lang="ts">
  import { jumpLabel } from './lib/transcript';

  let {
    following,
    count,
    revision = '',
    onjump,
  }: { following: boolean; count: number; revision?: string; onjump: () => void } = $props();

  let baseline = $state(0);
  let seenRevision = $state('');
  $effect(() => {
    if (following) {
      baseline = count;
      seenRevision = revision;
    }
  });
  const fresh = $derived(Math.max(0, count - baseline));
</script>

{#if !following}
  <button type="button" class="jump-latest" onclick={onjump}>
    {jumpLabel(fresh, revision !== seenRevision)}
  </button>
{/if}

<style>
  .jump-latest {
    position: sticky;
    bottom: 12px;
    z-index: 2;
    display: block;
    margin: 0 auto;
    padding: 5px 14px;
    border: 1px solid var(--shell-divider);
    border-radius: 999px;
    color: var(--sui-foreground);
    background: var(--sui-surface);
    font-size: 12px;
    cursor: pointer;
  }
</style>

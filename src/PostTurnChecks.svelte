<script lang="ts">
  import { Button } from '@smykla-skalski/sui';
  import type { PostTurnCheck } from './lib/post-turn-checks';

  let { checks, onretry }: { checks: PostTurnCheck[]; onretry: (check: PostTurnCheck) => void } =
    $props();
</script>

{#each checks as check (`${check.turn}:${check.source}:${check.command}`)}
  <article
    class="post-turn-check"
    data-check-id={check.id}
    role="group"
    aria-label={`${check.source} post-turn check ${check.status}: ${check.command}`}
  >
    <div class="post-turn-check-head">
      <strong>Post-turn check · {check.source}</strong>
      <span>{check.status === 'timed_out' ? 'Timed out' : check.status}</span>
    </div>
    <code>{check.command}</code>
    {#if check.status === 'running'}<p role="status">Running…</p>{/if}
    {#if check.code !== null}<p>Exit code {check.code}</p>{/if}
    {#if check.output}<pre>{check.output}</pre>{/if}
    {#if ['failed', 'timed_out', 'canceled'].includes(check.status)}
      <Button size="sm" variant="secondary" onclick={() => onretry(check)}>Retry</Button>
    {/if}
  </article>
{/each}

<style>
  .post-turn-check {
    margin: 12px 20px;
    padding: 12px;
    border: 1px solid var(--border-color, #7775);
    border-radius: 8px;
  }
  .post-turn-check-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  code {
    display: block;
    margin-top: 6px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  pre {
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  p {
    margin: 6px 0;
  }
</style>

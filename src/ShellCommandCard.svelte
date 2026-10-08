<script lang="ts">
  import { Button } from '@smykla-skalski/sui';
  import ActivityStatus from './ActivityStatus.svelte';
  import { formatDuration } from './lib/task-notification';
  import { shellStatusLabel, type ShellOutcome } from './lib/shell-command';

  let {
    run,
    pending = false,
    onstop,
  }: { run: ShellOutcome; pending?: boolean; onstop?: () => void } = $props();
  const activity = $derived(
    run.status === 'passed'
      ? 'completed'
      : run.status === 'timed_out'
        ? 'failed'
        : run.status === 'running'
          ? 'working'
          : run.status,
  );
</script>

<article class="shell-command" role="group" aria-label={`Shell command ${run.command}`}>
  <div class="shell-command-head">
    <code class="shell-command-line">$ {run.command}</code>
    <ActivityStatus status={activity} label={shellStatusLabel(run)} compact />
    {#if run.durationMs !== undefined}<span class="shell-command-meta"
        >{formatDuration(run.durationMs)}</span
      >{/if}
    {#if run.status === 'running' && onstop}<Button size="sm" variant="secondary" onclick={onstop}
        >Stop</Button
      >{/if}
  </div>
  {#if run.output}<pre>{run.output}</pre>{/if}
  {#if pending && run.status !== 'running'}<p class="shell-command-meta">
      Sent to the agent with your next message.
    </p>{/if}
</article>

<style>
  .shell-command {
    margin: 8px 0;
    padding: 8px 10px;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-8);
    font-size: var(--type-12);
  }
  .shell-command-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 9px;
  }
  .shell-command-line {
    flex: 1 1 auto;
    min-width: 0;
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .shell-command-meta {
    margin: 6px 0 0;
    color: var(--sui-muted);
    font-size: var(--type-12);
  }
  .shell-command-head .shell-command-meta {
    margin: 0;
  }
  pre {
    max-height: 320px;
    margin: 8px 0 0;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>

<script lang="ts">
  import ActivityStatus from './ActivityStatus.svelte';
  import type { HookActivity } from './lib/hook-activity';

  let { activity }: { activity: HookActivity } = $props();
  const status = $derived(
    activity.outcome === 'blocked' || activity.outcome === 'failed' ? 'failed' : 'completed',
  );
</script>

<details class="hook-activity" data-hook-id={activity.id}>
  <summary>
    <strong>{activity.provider} hook · {activity.event}</strong>
    <ActivityStatus {status} compact />
    <span>{activity.outcome}</span>
  </summary>
  <div class="hook-activity-safe">
    <div><span>Source:</span> {activity.source}</div>
    {#if activity.actor}<div><span>Agent:</span> {activity.actor}</div>{/if}
    {#if activity.action}<div>
        <span>Affected action:</span> <code>{activity.action}</code>
      </div>{/if}
    {#if activity.reason}<div><span>Provider reason:</span> {activity.reason}</div>{/if}
    <details class="hook-diagnostics">
      <summary>Open sensitive diagnostics</summary>
      <p>May contain prompts, tool arguments, and hook output.</p>
      <pre>{JSON.stringify(activity.diagnostics, null, 2)}</pre>
    </details>
  </div>
</details>

<style>
  .hook-activity {
    margin: 6px 0;
    border: 1px solid var(--shell-divider);
    border-left: 3px solid var(--sui-primary);
    border-radius: 8px;
    font-size: 12px;
  }
  .hook-activity > summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
  }
  .hook-activity > summary > span:last-child {
    color: var(--sui-muted);
  }
  .hook-activity-safe {
    display: grid;
    gap: 5px;
    padding: 0 10px 10px;
  }
  .hook-activity-safe span {
    color: var(--sui-muted);
  }
  .hook-diagnostics {
    margin-top: 5px;
  }
  .hook-diagnostics p {
    color: var(--sui-danger-ink);
  }
  pre {
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>

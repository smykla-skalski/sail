<script lang="ts">
  import { untrack } from 'svelte';
  import { toolAlert } from './lib/tool-alerts';
  import { toolCommand, toolInput } from './lib/tool-display';
  import ActivityStatus from './ActivityStatus.svelte';

  let {
    title,
    status,
    input,
    output = '',
    error = '',
    source = '',
    expanded = false,
    activityId,
    live = false,
    children,
  }: {
    title: string;
    status: string;
    input?: unknown;
    output?: string;
    error?: string;
    source?: string;
    expanded?: boolean;
    activityId?: string;
    /** False while the host replays history; errors already present then stay silent. */
    live?: boolean;
    children?: import('svelte').Snippet;
  } = $props();

  let open = $state(false);
  $effect(() => {
    if (expanded || status === 'error' || status === 'failed') open = true;
  });
  const mountedError = untrack(() => error);
  const mountedLive = untrack(() => live);
  let alertText = $state('');
  $effect(() => {
    const next = toolAlert({ id: activityId, error, mountedError, mountedLive });
    if (next || !error) alertText = next;
  });
  const command = $derived(toolCommand(input));
  const formattedInput = $derived(toolInput(input));
</script>

<details class="tool-activity" data-tool-id={activityId} bind:open>
  <summary>
    <span class="tool-activity-name">{title}</span>
    <ActivityStatus {status} compact />
    {#if error}<span class="tool-activity-summary-error">{error}</span>{/if}
    {#if command}<code class="tool-activity-command">{command}</code>{/if}
  </summary>
  {#if open}
    <div class="tool-activity-details">
      {#if formattedInput}
        <div class="tool-activity-section">
          <span>Input</span>
          <pre>{formattedInput}</pre>
        </div>
      {/if}
      {#if output}
        <div class="tool-activity-section">
          <span>Output</span>
          <pre>{output}</pre>
        </div>
      {/if}
      {#if error}<p class="tool-activity-error">{error}</p>{/if}
      {#if source}<p class="tool-activity-source">Reported by {source}</p>{/if}
      {#if children}{@render children()}{/if}
    </div>
  {/if}
</details>
<!-- Outside the details: closed details hide their content from screen readers. -->
<span class="tool-activity-alert" role="alert">{alertText}</span>

<style>
  .tool-activity {
    min-width: 0;
    margin: 6px 0;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-8);
    font-size: var(--type-12);
  }
  summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 9px;
    padding: 8px 10px;
    cursor: pointer;
  }
  .tool-activity-name {
    font-weight: 600;
  }
  .tool-activity-error {
    color: var(--sui-danger-ink);
  }
  .tool-activity-alert {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tool-activity-summary-error {
    flex-basis: 100%;
    color: var(--sui-danger-ink);
    max-height: 3em;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .tool-activity-command {
    flex-basis: 100%;
    min-width: 0;
    overflow: hidden;
    color: inherit;
    font:
      12px/1.5 ui-monospace,
      monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-activity-command::before {
    content: '$ ';
    color: var(--sui-muted);
  }
  .tool-activity-details {
    padding: 0 10px 9px;
  }
  .tool-activity-section {
    margin-top: 8px;
  }
  .tool-activity-section > span {
    color: var(--sui-muted);
    font-size: var(--type-12);
    font-weight: 600;
  }
  pre {
    max-height: 240px;
    margin: 3px 0 0;
    overflow: auto;
    font:
      var(--type-12)/1.5 ui-monospace,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tool-activity-error {
    margin: 8px 0 0;
  }
  .tool-activity-source {
    margin: 8px 0 0;
    color: var(--sui-muted);
  }
</style>

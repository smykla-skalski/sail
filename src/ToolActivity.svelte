<script lang="ts">
  import { toolCommand, toolInput } from './lib/tool-display';

  let {
    title,
    status,
    input,
    output = '',
    error = '',
    source = '',
    expanded = false,
    onfix,
    children,
  }: {
    title: string;
    status: string;
    input?: unknown;
    output?: string;
    error?: string;
    source?: string;
    expanded?: boolean;
    onfix?: () => void;
    children?: import('svelte').Snippet;
  } = $props();

  let open = $state(false);
  $effect(() => {
    if (expanded || status === 'error' || status === 'failed') open = true;
  });
  const command = $derived(toolCommand(input));
  const formattedInput = $derived(toolInput(input));
</script>

<details class="tool-activity" bind:open>
  <summary>
    <span class="tool-activity-name">{title}</span>
    <span class="tool-activity-status" class:failed={status === 'failed' || status === 'error'}
      >{status.replaceAll('_', ' ')}</span
    >
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
      {#if error && onfix}<button class="tool-activity-fix" onclick={onfix}>Fix with agent</button
        >{/if}
      {#if children}{@render children()}{/if}
    </div>
  {/if}
</details>

<style>
  .tool-activity {
    min-width: 0;
    margin: 6px 0;
    border: 1px solid var(--shell-divider, var(--border));
    border-radius: 8px;
    font-size: 12px;
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
  .tool-activity-status {
    color: var(--text-muted, var(--sui-muted));
    font-size: 11px;
  }
  .tool-activity-status.failed,
  .tool-activity-error {
    color: var(--danger, #d66);
  }
  .tool-activity-summary-error {
    flex-basis: 100%;
    color: var(--danger, #d66);
    max-height: 3em;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .tool-activity-command {
    flex-basis: 100%;
    min-width: 0;
    overflow: hidden;
    color: var(--text, inherit);
    font:
      12px/1.5 ui-monospace,
      monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-activity-command::before {
    content: '$ ';
    color: var(--text-muted, var(--sui-muted));
  }
  .tool-activity-details {
    padding: 0 10px 9px;
  }
  .tool-activity-section {
    margin-top: 8px;
  }
  .tool-activity-section > span {
    color: var(--text-muted, var(--sui-muted));
    font-size: 11px;
    font-weight: 600;
  }
  pre {
    max-height: 240px;
    margin: 3px 0 0;
    overflow: auto;
    font:
      11px/1.5 ui-monospace,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tool-activity-error {
    margin: 8px 0 0;
  }
  .tool-activity-source {
    margin: 8px 0 0;
    color: var(--text-muted, var(--sui-muted));
  }
  .tool-activity-fix {
    margin-top: 8px;
    padding: 5px 9px;
    border: 1px solid var(--shell-divider, var(--border));
    border-radius: 6px;
    color: var(--text, inherit);
    background: var(--surface, transparent);
    cursor: pointer;
  }
</style>

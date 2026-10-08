<script lang="ts">
  import type { ShipIssue, ShipRun } from './lib/issue-shipping';
  import {
    shipArchiveAction,
    shipIssueTarget,
    shipMergeAction,
    shipRetryAction,
    shipRunTarget,
    shipStopAction,
    type ShipActionId,
  } from './lib/ship-actions';
  import { shipRunArchived } from './lib/ship-archive';

  let {
    run,
    issue = null,
    onaction,
    onresult,
  }: {
    run: ShipRun;
    issue?: ShipIssue | null;
    onaction: (id: ShipActionId, run: ShipRun, issue: ShipIssue | null) => Promise<string>;
    onresult: (message: string, failed: boolean) => void;
  } = $props();
  let pending = $state<ShipActionId | null>(null);

  async function perform(id: ShipActionId) {
    pending = id;
    try {
      const message = await onaction(id, run, issue);
      if (message) onresult(message, false);
    } catch (cause) {
      onresult(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      pending = null;
    }
  }

  const merge = $derived(issue ? shipMergeAction(issue) : null);
  const retry = $derived(issue ? shipRetryAction(issue) : null);
  const stop = $derived(shipStopAction(run));
  const archive = $derived(shipArchiveAction(run));
</script>

{#snippet action(
  id: ShipActionId,
  label: string,
  name: string,
  state: { enabled: boolean; reason: string | null },
  danger = false,
)}
  <button
    class:danger
    data-ship-action={id}
    aria-label={`${label} ${name}`}
    title={state.reason ?? undefined}
    disabled={!state.enabled || pending !== null}
    onclick={() => perform(id)}>{pending === id ? `${label}…` : label}</button
  >
{/snippet}

{#if issue}
  {#if !shipRunArchived(run)}
    {#if issue.state === 'awaiting_merge' && merge}{@render action(
        'merge',
        'Merge',
        shipIssueTarget(issue),
        merge,
      )}{/if}
    {#if issue.state === 'failed' && retry}{@render action(
        'retry',
        'Retry',
        shipIssueTarget(issue),
        retry,
      )}{/if}
  {/if}
{:else if shipRunArchived(run)}
  <button
    data-ship-action="unarchive"
    aria-label={`Unarchive ${shipRunTarget(run)}`}
    disabled={pending !== null}
    onclick={() => perform('unarchive')}
    >{pending === 'unarchive' ? 'Unarchive…' : 'Unarchive'}</button
  >
{:else}
  {@render action('stop', 'Stop run', shipRunTarget(run), stop, true)}
  {@render action('archive', 'Archive', shipRunTarget(run), archive)}
{/if}

<style>
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--shell-divider);
    border-radius: 6px;
    padding: 5px 10px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.danger {
    border-color: var(--sui-danger);
    color: var(--sui-danger);
  }
  button:focus-visible {
    outline: 2px solid var(--sui-primary);
    outline-offset: 2px;
  }
</style>

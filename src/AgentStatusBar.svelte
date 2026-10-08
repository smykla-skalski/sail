<script lang="ts">
  import { onMount } from 'svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import HarnessIcon from './HarnessIcon.svelte';
  import { agentStatusCounts, resetLabel, type AgentStatusItem } from './lib/agent-status';

  let {
    items,
    attentionCount,
    onopen,
  }: {
    items: AgentStatusItem[];
    attentionCount: number;
    onopen: (key: string) => unknown;
  } = $props();
  let expanded = $state(false);
  let now = $state(Date.now());
  let root: HTMLElement;
  let summary: HTMLButtonElement;
  const counts = $derived(agentStatusCounts(items));
  const label = { working: ' working', need_attention: ' need attention', ready: ' ready' };

  function dismiss(event: MouseEvent) {
    if (expanded && !root.contains(event.target as Node)) expanded = false;
  }

  onMount(() => {
    document.addEventListener('click', dismiss);
    window.addEventListener('keydown', keydown, true);
    const clock = setInterval(() => (now = Date.now()), 60_000);
    return () => {
      document.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', keydown, true);
      clearInterval(clock);
    };
  });

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopImmediatePropagation();
      expanded = false;
      queueMicrotask(() => summary.focus());
    }
  }
</script>

<footer class="agent-status-bar" bind:this={root}>
  <button
    bind:this={summary}
    class="agent-status-summary"
    aria-expanded={expanded}
    aria-controls="agent-status-details"
    onclick={() => {
      expanded = !expanded;
      if (expanded) now = Date.now();
    }}
  >
    <span class="agent-status-title">Agents</span>
    {#if items.length || attentionCount}
      <span
        class="agent-status-counts"
        aria-label={`${counts.working} working, ${attentionCount} need attention, ${counts.ready} ready`}
      >
        {#if counts.working}<span data-state="working"
            >● <b>{counts.working}</b><i>{label.working}</i></span
          >{/if}
        {#if attentionCount}<span data-state="waiting"
            >! <b>{attentionCount}</b><i>{label.need_attention}</i></span
          >{/if}
        {#if counts.ready}<span data-state="ready">✓ <b>{counts.ready}</b><i>{label.ready}</i></span
          >{/if}
      </span>
      <span class="agent-status-providers" aria-hidden="true">
        {#each items.slice(0, 4) as item (item.key)}
          <span
            ><HarnessIcon agent={item.agent} size={13} />{item.context === undefined
              ? item.agentName
              : `${item.context}%`}</span
          >
        {/each}
        {#if items.length > 4}<span>+{items.length - 4}</span>{/if}
      </span>
    {:else}
      <span class="agent-status-idle">No agents running</span>
    {/if}
    <span class="agent-status-chevron" aria-hidden="true">{expanded ? '⌄' : '⌃'}</span>
  </button>

  {#if expanded}
    <section id="agent-status-details" class="agent-status-popover" aria-label="Agent activity">
      <header>
        <strong>Agent activity</strong><span
          >{items.length ? `${items.length} active` : 'All quiet'}</span
        >
      </header>
      <div class="agent-status-list">
        {#each items as item (item.key)}
          <button
            class="agent-status-row"
            onclick={() => {
              expanded = false;
              void onopen(item.key);
            }}
          >
            <span class="agent-status-agent"
              ><HarnessIcon agent={item.agent} /><strong>{item.agentName}</strong></span
            >
            <span class="agent-status-task"
              ><strong>{item.title}</strong><small>{item.location}</small></span
            >
            <span class="agent-status-metrics">
              <ActivityStatus status={item.status} compact />
              {#if item.context !== undefined}<small>Context {item.context}%</small>{/if}
              {#each item.rates as rate (rate.label)}
                {@const reset = resetLabel(rate.resetsAt, now)}
                <small
                  >{rate.label}
                  {rate.remaining}% left{#if reset}
                    · {reset}{/if}</small
                >
              {/each}
            </span>
            <span aria-hidden="true">›</span>
          </button>
        {:else}
          <p>No agents are working or waiting for input.</p>
        {/each}
      </div>
    </section>
  {/if}
</footer>

<style>
  .agent-status-bar {
    position: relative;
    z-index: 5;
    grid-column: 1 / -1;
    min-width: 0;
    border-top: 1px solid var(--shell-divider);
    background: var(--shell-sidebar);
  }
  .agent-status-summary {
    display: flex;
    width: 100%;
    height: 31px;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    border: 0;
    color: var(--sui-foreground);
    background: transparent;
    font: inherit;
    font-size: 11px;
    text-align: left;
  }
  .agent-status-summary:hover {
    background: color-mix(in srgb, var(--sui-primary) 6%, transparent);
  }
  .agent-status-title {
    font-weight: 750;
  }
  .agent-status-counts,
  .agent-status-providers,
  .agent-status-providers span {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 12px;
  }
  .agent-status-counts span,
  .agent-status-providers span {
    white-space: nowrap;
  }
  .agent-status-counts b,
  .agent-status-counts i {
    font-weight: inherit;
    font-style: normal;
  }
  .agent-status-counts [data-state='working'] {
    color: var(--activity-working);
  }
  .agent-status-counts [data-state='waiting'] {
    color: var(--activity-waiting);
  }
  .agent-status-counts [data-state='ready'] {
    color: var(--activity-completed);
  }
  .agent-status-providers {
    margin-left: auto;
    color: var(--shell-muted);
  }
  .agent-status-idle {
    color: var(--shell-muted);
  }
  .agent-status-chevron {
    color: var(--shell-muted);
  }
  .agent-status-popover {
    position: absolute;
    right: 12px;
    bottom: calc(100% + 8px);
    width: min(560px, calc(100vw - 24px));
    overflow: hidden;
    border: 1px solid var(--shell-divider);
    border-radius: 12px;
    background: var(--sui-canvas);
    box-shadow: 0 18px 50px #0004;
  }
  .agent-status-popover header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .agent-status-popover header span,
  .agent-status-task small,
  .agent-status-metrics small,
  .agent-status-list p {
    color: var(--shell-muted);
    font-size: 11px;
  }
  .agent-status-list {
    max-height: min(420px, 65vh);
    overflow: auto;
  }
  .agent-status-list p {
    margin: 0;
    padding: 24px 16px;
    text-align: center;
  }
  .agent-status-row {
    display: grid;
    width: 100%;
    grid-template-columns: 92px minmax(0, 1fr) max-content 10px;
    align-items: center;
    gap: 12px;
    padding: 11px 16px;
    border: 0;
    border-bottom: 1px solid var(--shell-divider);
    color: inherit;
    background: transparent;
    font: inherit;
    text-align: left;
  }
  .agent-status-row:last-child {
    border-bottom: 0;
  }
  .agent-status-row:hover {
    background: var(--shell-selected);
  }
  .agent-status-agent,
  .agent-status-task,
  .agent-status-metrics {
    display: flex;
    min-width: 0;
  }
  .agent-status-agent {
    align-items: center;
    gap: 7px;
    overflow: hidden;
    white-space: nowrap;
  }
  .agent-status-agent strong {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-status-task {
    flex-direction: column;
    gap: 2px;
  }
  .agent-status-task strong,
  .agent-status-task small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-status-metrics {
    align-items: flex-end;
    flex-direction: column;
    gap: 2px;
  }
  @media (max-width: 700px) {
    .agent-status-providers {
      display: none;
    }
    .agent-status-counts {
      margin-left: auto;
    }
    .agent-status-counts i {
      display: none;
    }
    .agent-status-row {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }
    .agent-status-agent strong {
      display: none;
    }
    .agent-status-row > :last-child {
      display: none;
    }
  }
</style>

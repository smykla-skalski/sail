<script lang="ts">
  import type { SessionInfo } from './lib/opencode';
  import Markdown from './Markdown.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import { untrack } from 'svelte';
  import { openCodeErrorDetails } from './lib/tool-failure';
  import type { SpawnReceipt } from './lib/agent-results';
  import { openCodeChildState } from './lib/subagent-runs';
  import {
    emptyOpenCodeChildren,
    openCodeChildActivity,
    openCodeChildReceipts,
    openCodeChildStatusLabel,
    openCodeChildren,
    type OpenCodeChildClient,
    type OpenCodeChildView,
  } from './lib/opencode-children';

  let {
    client,
    parentID,
    directory = null,
    onopen,
    onchildren,
  }: {
    client: OpenCodeChildClient | null;
    parentID: string | null;
    directory?: string | null;
    onopen?: (receipt: SpawnReceipt) => Promise<void>;
    /** Reports every child as a receipt whenever the shared poll changes them. */
    onchildren?: (receipts: SpawnReceipt[]) => void;
  } = $props();
  let snapshot = $state.raw(emptyOpenCodeChildren());
  let expanded = $state<string[]>([]);
  let opening = $state<string[]>([]);
  let openErrors = $state<Record<string, string>>({});
  let view: OpenCodeChildView | null = null;
  const {
    children,
    active,
    summaries,
    histories,
    historyCursors,
    historyErrors,
    childCursor,
    loadingOlderChildren,
    loadingOlderHistory,
    loadError,
  } = $derived(snapshot);
  const running = $derived(children.filter((child) => active.includes(child.id)));
  const finished = $derived(children.filter((child) => !active.includes(child.id)));
  const receipts = $derived(
    parentID && directory ? openCodeChildReceipts(parentID, directory, snapshot) : [],
  );

  $effect(() => {
    expanded = [];
    snapshot = emptyOpenCodeChildren();
    if (!client || !parentID) return;
    const current = openCodeChildren.watch(client, parentID, (next) => (snapshot = next));
    view = current;
    return () => {
      current.close();
      if (view === current) view = null;
    };
  });

  $effect(() => {
    const next = receipts;
    untrack(() => onchildren?.(next));
    return () => untrack(() => onchildren?.([]));
  });

  function toggle(id: string) {
    expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
    if (expanded.includes(id)) view?.expand(id);
    else view?.collapse(id);
  }

  function stateOf(child: SessionInfo) {
    return openCodeChildState(child, active);
  }

  async function open(child: SessionInfo) {
    const receipt = receipts.find((item) => item.receiptId === `opencode-child:${child.id}`);
    if (!onopen || !receipt || opening.includes(child.id)) return;
    opening = [...opening, child.id];
    const next = { ...openErrors };
    delete next[child.id];
    openErrors = next;
    try {
      await onopen(receipt);
    } catch (cause) {
      openErrors = {
        ...openErrors,
        [child.id]: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      opening = opening.filter((id) => id !== child.id);
    }
  }
</script>

{#snippet row(child: SessionInfo)}
  {@const childState = stateOf(child)}
  <div class="subagent">
    <div class="subagent-heading">
      <button
        class="subagent-toggle"
        aria-expanded={expanded.includes(child.id)}
        onclick={() => toggle(child.id)}
      >
        <span aria-hidden="true">{expanded.includes(child.id) ? '▾' : '▸'}</span>
        <strong>{child.title ?? child.agent ?? 'Subagent'}</strong>
        <ActivityStatus status={childState} label={openCodeChildStatusLabel(childState)} compact />
      </button>
      {#if onopen && directory}<button
          class="subagent-open"
          aria-label={`Open OpenCode subagent thread for ${child.title ?? child.agent ?? 'Subagent'}`}
          disabled={opening.includes(child.id)}
          onclick={() => void open(child)}
          >{opening.includes(child.id) ? 'Opening…' : 'Open'}</button
        >{/if}
    </div>
    <p class="subagent-activity">{openCodeChildActivity(childState, summaries[child.id])}</p>
    {#if openErrors[child.id]}<p class="subagent-error" role="alert">
        Thread unavailable — {openErrors[child.id]}
      </p>{/if}
    {#if expanded.includes(child.id)}
      <div class="subagent-history">
        {#if historyErrors[child.id]}<p class="subagent-error" role="alert">
            {historyErrors[child.id]}
            <button onclick={() => void view?.loadHistory(child.id)}>Retry</button>
          </p>{/if}
        {#if historyCursors[child.id]}<button
            class="load-older"
            disabled={loadingOlderHistory.includes(child.id)}
            onclick={() => void view?.loadHistory(child.id, historyCursors[child.id]!)}
            >{loadingOlderHistory.includes(child.id) ? 'Loading…' : 'Load earlier activity'}</button
          >{/if}
        {#each histories[child.id] ?? [] as message (message.id)}
          {#if message.type === 'assistant'}
            {#each message.content as part, index (index)}
              {#if part.type === 'text'}<Markdown source={part.text} />{/if}
              {#if part.type === 'tool'}
                <ToolActivity
                  title={part.name}
                  status={part.state.status}
                  input={part.state.input}
                  output={part.state.status === 'completed' || part.state.status === 'error'
                    ? (part.state.content ?? [])
                        .map((item) => (item.type === 'text' ? item.text : (item.name ?? item.uri)))
                        .join('\n')
                    : ''}
                  error={part.state.status === 'error'
                    ? openCodeErrorDetails(part.state.error)
                    : ''}
                />
              {/if}
            {/each}
          {:else if message.type === 'user'}
            <p class="subagent-prompt">{message.text}</p>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#if children.length || loadError}
  <section class="subagents" aria-label="OpenCode subagents">
    <div class="subagents-heading">Subagents · {children.length}</div>
    {#if loadError}<p class="subagent-error" role="alert">{loadError}</p>{/if}
    {#if running.length}
      <div class="subagent-group" role="group" aria-label="Running subagents">
        <div class="subagent-group-heading">Running · {running.length}</div>
        {#each running as child (child.id)}{@render row(child)}{/each}
      </div>
    {/if}
    {#if finished.length}
      <div class="subagent-group" role="group" aria-label="Finished subagents">
        <div class="subagent-group-heading">Finished · {finished.length}</div>
        {#each finished as child (child.id)}{@render row(child)}{/each}
      </div>
    {/if}
    {#if childCursor}<button
        class="load-older"
        disabled={loadingOlderChildren}
        onclick={() => void view?.loadOlderChildren()}
        >{loadingOlderChildren ? 'Loading…' : 'Load older subagents'}</button
      >{/if}
  </section>
{/if}

<style>
  .subagents {
    margin: 12px 0 18px 44px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
    overflow: hidden;
  }
  .subagents-heading {
    padding: 9px 12px;
    font-size: 12px;
    font-weight: 700;
    border-bottom: 1px solid var(--shell-divider);
  }
  .subagent-group-heading {
    padding: 6px 12px;
    color: var(--text-muted, var(--sui-muted));
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--shell-divider, var(--border));
  }
  .subagent-group + .subagent-group {
    border-top: 1px solid var(--shell-divider, var(--border));
  }
  .subagent + .subagent {
    border-top: 1px solid var(--shell-divider);
  }
  .subagent-heading {
    display: flex;
    align-items: center;
  }
  .subagent-open {
    flex: none;
    margin-right: 8px;
    padding: 3px 6px;
    border: 0;
    color: var(--sui-accent);
    background: transparent;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .subagent-open:disabled {
    cursor: wait;
    opacity: 0.6;
  }
  .subagent-toggle {
    flex: 1;
    min-width: 0;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px 3px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .subagent-toggle strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .subagent-activity {
    color: var(--sui-muted);
    font-size: 11px;
  }
  .subagent-activity {
    margin: 0;
    padding: 0 12px 9px 30px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subagent-history {
    max-height: 450px;
    overflow: auto;
    padding: 8px 14px 14px 30px;
    border-top: 1px solid var(--shell-divider);
  }
  .subagent-prompt {
    color: var(--sui-muted);
  }
  .subagent-error {
    color: var(--sui-danger-ink);
    padding: 0 12px;
    font-size: 12px;
  }
  .load-older {
    margin: 8px 12px;
    padding: 6px 8px;
    border: 1px solid var(--shell-divider);
    border-radius: 6px;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }
</style>

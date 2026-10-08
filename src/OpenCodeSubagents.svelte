<script lang="ts">
  import type { SessionInfo } from './lib/opencode';
  import Markdown from './Markdown.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import { activityState } from './lib/activity-state';
  import { openCodeErrorDetails } from './lib/tool-failure';
  import {
    emptyOpenCodeChildren,
    openCodeChildren,
    type OpenCodeChildClient,
    type OpenCodeChildView,
  } from './lib/opencode-children';

  let { client, parentID }: { client: OpenCodeChildClient | null; parentID: string | null } =
    $props();
  let snapshot = $state.raw(emptyOpenCodeChildren());
  let expanded = $state<string[]>([]);
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

  function toggle(id: string) {
    expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
    if (expanded.includes(id)) view?.expand(id);
    else view?.collapse(id);
  }

  function activity(child: SessionInfo): string {
    const last = summaries[child.id];
    if (!last || last.type !== 'assistant')
      return active.includes(child.id)
        ? 'Thinking'
        : activityState(child.outcome ?? 'queued').label;
    const part = last.content.findLast((item) => item.type === 'tool' || item.type === 'text');
    if (part?.type === 'tool') return `${part.name} · ${part.state.status}`;
    if (part?.type === 'text') return part.text.slice(0, 160);
    return active.includes(child.id) ? 'Thinking' : activityState(child.outcome ?? 'queued').label;
  }
</script>

{#if children.length || loadError}
  <section class="subagents" aria-label="OpenCode subagents">
    <div class="subagents-heading">Subagents · {children.length}</div>
    {#if loadError}<p class="subagent-error" role="alert">{loadError}</p>{/if}
    {#each children as child (child.id)}
      <div class="subagent">
        <button
          class="subagent-toggle"
          aria-expanded={expanded.includes(child.id)}
          onclick={() => toggle(child.id)}
        >
          <span aria-hidden="true">{expanded.includes(child.id) ? '▾' : '▸'}</span>
          <strong>{child.title ?? child.agent ?? 'Subagent'}</strong>
          <ActivityStatus
            status={active.includes(child.id) ? 'working' : (child.outcome ?? 'queued')}
            compact
          />
        </button>
        <p class="subagent-activity">{activity(child)}</p>
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
                >{loadingOlderHistory.includes(child.id)
                  ? 'Loading…'
                  : 'Load earlier activity'}</button
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
                            .map((item) =>
                              item.type === 'text' ? item.text : (item.name ?? item.uri),
                            )
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
    {/each}
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
  .subagent + .subagent {
    border-top: 1px solid var(--shell-divider);
  }
  .subagent-toggle {
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

<script lang="ts">
  import { onMount } from 'svelte';
  import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from './lib/opencode';
  import Markdown from './Markdown.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import { openCodeErrorDetails } from './lib/tool-failure';
  import { mergeMessages } from './lib/timeline';

  let { client, parentID }: { client: OpenCodeClient | null; parentID: string | null } = $props();
  let children = $state<SessionInfo[]>([]);
  let active = $state<string[]>([]);
  let summaries = $state<Record<string, SessionMessageInfo>>({});
  let histories = $state<Record<string, SessionMessageInfo[]>>({});
  let historyCursors = $state<Record<string, string | null>>({});
  let historyErrors = $state<Record<string, string>>({});
  let childCursor = $state<string | null>(null);
  let loadingOlderChildren = $state(false);
  let loadingOlderHistory = $state<string[]>([]);
  let loadError = $state('');
  let expanded = $state<string[]>([]);
  let generation = 0;
  let refreshing = false;

  async function loadSummaries(source: OpenCodeClient, sessions: SessionInfo[], current: number) {
    const snapshots = await Promise.all(
      sessions.map(async (child) => {
        const response = await source.message.list({
          sessionID: child.id,
          limit: 1,
          order: 'desc',
          type: 'assistant',
        });
        return [child.id, response.data[0]] as const;
      }),
    );
    if (current !== generation) return;
    summaries = {
      ...summaries,
      ...Object.fromEntries(snapshots.filter((entry) => entry[1])),
    };
  }

  async function loadHistory(id: string, cursor?: string) {
    if (!client || !parentID || loadingOlderHistory.includes(id)) return;
    const source = client;
    const current = generation;
    loadingOlderHistory = [...loadingOlderHistory, id];
    try {
      const page = await source.message.list({
        sessionID: id,
        limit: 25,
        order: 'desc',
        ...(cursor ? { cursor } : {}),
      });
      if (current !== generation) return;
      histories = { ...histories, [id]: mergeMessages(histories[id] ?? [], page.data) };
      if (cursor || !(id in historyCursors))
        historyCursors = { ...historyCursors, [id]: page.cursor.next ?? null };
      const nextErrors = { ...historyErrors };
      delete nextErrors[id];
      historyErrors = nextErrors;
    } catch (cause) {
      if (current === generation) historyErrors = { ...historyErrors, [id]: String(cause) };
    } finally {
      if (current === generation)
        loadingOlderHistory = loadingOlderHistory.filter((item) => item !== id);
    }
  }

  async function loadOlderChildren() {
    if (!client || !parentID || !childCursor || loadingOlderChildren) return;
    const source = client;
    const current = generation;
    const cursor = childCursor;
    loadingOlderChildren = true;
    try {
      const page = await source.session.list({ parentID, limit: 50, order: 'desc', cursor });
      if (current !== generation) return;
      const known = new Set(children.map((child) => child.id));
      children = [...children, ...page.data.filter((child) => !known.has(child.id))];
      childCursor = page.cursor.next === cursor ? null : (page.cursor.next ?? null);
      await loadSummaries(source, page.data, current);
      loadError = '';
    } catch (cause) {
      if (current === generation) loadError = String(cause);
    } finally {
      if (current === generation) loadingOlderChildren = false;
    }
  }

  async function refresh() {
    if (!client || !parentID || refreshing) return;
    const source = client;
    const current = generation;
    refreshing = true;
    try {
      const [sessions, running] = await Promise.all([
        source.session.list({ parentID, limit: 50, order: 'desc' }),
        source.session.active(),
      ]);
      if (current !== generation) return;
      const firstPage = new Set(sessions.data.map((child) => child.id));
      children = [...sessions.data, ...children.filter((child) => !firstPage.has(child.id))];
      if (children.length === sessions.data.length) childCursor = sessions.cursor.next ?? null;
      active = Object.keys(running);
      await Promise.all([
        loadSummaries(source, sessions.data, current),
        ...expanded.map((id) => loadHistory(id)),
      ]);
      loadError = '';
    } catch (cause) {
      if (current === generation) loadError = String(cause);
    } finally {
      if (current === generation) refreshing = false;
    }
  }

  $effect(() => {
    ++generation;
    refreshing = false;
    expanded = [];
    children = [];
    summaries = {};
    histories = {};
    historyCursors = {};
    historyErrors = {};
    childCursor = null;
    loadingOlderChildren = false;
    loadingOlderHistory = [];
    loadError = '';
    if (client && parentID) void refresh();
  });

  onMount(() => {
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(timer);
      ++generation;
    };
  });

  function toggle(id: string) {
    expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
    if (expanded.includes(id)) void loadHistory(id);
  }

  function activity(id: string): string {
    const last = summaries[id];
    if (!last || last.type !== 'assistant') return active.includes(id) ? 'Thinking' : 'Finished';
    const part = last.content.findLast((item) => item.type === 'tool' || item.type === 'text');
    if (part?.type === 'tool') return `${part.name} · ${part.state.status}`;
    if (part?.type === 'text') return part.text.slice(0, 160);
    return active.includes(id) ? 'Thinking' : 'Finished';
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
          <span class="subagent-state"
            >{active.includes(child.id) ? 'Running' : (child.outcome ?? 'Finished')}</span
          >
        </button>
        <p class="subagent-activity">{activity(child.id)}</p>
        {#if expanded.includes(child.id)}
          <div class="subagent-history">
            {#if historyErrors[child.id]}<p class="subagent-error" role="alert">
                {historyErrors[child.id]}
                <button onclick={() => void loadHistory(child.id)}>Retry</button>
              </p>{/if}
            {#if historyCursors[child.id]}<button
                class="load-older"
                disabled={loadingOlderHistory.includes(child.id)}
                onclick={() => void loadHistory(child.id, historyCursors[child.id]!)}
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
        onclick={() => void loadOlderChildren()}
        >{loadingOlderChildren ? 'Loading…' : 'Load older subagents'}</button
      >{/if}
  </section>
{/if}

<style>
  .subagents {
    margin: 12px 0 18px 44px;
    border: 1px solid var(--shell-divider, var(--border));
    border-radius: 8px;
    overflow: hidden;
  }
  .subagents-heading {
    padding: 9px 12px;
    font-size: 12px;
    font-weight: 700;
    border-bottom: 1px solid var(--shell-divider, var(--border));
  }
  .subagent + .subagent {
    border-top: 1px solid var(--shell-divider, var(--border));
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
  .subagent-state,
  .subagent-activity {
    color: var(--text-muted, var(--sui-muted));
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
    border-top: 1px solid var(--shell-divider, var(--border));
  }
  .subagent-prompt {
    color: var(--text-muted, var(--sui-muted));
  }
  .subagent-error {
    color: var(--danger, #d66);
    padding: 0 12px;
    font-size: 12px;
  }
  .load-older {
    margin: 8px 12px;
    padding: 6px 8px;
    border: 1px solid var(--shell-divider, var(--border));
    border-radius: 6px;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }
</style>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { OpenCodeClient, SessionInfo, SessionMessageInfo } from './lib/opencode';
  import Markdown from './Markdown.svelte';
  import ToolActivity from './ToolActivity.svelte';

  let { client, parentID }: { client: OpenCodeClient | null; parentID: string | null } = $props();
  let children = $state<SessionInfo[]>([]);
  let active = $state<string[]>([]);
  let latest = $state<Record<string, SessionMessageInfo[]>>({});
  let expanded = $state<string[]>([]);
  let request = 0;

  async function refresh() {
    if (!client || !parentID) {
      children = [];
      latest = {};
      return;
    }
    const current = ++request;
    try {
      const [sessions, running] = await Promise.all([
        client.session.list({ parentID, limit: 50, order: 'desc' }),
        client.session.active(),
      ]);
      if (current !== request) return;
      children = sessions.data;
      active = Object.keys(running);
      const snapshots = await Promise.all(
        sessions.data.map(async (child) => {
          const messages = await client!.message.list({
            sessionID: child.id,
            limit: expanded.includes(child.id) ? 25 : 1,
            order: 'desc',
          });
          return [child.id, messages.data.toReversed()] as const;
        }),
      );
      if (current === request) latest = Object.fromEntries(snapshots);
    } catch {
      // Child sessions are supplementary to the parent conversation.
    }
  }

  $effect(() => {
    expanded = [];
    if (client && parentID) void refresh();
    else {
      children = [];
      latest = {};
    }
  });

  onMount(() => {
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(timer);
      ++request;
    };
  });

  function toggle(id: string) {
    expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
    void refresh();
  }

  function activity(id: string): string {
    const last = latest[id]?.at(-1);
    if (!last || last.type !== 'assistant')
      return active.includes(id) ? 'Thinking' : 'No activity yet';
    const part = last.content.at(-1);
    if (part?.type === 'tool') return `${part.name} · ${part.state.status}`;
    if (part?.type === 'text') return part.text.slice(0, 160);
    return active.includes(id) ? 'Thinking' : 'Finished';
  }
</script>

{#if children.length}
  <section class="subagents" aria-label="OpenCode subagents">
    <div class="subagents-heading">Subagents · {children.length}</div>
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
            {#each latest[child.id] ?? [] as message (message.id)}
              {#if message.type === 'assistant'}
                {#each message.content as part, index (index)}
                  {#if part.type === 'text'}<Markdown source={part.text} />{/if}
                  {#if part.type === 'tool'}
                    <ToolActivity
                      title={part.name}
                      status={part.state.status}
                      input={part.state.input}
                      output={part.state.status === 'completed'
                        ? (part.state.content ?? [])
                            .map((item) =>
                              item.type === 'text' ? item.text : (item.name ?? item.uri),
                            )
                            .join('\n')
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
</style>

<script lang="ts">
  import { Button } from '@smykla-skalski/sui';
  import ActivityStatus from './ActivityStatus.svelte';
  import { activityWorkspaces, type ActivityHistoryEvent } from './lib/activity-history';

  let {
    events,
    loading,
    error,
    onrefresh,
    onselect,
  }: {
    events: ActivityHistoryEvent[];
    loading: boolean;
    error: string;
    onrefresh: () => void;
    onselect: (event: ActivityHistoryEvent) => void | Promise<void>;
  } = $props();
  const workspaces = $derived(activityWorkspaces(events));
  let opening = $state('');
  let selectionError = $state('');

  function name(path: string): string {
    return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
  }

  async function select(event: ActivityHistoryEvent) {
    if (opening) return;
    opening = event.id;
    selectionError = '';
    try {
      await onselect(event);
    } catch (cause) {
      selectionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      opening = '';
    }
  }
</script>

<aside class="history-panel" aria-label="Workspace activity history">
  <header class="history-heading">
    <div>
      <p class="eyebrow">WORKSPACE HISTORY</p>
      <h2>Activity</h2>
    </div>
    <Button size="sm" variant="ghost" onclick={onrefresh} disabled={loading}
      >{loading ? 'Refreshing…' : 'Refresh'}</Button
    >
  </header>
  <p class="history-summary">Durable threads, tools, decisions, children, and checks.</p>
  {#if error}<p class="history-error" role="status">History unavailable: {error}</p>{/if}
  {#if selectionError}<p class="history-error" role="alert">{selectionError}</p>{/if}
  <div class="history-list">
    {#each workspaces as workspace (workspace)}
      <section aria-label={`${name(workspace)} activity`}>
        <h3><span>{name(workspace)}</span><small>{workspace}</small></h3>
        <ol>
          {#each events.filter((event) => event.workspace === workspace) as event (event.id)}
            <li>
              <button
                aria-label={`Open ${event.kind} activity: ${event.title}`}
                data-activity-id={event.id}
                disabled={!!opening}
                onclick={() => void select(event)}
              >
                <ActivityStatus status={event.outcome} compact />
                <span class="event-copy">
                  <strong>{event.title}</strong>
                  <small>{event.source} · {event.kind} · {event.outcome.replaceAll('_', ' ')}</small
                  >
                </span>
                <time datetime={new Date(event.at).toISOString()}
                  >{new Date(event.at).toLocaleString()}</time
                >
              </button>
            </li>
          {/each}
        </ol>
      </section>
    {:else}
      <p class="history-empty">
        {loading ? 'Loading activity…' : 'No durable workspace activity recorded yet.'}
      </p>
    {/each}
  </div>
</aside>

<style>
  .history-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--sui-surface);
  }
  .history-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    padding: 16px 20px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .eyebrow {
    margin: 0 0 3px;
    color: var(--sui-primary);
    font-size: var(--type-12);
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .history-summary,
  .history-error,
  .history-empty {
    margin: 12px 20px 0;
    color: var(--sui-muted);
    font-size: var(--type-12);
    line-height: 1.5;
  }
  .history-error[role='alert'] {
    color: var(--sui-danger-ink);
  }
  .history-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px 20px;
  }
  section + section {
    margin-top: 18px;
  }
  h3 {
    display: grid;
    gap: 2px;
    margin: 0 4px 7px;
    font-size: var(--type-12);
  }
  h3 small {
    overflow: hidden;
    color: var(--sui-muted);
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ol {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 5px 8px;
    width: 100%;
    min-height: 52px;
    padding: 9px;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-8);
    color: inherit;
    background: color-mix(in srgb, var(--sui-surface) 94%, var(--sui-primary));
    text-align: left;
    cursor: pointer;
  }
  li button:hover,
  li button:focus-visible {
    border-color: var(--sui-primary);
  }
  .event-copy {
    display: grid;
    min-width: 0;
    gap: 2px;
  }
  .event-copy strong,
  .event-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .event-copy small,
  time {
    color: var(--sui-muted);
    font-size: var(--type-12);
  }
  time {
    grid-column: 2;
  }
</style>

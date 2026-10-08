<script lang="ts">
  import { Button } from '@smykla-skalski/sui';
  import ActivityStatus from './ActivityStatus.svelte';
  import type { ActivityHistoryEvent } from './lib/activity-history';
  import {
    activityHistoryWithoutLiveItems,
    activitySectionItems,
    type WorkspaceActivityItem,
    type WorkspaceActivitySection,
  } from './lib/workspace-activity';

  let {
    items,
    events = [],
    agent,
    sessionId,
    loading = false,
    error = '',
    onrefresh = () => {},
    onselect,
    onselecthistory = () => {},
  }: {
    items: WorkspaceActivityItem[];
    events?: ActivityHistoryEvent[];
    agent?: string;
    sessionId?: string;
    loading?: boolean;
    error?: string;
    onrefresh?: () => void;
    onselect: (item: WorkspaceActivityItem) => void | Promise<void>;
    onselecthistory?: (event: ActivityHistoryEvent) => void | Promise<void>;
  } = $props();
  const componentId = $props.id();
  const sections: { id: WorkspaceActivitySection; label: string }[] = [
    { id: 'now', label: 'Now' },
    { id: 'needs-input', label: 'Needs input' },
    { id: 'recent', label: 'Recent' },
  ];
  const recentEvents = $derived(activityHistoryWithoutLiveItems(items, events, agent, sessionId));
  let opening = $state('');
  let selectionError = $state('');

  async function select(id: string, action: () => void | Promise<void>): Promise<void> {
    if (opening) return;
    opening = id;
    selectionError = '';
    try {
      await action();
    } catch (cause) {
      selectionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      opening = '';
    }
  }
</script>

<aside class="workspace-activity" aria-label="Workspace activity">
  <header>
    <div>
      <p class="eyebrow">WORKSPACE ACTIVITY</p>
      <h2>Activity</h2>
    </div>
    <Button size="sm" variant="ghost" onclick={onrefresh} disabled={loading}
      >{loading ? 'Refreshing…' : 'Refresh'}</Button
    >
  </header>
  <p class="summary">Current work, required input, and durable history.</p>
  {#if error}<p class="activity-error" role="status">Activity unavailable: {error}</p>{/if}
  {#if selectionError}<p class="activity-error" role="alert">{selectionError}</p>{/if}
  <div class="activity-sections">
    {#each sections as section (section.id)}
      {@const sectionItems = activitySectionItems(items, section.id)}
      <section aria-labelledby={`${componentId}-${section.id}`}>
        <h3 id={`${componentId}-${section.id}`}>
          {section.label}<span>{sectionItems.length}</span>
        </h3>
        {#if sectionItems.length}
          <ul>
            {#each sectionItems as item, index (item.id)}
              <li>
                <button
                  aria-label={`Open ${section.label} ${item.kind} ${index + 1}: ${item.title}`}
                  data-workspace-activity-id={item.id}
                  disabled={!!opening}
                  onclick={() => void select(item.id, () => onselect(item))}
                >
                  <ActivityStatus status={item.status} compact />
                  <span class="activity-copy">
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <span class="activity-kind">{item.kind}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p>Nothing here.</p>
        {/if}
      </section>
    {/each}
    <section aria-labelledby={`${componentId}-earlier`}>
      <h3 id={`${componentId}-earlier`}>Earlier<span>{recentEvents.length}</span></h3>
      {#if recentEvents.length}
        <ul>
          {#each recentEvents as event (event.id)}
            <li>
              <button
                aria-label={`Open ${event.kind} activity: ${event.title}`}
                data-activity-id={event.id}
                disabled={!!opening}
                onclick={() => void select(event.id, () => onselecthistory(event))}
              >
                <ActivityStatus status={event.outcome} compact />
                <span class="activity-copy">
                  <strong>{event.title}</strong>
                  <small>{event.source} · {event.workspace}</small>
                </span>
                <time datetime={new Date(event.at).toISOString()}
                  >{new Date(event.at).toLocaleString()}</time
                >
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p>{loading ? 'Loading activity…' : 'No earlier activity recorded.'}</p>
      {/if}
    </section>
  </div>
</aside>

<style>
  .workspace-activity {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--sui-surface);
  }
  header {
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
  .summary,
  .activity-error {
    margin: 12px 20px 0;
    color: var(--sui-muted);
    font-size: var(--type-12);
    line-height: 1.5;
  }
  .activity-error[role='alert'] {
    color: var(--sui-danger-ink);
  }
  .activity-sections {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 16px 20px;
  }
  section + section {
    margin-top: 16px;
  }
  h3 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0 4px 6px;
    color: var(--sui-muted);
    font-size: var(--type-12);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  h3 span {
    font-size: var(--type-12);
  }
  ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--space-8);
    width: 100%;
    min-height: 48px;
    padding: 9px;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-8);
    color: inherit;
    background: color-mix(in srgb, var(--sui-surface) 94%, var(--sui-primary));
    text-align: left;
  }
  li button:hover,
  li button:focus-visible {
    border-color: var(--sui-primary);
  }
  .activity-copy {
    display: grid;
    min-width: 0;
    gap: 2px;
  }
  .activity-copy strong,
  .activity-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .activity-copy small,
  .activity-kind,
  time,
  section > p {
    color: var(--sui-muted);
    font-size: var(--type-12);
  }
  .activity-kind {
    text-transform: capitalize;
  }
  time {
    max-width: 108px;
    text-align: right;
  }
  section > p {
    margin: 8px 4px;
  }
  @media (max-width: 520px) {
    header {
      padding: 12px 14px;
    }
    .summary,
    .activity-error {
      margin-inline: 14px;
    }
    .activity-sections {
      padding-inline: 10px;
    }
    li button {
      min-height: 44px;
    }
  }
</style>

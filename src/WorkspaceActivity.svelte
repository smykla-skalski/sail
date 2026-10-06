<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import {
    activitySectionItems,
    type WorkspaceActivityItem,
    type WorkspaceActivitySection,
  } from './lib/workspace-activity';
  import { getSetting, setSetting } from './lib/settings';

  let {
    items,
    storageKey,
    onselect,
  }: {
    items: WorkspaceActivityItem[];
    storageKey: string;
    onselect: (item: WorkspaceActivityItem) => void | Promise<void>;
  } = $props();
  let open = $state(false);
  let explicitPreference = $state(false);
  let mounted = $state(false);
  let compact = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let selectionError = $state('');
  let loadedKey = '';
  const panelId = `workspace-activity-${crypto.randomUUID()}`;
  const sections: { id: WorkspaceActivitySection; label: string }[] = [
    { id: 'now', label: 'Now' },
    { id: 'needs-input', label: 'Needs input' },
    { id: 'recent', label: 'Recent' },
  ];
  const attentionCount = $derived(items.filter((item) => item.section === 'needs-input').length);

  function loadPreference() {
    selectionError = '';
    const saved = storageKey.startsWith('sai-')
      ? getSetting(storageKey)
      : localStorage.getItem(storageKey);
    explicitPreference = saved === 'open' || saved === 'closed';
    open = saved === 'open' || (!explicitPreference && !compact && items.length > 0);
    loadedKey = storageKey;
  }

  onMount(() => {
    const media = window.matchMedia('(max-width: 850px)');
    compact = media.matches;
    loadPreference();
    mounted = true;
    const changed = (event: MediaQueryListEvent) => {
      compact = event.matches;
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  });

  $effect(() => {
    if (mounted && storageKey !== loadedKey) loadPreference();
    if (mounted && !explicitPreference) open = !compact && items.length > 0;
  });

  function setOpen(next: boolean, restoreFocus = false) {
    if (next) selectionError = '';
    open = next;
    explicitPreference = true;
    if (storageKey.startsWith('sai-')) setSetting(storageKey, next ? 'open' : 'closed');
    else localStorage.setItem(storageKey, next ? 'open' : 'closed');
    if (restoreFocus) void tick().then(() => trigger?.focus());
  }

  async function select(item: WorkspaceActivityItem) {
    selectionError = '';
    try {
      await onselect(item);
      if (compact) setOpen(false, true);
    } catch (cause) {
      selectionError = `Could not open activity: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setOpen(false, true);
    }
  }}
/>

<div class="workspace-activity" class:open>
  {#if !open}
    <button
      class="activity-toggle"
      bind:this={trigger}
      aria-expanded="false"
      onclick={() => setOpen(true)}
    >
      <span>Activity</span>
      {#if attentionCount}<strong aria-label={`${attentionCount} need input`}
          >{attentionCount}</strong
        >{:else if items.length}<span class="activity-count">{items.length}</span>{/if}
    </button>
  {:else}
    <button
      class="activity-backdrop"
      aria-label="Close workspace activity"
      onclick={() => setOpen(false, true)}
    ></button>
    <aside id={panelId} aria-label="Workspace activity">
      <header>
        <div><strong>Activity</strong><span>{items.length}</span></div>
        <button
          class="activity-close"
          bind:this={trigger}
          aria-expanded="true"
          aria-controls={panelId}
          aria-label="Close workspace activity"
          onclick={() => setOpen(false, true)}>×</button
        >
      </header>
      {#if selectionError}<p class="activity-error" role="alert">{selectionError}</p>{/if}
      <div class="activity-sections">
        {#each sections as section (section.id)}
          {@const sectionItems = activitySectionItems(items, section.id)}
          <section aria-labelledby={`${panelId}-${section.id}`}>
            <h2 id={`${panelId}-${section.id}`}>
              {section.label}<span>{sectionItems.length}</span>
            </h2>
            {#if sectionItems.length}
              <ul>
                {#each sectionItems as item, index (item.id)}
                  <li>
                    <button
                      aria-label={`Open ${section.label} ${item.kind} ${index + 1}: ${item.title}`}
                      onclick={() => void select(item)}
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
      </div>
    </aside>
  {/if}
</div>

<style>
  .workspace-activity {
    display: flex;
    flex: 0 0 auto;
    min-width: 0;
    border-left: 1px solid var(--shell-divider, var(--border));
    background: var(--sui-surface);
  }
  .workspace-activity.open {
    width: min(300px, 38%);
  }
  .activity-toggle {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 8px 10px;
    border: 0;
    color: inherit;
    background: transparent;
    cursor: pointer;
    writing-mode: vertical-rl;
  }
  .activity-backdrop {
    display: none;
  }
  .activity-toggle strong,
  .activity-count {
    display: grid;
    place-items: center;
    min-width: 20px;
    min-height: 20px;
    border-radius: 999px;
    color: var(--sui-primary-foreground);
    background: var(--activity-waiting, #b87900);
    font-size: 11px;
    writing-mode: horizontal-tb;
  }
  .activity-count {
    color: var(--sui-muted);
    background: var(--shell-selected, #7772);
  }
  aside {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;
    padding: 0 10px 0 14px;
    border-bottom: 1px solid var(--shell-divider, var(--border));
  }
  header div {
    display: flex;
    align-items: baseline;
    gap: 7px;
  }
  header span,
  h2 span {
    color: var(--sui-muted);
    font-size: 11px;
  }
  .activity-close {
    width: 36px;
    height: 36px;
    border: 0;
    color: inherit;
    background: transparent;
    font-size: 20px;
    cursor: pointer;
  }
  .activity-sections {
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }
  section + section {
    margin-top: 12px;
  }
  h2 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 0 4px 5px;
    color: var(--sui-muted);
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  ul {
    display: grid;
    gap: 5px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 8px;
    border: 1px solid var(--shell-divider, var(--border));
    border-radius: 8px;
    color: inherit;
    background: color-mix(in srgb, var(--sui-surface) 92%, var(--sui-primary));
    text-align: left;
    cursor: pointer;
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
  p {
    color: var(--sui-muted);
    font-size: 11px;
  }
  .activity-kind {
    text-transform: capitalize;
  }
  p {
    margin: 8px 4px;
  }
  .activity-error {
    margin: 8px 12px 0;
    color: var(--sui-destructive, #c33);
  }
  @media (max-width: 850px) {
    .workspace-activity {
      position: absolute;
      right: 8px;
      bottom: 8px;
      z-index: 5;
      border: 0;
      background: transparent;
    }
    .workspace-activity.open {
      inset: 0;
      width: auto;
      align-items: flex-end;
      background: color-mix(in srgb, #000 42%, transparent);
    }
    .activity-backdrop {
      position: absolute;
      inset: 0;
      display: block;
      border: 0;
      background: transparent;
    }
    .activity-toggle {
      flex-direction: row;
      border: 1px solid var(--shell-divider, var(--border));
      border-radius: 999px;
      background: var(--sui-surface);
      box-shadow: 0 4px 18px #0004;
      writing-mode: horizontal-tb;
    }
    aside {
      z-index: 1;
      flex: 0 0 auto;
      width: 100%;
      max-height: min(72%, 560px);
      border: 1px solid var(--shell-divider, var(--border));
      border-radius: 16px 16px 0 0;
      background: var(--sui-surface);
      box-shadow: 0 -10px 30px #0005;
    }
  }
</style>

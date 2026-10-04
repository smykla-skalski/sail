<script lang="ts">
  import { isInboxOutcome, type InboxItem } from './lib/inbox';

  interface Props {
    items: InboxItem[];
    loading: boolean;
    error: string;
    onopen: (item: InboxItem) => void;
    ondecide: (item: InboxItem, optionId: string | null) => Promise<void>;
  }

  let { items, loading, error: loadError, onopen, ondecide }: Props = $props();
  let busyKey = $state<string | null>(null);
  let error = $state('');
  let pending = $derived(items.filter((item) => !isInboxOutcome(item)));
  let recent = $derived(items.filter(isInboxOutcome).toReversed());
  let recentGroups = $derived(
    recent.reduce<Record<string, InboxItem[]>>((groups, item) => {
      const key = item.directory;
      (groups[key] ??= []).push(item);
      return groups;
    }, {}),
  );

  async function decide(item: InboxItem, optionId: string | null) {
    busyKey = item.key;
    error = '';
    try {
      await ondecide(item, optionId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busyKey = null;
    }
  }
</script>

<section class="inbox-panel" aria-label="Inbox across projects">
  <header class="inbox-header">
    <h2>Waiting for you</h2>
    <span>{pending.length}</span>
  </header>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if loading && !items.length}<p role="status">Checking all projects…</p>{/if}
  {#if !loading && !pending.length && !loadError}<p class="inbox-empty">
      Nothing needs your input.
    </p>{/if}
  <ol class="inbox-list">
    {#each pending as item (item.key)}
      <li class="inbox-item">
        <button class="inbox-open" onclick={() => onopen(item)}>
          <span class="inbox-location">
            <strong>{item.project}</strong>
            {#if item.worktree}<span>· {item.worktree}</span>{/if}
            <span>· {item.agent}</span>
          </span>
          <span class="inbox-text">{item.text}</span>
        </button>
        {#if item.kind === 'opencode-permission'}
          <div class="inbox-actions">
            <button disabled={!!busyKey} onclick={() => decide(item, 'once')}>Allow once</button>
            <button disabled={!!busyKey} onclick={() => decide(item, 'reject')}>Reject</button>
          </div>
        {:else if item.kind === 'acp-permission'}
          <div class="inbox-actions">
            {#each item.options ?? [] as option (option.optionId)}<button
                disabled={!!busyKey}
                onclick={() => decide(item, option.optionId)}>{option.name}</button
              >{/each}
            {#if !(item.options ?? []).some((option) => option.kind.startsWith('reject'))}<button
                disabled={!!busyKey}
                onclick={() => decide(item, null)}>Deny</button
              >{/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
  {#if recent.length}
    <header class="inbox-header inbox-results-header">
      <h2>Recent results</h2>
      <span>{recent.filter((item) => !item.read).length} new</span>
    </header>
    {#each Object.entries(recentGroups) as [group, groupItems] (group)}
      {@const first = groupItems?.[0]}
      {#if first}
        <h3 class="inbox-group-heading">
          {first.project}{first.worktree ? ` · ${first.worktree}` : ' · main'}
        </h3>
        <ol class="inbox-list">
          {#each groupItems ?? [] as item (item.key)}
            <li class="inbox-item inbox-result" class:unread={!item.read}>
              <button class="inbox-open" onclick={() => onopen(item)}>
                <span class="inbox-location"
                  ><strong>{item.agent}</strong><span>
                    · {item.kind === 'check-failed' ? 'Check failed' : 'Turn completed'}</span
                  ></span
                >
                <span class="inbox-text">{item.text}</span>
              </button>
            </li>
          {/each}
        </ol>
      {/if}
    {/each}
  {/if}
</section>

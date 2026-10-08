<script lang="ts">
  import type { AttentionItem, AttentionKind, AttentionSnooze } from './lib/attention-items';
  import { isInboxOutcome, type InboxItem } from './lib/inbox';

  interface Props {
    items: InboxItem[];
    /** State-derived items: Ship states and waiting subagents. */
    attention: AttentionItem[];
    /** The shared attention count, across every repository. */
    total: number;
    loading: boolean;
    error: string;
    onopen: (item: InboxItem) => void;
    onopenattention: (item: AttentionItem) => void;
    ondismiss: (item: AttentionItem) => void;
    onsnooze: (item: AttentionItem, choice: AttentionSnooze) => void;
    ondecide: (item: InboxItem, optionId: string | null) => Promise<void>;
  }

  const kindLabels: Record<AttentionKind, string> = {
    permission: 'Permission',
    question: 'Question',
    'ship-needs-input': 'Ship needs input',
    'ship-ready-to-merge': 'Ready to merge',
    'ship-closed-unmerged': 'Closed without merge',
    'subagent-waiting': 'Subagent waiting',
    'ship-stalled': 'Ship stalled',
  };

  let {
    items,
    attention,
    total,
    loading,
    error: loadError,
    onopen,
    onopenattention,
    ondismiss,
    onsnooze,
    ondecide,
  }: Props = $props();
  let busyKey = $state<string | null>(null);
  let error = $state('');
  let pending = $derived(items.filter((item) => !isInboxOutcome(item)));
  let groups = $derived(
    [
      ...pending.map((item) => ({ repo: item.project, order: item.receivedAt })),
      ...attention.map((item) => ({ repo: item.repo, order: item.since })),
    ]
      .toSorted((left, right) => left.order - right.order)
      .map((entry) => entry.repo)
      .filter((repo, index, repos) => repos.indexOf(repo) === index),
  );
  let recent = $derived(items.filter(isInboxOutcome).toReversed());
  let recentGroups = $derived(
    recent.reduce<Record<string, InboxItem[]>>((byDirectory, item) => {
      const key = item.directory;
      (byDirectory[key] ??= []).push(item);
      return byDirectory;
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
    <span aria-label={`${total} need attention`}>{total}</span>
  </header>
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if loading && !items.length}<p role="status">Checking all projects…</p>{/if}
  {#if !loading && !total && !loadError}<p class="inbox-empty">Nothing needs your input.</p>{/if}
  {#each groups as repo (repo)}
    <h3 class="inbox-group-heading">{repo}</h3>
    <ol class="inbox-list">
      {#each pending.filter((item) => item.project === repo) as item (item.key)}
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
              {#if item.allow !== false}<button
                  disabled={!!busyKey}
                  onclick={() => decide(item, 'once')}>Allow once</button
                >{/if}
              <button disabled={!!busyKey} onclick={() => decide(item, 'reject')}>Reject</button>
            </div>
          {:else if item.kind === 'acp-permission'}
            <div class="inbox-actions">
              {#each item.options ?? [] as option (option.optionId)}{#if item.allow !== false || !option.kind.startsWith('allow')}<button
                    disabled={!!busyKey}
                    onclick={() => decide(item, option.optionId)}>{option.name}</button
                  >{/if}{/each}
              {#if !(item.options ?? []).some((option) => option.kind.startsWith('reject'))}<button
                  disabled={!!busyKey}
                  onclick={() => decide(item, null)}>Deny</button
                >{/if}
            </div>
          {/if}
        </li>
      {/each}
      {#each attention.filter((item) => item.repo === repo) as item (item.id)}
        <li class="inbox-item inbox-attention" data-attention-kind={item.kind}>
          <button class="inbox-open" onclick={() => onopenattention(item)}>
            <span class="inbox-location">
              <strong>{kindLabels[item.kind]}</strong>
              <span>· {item.title}</span>
            </span>
            {#if item.detail}<span class="inbox-text">{item.detail}</span>{/if}
          </button>
          <div class="inbox-actions">
            <button onclick={() => ondismiss(item)}>Dismiss</button>
            <button onclick={() => onsnooze(item, 'hour')}>Snooze 1 hour</button>
            <button onclick={() => onsnooze(item, 'tomorrow')}>Until tomorrow</button>
          </div>
        </li>
      {/each}
    </ol>
  {/each}
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

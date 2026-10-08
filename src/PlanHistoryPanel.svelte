<script lang="ts">
  import { Button } from '@smykla-skalski/sui';
  import type { SessionInfo } from './lib/opencode';
  import { historyRows } from './lib/history';
  import type { HistoryEntry } from './lib/plan';

  let {
    events,
    session,
    loading,
    error,
    onrefresh,
  }: {
    events: HistoryEntry[];
    session: SessionInfo | undefined;
    loading: boolean;
    error: string;
    onrefresh: () => void;
  } = $props();
  const rows = $derived(historyRows(events));
  const number = new Intl.NumberFormat();
</script>

<aside class="history-panel" aria-label="Session plan history">
  <header>
    <div>
      <p>PLAN HISTORY</p>
      <h2>Activity</h2>
    </div>
    <Button size="sm" variant="ghost" onclick={onrefresh} disabled={loading}
      >{loading ? 'Refreshing…' : 'Refresh'}</Button
    >
  </header>
  {#if session && typeof session.cost === 'number' && session.tokens}<div
      class="usage"
      aria-label="Session usage"
    >
      <strong>Session usage</strong>
      <span
        >${session.cost.toFixed(4)} · {number.format(session.tokens.input)} input · {number.format(
          session.tokens.output,
        )} output · {number.format(session.tokens.reasoning)} reasoning tokens</span
      >
      <small
        >Cache: {number.format(session.tokens.cache?.read ?? 0)} read · {number.format(
          session.tokens.cache?.write ?? 0,
        )} write</small
      >
    </div>{/if}
  {#if error}<p class="error" role="status">History unavailable: {error}</p>{/if}
  <ol>
    {#each rows as row (row.id)}<li>
        <div class="meta">
          <time datetime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleString()}</time
          ><span>v{row.version}</span>
        </div>
        <strong>{row.title}</strong>
        {#if row.details.length}<ul>
            {#each row.details as detail, index (index)}<li>{detail}</li>{/each}
          </ul>{/if}
      </li>{:else}<li class="empty">
        {loading ? 'Loading history…' : 'No recorded plan history for this session.'}
      </li>{/each}
  </ol>
</aside>

<style>
  .history-panel {
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
  header p {
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
  .usage {
    display: grid;
    gap: var(--space-4);
    padding: 12px 20px;
    border-bottom: 1px solid var(--shell-divider);
    font-size: var(--type-12);
  }
  .usage span,
  .usage small,
  .error,
  .empty {
    color: var(--sui-muted);
  }
  .error {
    margin: 12px 20px;
    font-size: var(--type-12);
  }
  ol {
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: 10px 20px 20px 36px;
  }
  ol > li {
    padding: 12px 0;
    border-bottom: 1px solid var(--shell-divider);
    font-size: var(--type-12);
    line-height: 1.5;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    gap: var(--space-8);
    color: var(--sui-muted);
    font-size: var(--type-12);
  }
  ol strong {
    display: block;
    margin-top: 5px;
    font-size: var(--type-13);
  }
  ol ul {
    margin: 6px 0 0;
    padding-left: 17px;
    color: var(--sui-muted);
    overflow-wrap: anywhere;
  }
  .empty {
    list-style: none;
  }
</style>

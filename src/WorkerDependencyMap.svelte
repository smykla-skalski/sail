<script lang="ts">
  import type { ShipRun } from './lib/issue-shipping';
  import { buildWorkerDependencyMap } from './lib/worker-dependency-map';

  let {
    run,
    selected,
    onselect,
    onopen,
  }: {
    run: ShipRun;
    selected?: string;
    onselect: (id: string) => Promise<void>;
    onopen: (path: string, threadId?: string | null) => Promise<void>;
  } = $props();
  let view = $state<'map' | 'table'>('map');
  let error = $state('');
  const graph = $derived(buildWorkerDependencyMap(run));
  const columns = $derived(
    [...new Set(graph.nodes.map((node) => node.depth))].toSorted((left, right) => left - right),
  );

  async function openWorker(path: string, threadId: string) {
    error = '';
    try {
      await onopen(path, threadId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function dependencies(id: string): string[] {
    return graph.edges
      .filter((edge) => edge.to === id)
      .map((edge) => graph.nodes.find((node) => node.id === edge.from)?.label ?? edge.from);
  }
</script>

{#if graph.nodes.length}
  <section class="dependency-map" aria-label="Worker dependency map">
    <header>
      <div>
        <h3>Worker dependency map</h3>
        <p>Authoritative issue blockers and their active workers.</p>
      </div>
      <div class="view-switch" role="group" aria-label="Dependency map view">
        <button aria-pressed={view === 'map'} onclick={() => (view = 'map')}>Map</button>
        <button aria-pressed={view === 'table'} onclick={() => (view = 'table')}>Table</button>
      </div>
    </header>
    {#if graph.errors.length}
      <div class="graph-errors" role="alert">
        <strong>Dependency data needs attention</strong>
        <ul>
          {#each graph.errors as item (item)}<li>{item}</li>{/each}
        </ul>
      </div>
    {/if}
    {#if error}<p class="graph-errors" role="alert">{error}</p>{/if}
    {#if view === 'map'}
      <div class="map-canvas" role="list" aria-label="Dependency flow from blockers to dependents">
        {#each columns as column (column)}
          <div class="map-column" aria-label={`Dependency level ${column + 1}`}>
            {#each graph.nodes.filter((node) => node.depth === column) as node (node.id)}
              <article
                class="map-node"
                class:error={node.errors.length}
                data-kind={node.kind}
                data-node-id={node.id}
                data-state={node.state.toLowerCase()}
                role="listitem"
              >
                <button
                  class="node-select"
                  aria-pressed={node.id === selected}
                  onclick={() => node.issue && onselect(node.id)}
                  disabled={!node.issue}
                >
                  <strong>{node.label}</strong>
                  <span>{node.state}</span>
                </button>
                <dl>
                  <div>
                    <dt>Owner</dt>
                    <dd>{node.owner}</dd>
                  </div>
                  <div>
                    <dt>Checks</dt>
                    <dd>{node.checkState}</dd>
                  </div>
                  <div>
                    <dt>Blocked by</dt>
                    <dd>{dependencies(node.id).join(', ') || 'Nothing'}</dd>
                  </div>
                </dl>
                {#if node.blockingReason}<p class="node-error">{node.blockingReason}</p>{/if}
                <div class="node-actions">
                  {#if node.url}<a href={node.url} target="_blank" rel="noreferrer">Issue</a>{/if}
                  {#if node.issue?.path && node.issue.threadId && !node.issue.worktreeUnavailable}
                    <button onclick={() => openWorker(node.issue!.path!, node.issue!.threadId!)}
                      >Worker</button
                    >
                  {/if}
                  {#each node.issue?.checks?.filter((check) => check.url) ?? [] as check (`${check.name}:${check.url}`)}
                    <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a>
                  {/each}
                </div>
              </article>
            {/each}
          </div>
        {/each}
      </div>
    {:else}
      <div class="table-scroll">
        <table>
          <caption>Worker dependencies and equivalent navigation</caption>
          <thead
            ><tr
              ><th>Issue</th><th>Owner</th><th>State</th><th>Blocked by</th><th>Checks</th><th
                >Open</th
              ></tr
            ></thead
          >
          <tbody>
            {#each graph.nodes as node (node.id)}
              <tr class:error={node.errors.length}>
                <th scope="row">{node.label}</th>
                <td>{node.owner}</td>
                <td>{node.state}{node.blockingReason ? ` — ${node.blockingReason}` : ''}</td>
                <td>{dependencies(node.id).join(', ') || 'Nothing'}</td>
                <td>{node.checkState}</td>
                <td class="table-actions">
                  {#if node.issue}<button onclick={() => onselect(node.id)}>Details</button>{/if}
                  {#if node.url}<a href={node.url} target="_blank" rel="noreferrer">Issue</a>{/if}
                  {#if node.issue?.path && node.issue.threadId && !node.issue.worktreeUnavailable}
                    <button onclick={() => openWorker(node.issue!.path!, node.issue!.threadId!)}
                      >Worker</button
                    >
                  {/if}
                  {#each node.issue?.checks?.filter((check) => check.url) ?? [] as check (`${check.name}:${check.url}`)}
                    <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a>
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<style>
  .dependency-map {
    display: grid;
    gap: 12px;
    margin-top: 20px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
  }
  h3,
  p {
    margin: 0;
  }
  header p {
    margin-top: 4px;
    color: var(--sui-muted);
    font-size: 12px;
  }
  button,
  a {
    padding: 7px 10px;
    border: 1px solid var(--shell-divider);
    border-radius: 6px;
    color: inherit;
    background: transparent;
    font: inherit;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
  }
  a {
    color: var(--sui-primary);
    text-decoration: none;
  }
  .view-switch,
  .node-actions,
  .table-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .view-switch [aria-pressed='true'] {
    color: var(--sui-primary);
    border-color: var(--sui-primary);
  }
  .graph-errors {
    padding: 10px 12px;
    border-left: 3px solid var(--sui-danger);
    color: var(--sui-danger);
    background: color-mix(in srgb, var(--sui-danger) 9%, transparent);
  }
  .graph-errors ul {
    margin: 6px 0 0;
    padding-left: 20px;
  }
  .map-canvas {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(220px, 1fr);
    gap: 22px;
    overflow-x: auto;
    padding: 4px 2px 12px;
  }
  .map-column {
    position: relative;
    display: grid;
    align-content: start;
    gap: 10px;
  }
  .map-column + .map-column::before {
    position: absolute;
    top: 28px;
    left: -17px;
    content: '→';
    color: var(--sui-primary);
    font-weight: 700;
  }
  .map-node {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--shell-divider);
    border-left: 4px solid var(--sui-primary);
    border-radius: 8px;
    background: var(--sui-surface-raised, var(--sui-surface));
  }
  .map-node[data-state='blocked'],
  .map-node[data-state='failed'],
  .map-node.error {
    border-left-color: var(--sui-danger);
  }
  .map-node[data-state='waiting'],
  .map-node[data-state='queued'] {
    border-left-color: var(--sui-warning, var(--sui-primary));
  }
  .node-select {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 0 0 8px;
    border: 0;
    text-align: left;
  }
  .node-select[aria-pressed='true'] strong {
    color: var(--sui-primary);
  }
  .node-select:disabled {
    opacity: 1;
  }
  dl {
    display: grid;
    gap: 5px;
    margin: 0;
    font-size: 12px;
  }
  dl div {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    gap: 6px;
  }
  dt {
    color: var(--sui-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .node-error {
    margin-top: 8px;
    color: var(--sui-danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .node-actions {
    margin-top: 10px;
  }
  .node-actions button,
  .node-actions a,
  .table-actions button,
  .table-actions a {
    padding: 5px 8px;
    font-size: 12px;
  }
  .table-scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  caption {
    padding: 0 0 8px;
    color: var(--sui-muted);
    text-align: left;
  }
  th,
  td {
    padding: 9px;
    border-bottom: 1px solid var(--shell-divider);
    text-align: left;
    vertical-align: top;
  }
  tr.error {
    box-shadow: inset 3px 0 var(--sui-danger);
  }
  .table-actions {
    min-width: 180px;
  }
  @media (max-width: 720px) {
    .map-canvas {
      grid-auto-flow: row;
      grid-auto-columns: auto;
      grid-template-columns: minmax(0, 1fr);
      overflow: visible;
    }
    .map-column + .map-column::before {
      top: -20px;
      left: 50%;
      content: '↓';
    }
  }
</style>

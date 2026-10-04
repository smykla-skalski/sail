<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { getSetting, setSetting } from './lib/settings';
  import {
    graphErrors,
    isIssueGraphDraft,
    splitPlan,
    type IssueGraphDraft,
    type PublishedGraph,
  } from './lib/issue-graph';
  import type { Plan } from './lib/plan';

  let { plan, directory }: { plan: Plan; directory: string } = $props();
  let graph = $state<IssueGraphDraft>({ source: '', title: '', body: '', issues: [] });
  let source = $state('');
  let umbrellaInput = $state('');
  let loading = $state(false);
  let publishing = $state(false);
  let message = $state('');
  let published = $state<PublishedGraph | null>(null);
  let approved = $state(false);
  let approvedGraph = $state('');
  let canPublish = $derived(approved && approvedGraph === JSON.stringify(graph));
  let errors = $derived(graphErrors(graph));

  $effect(() => {
    const key = `${directory}:${plan.sessionID}`;
    if (key !== source) {
      source = key;
      try {
        const saved: unknown = JSON.parse(getSetting(`sai-issue-graph:${key}`) ?? 'null');
        graph = isIssueGraphDraft(saved) ? saved : splitPlan(plan);
      } catch {
        graph = splitPlan(plan);
      }
      umbrellaInput = '';
      published = null;
      approved = false;
      message = '';
    }
  });

  $effect(() => {
    if (source && graph.source) setSetting(`sai-issue-graph:${source}`, JSON.stringify(graph));
  });

  function parseNumber(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  }

  function updateIssue(index: number, change: Partial<IssueGraphDraft['issues'][number]>) {
    graph.issues[index] = { ...graph.issues[index], ...change };
    published = null;
  }

  async function loadUmbrella() {
    const number = parseNumber(umbrellaInput);
    if (!number) {
      message = 'Enter a valid umbrella number.';
      return;
    }
    loading = true;
    message = '';
    try {
      const loaded = await invoke<PublishedGraph>('load_issue_graph', {
        repository: directory,
        umbrellaNumber: number,
      });
      graph = {
        source: plan.sessionID,
        replaceExisting: true,
        umbrellaNumber: number,
        title: loaded.umbrella?.title ?? '',
        body: loaded.umbrella?.body ?? '',
        issues: loaded.issues.map((issue) => ({
          id: String(issue.number),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          dependsOn: issue.dependsOn,
        })),
      };
      published = loaded;
      approved = false;
      message = `Loaded ${loaded.issues.length} issues.`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function addIssue() {
    graph.issues.push({ id: crypto.randomUUID(), title: '', body: '', dependsOn: [] });
    published = null;
  }

  async function publish() {
    if (errors.length || publishing || !canPublish) return;
    publishing = true;
    message = '';
    try {
      const result = await invoke<PublishedGraph>('publish_issue_graph', {
        repository: directory,
        graph,
      });
      published = result;
      approved = false;
      graph = {
        ...graph,
        replaceExisting: true,
        umbrellaNumber: result.umbrella?.number,
        issues: result.issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          dependsOn: issue.dependsOn,
        })),
      };
      umbrellaInput = String(result.umbrella?.number ?? '');
      message = `Published ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'}.`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      publishing = false;
    }
  }
</script>

<section class="issue-graph" aria-label="Issue split">
  <h3>Issue split</h3>
  <p>
    Review each issue's scope and prerequisites before publishing. Publishing saves the graph on
    GitHub.
  </p>
  <div class="load-row">
    <label
      >Existing umbrella # <input
        aria-label="Existing umbrella number"
        type="number"
        min="1"
        bind:value={umbrellaInput}
      /></label
    >
    <button type="button" onclick={loadUmbrella} disabled={loading || publishing}
      >Load umbrella</button
    >
  </div>
  {#if graph.issues.length > 1 || graph.umbrellaNumber}
    <label>Umbrella title <input aria-label="Umbrella title" bind:value={graph.title} /></label>
    <label
      >Umbrella scope <textarea aria-label="Umbrella scope" bind:value={graph.body}
      ></textarea></label
    >
  {/if}
  {#each graph.issues as issue, index (issue.id)}
    <fieldset>
      <legend>{issue.id}{issue.number ? ` · #${issue.number}` : ''}</legend>
      <label
        >Title <input
          aria-label={`Title for ${issue.id}`}
          value={issue.title}
          oninput={(event) => updateIssue(index, { title: event.currentTarget.value })}
        /></label
      >
      <label
        >Scope <textarea
          aria-label={`Scope for ${issue.id}`}
          value={issue.body}
          oninput={(event) => updateIssue(index, { body: event.currentTarget.value })}
        ></textarea></label
      >
      <label
        >Existing issue # <input
          aria-label={`Existing number for ${issue.id}`}
          type="number"
          min="1"
          value={issue.number ?? ''}
          oninput={(event) =>
            updateIssue(index, { number: parseNumber(event.currentTarget.value) })}
        /></label
      >
      <label
        >Blocked by <select
          aria-label={`Dependency for ${issue.id}`}
          multiple
          value={issue.dependsOn}
          onchange={(event) =>
            updateIssue(index, {
              dependsOn: [
                ...issue.dependsOn.filter(
                  (dependency) => !graph.issues.some((candidate) => candidate.id === dependency),
                ),
                ...[...event.currentTarget.selectedOptions].map((option) => option.value),
              ],
            })}
        >
          {#each graph.issues.filter((candidate) => candidate.id !== issue.id) as candidate (candidate.id)}
            <option value={candidate.id}>{candidate.title || candidate.id}</option>
          {/each}
        </select></label
      >
      <label
        >Other blocker numbers <input
          aria-label={`Other blockers for ${issue.id}`}
          value={issue.dependsOn
            .filter((dependency) => !graph.issues.some((candidate) => candidate.id === dependency))
            .join(', ')}
          oninput={(event) =>
            updateIssue(index, {
              dependsOn: [
                ...issue.dependsOn.filter((dependency) =>
                  graph.issues.some((candidate) => candidate.id === dependency),
                ),
                ...event.currentTarget.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              ],
            })}
        /></label
      >
      <button
        type="button"
        onclick={() => {
          graph.issues.splice(index, 1);
          published = null;
        }}>Remove issue</button
      >
    </fieldset>
  {/each}
  <button type="button" onclick={addIssue}>Add issue</button>
  {#if errors.length}<ul class="errors">
      {#each errors as error (error)}<li>{error}</li>{/each}
    </ul>{/if}
  <label
    ><input
      type="checkbox"
      bind:checked={approved}
      onchange={() => (approvedGraph = JSON.stringify(graph))}
    /> I approve this issue split</label
  >
  <button
    type="button"
    onclick={publish}
    disabled={!!errors.length || publishing || loading || !canPublish}
    >{publishing ? 'Publishing…' : 'Publish issue graph'}</button
  >
  {#if message}<p role="status">{message}</p>{/if}
  {#if published}
    <ul>
      {#if published.umbrella}<li>
          <a href={published.umbrella.url} target="_blank" rel="noreferrer"
            >Umbrella #{published.umbrella.number}</a
          >
        </li>{/if}
      {#each published.issues as issue (issue.number)}<li>
          <a href={issue.url} target="_blank" rel="noreferrer">#{issue.number} {issue.title}</a> · {issue.state}
        </li>{/each}
    </ul>
  {/if}
</section>

<style>
  .issue-graph {
    border-top: 1px solid var(--border-color, #555);
    padding-top: 1rem;
    margin-top: 1rem;
    display: grid;
    gap: 0.7rem;
  }
  .issue-graph label {
    display: grid;
    gap: 0.25rem;
  }
  .issue-graph input,
  .issue-graph textarea,
  .issue-graph select {
    width: 100%;
  }
  .issue-graph fieldset {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }
  .load-row {
    display: flex;
    align-items: end;
    gap: 0.5rem;
  }
  .errors {
    color: var(--color-danger, #d33);
  }
</style>

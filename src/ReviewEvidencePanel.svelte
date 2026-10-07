<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import type { WorkingDiffInfo } from './lib/diff';
  import {
    evidenceFreshness,
    groupReviewCaptures,
    groupReviewChecks,
    reviewFiles,
    type ReviewCapture,
    type ReviewPreview,
  } from './lib/review-evidence';

  let {
    files,
    checks,
    captures,
    previews,
    updated,
    filesUpdated,
    onfile,
    oncheck,
    onpreview,
    oncapturephase,
  }: {
    files: WorkingDiffInfo[];
    checks: PostTurnCheck[];
    captures: ReviewCapture[];
    previews: ReviewPreview[];
    updated: number;
    filesUpdated: number;
    onfile: (path: string) => void;
    oncheck: (check: PostTurnCheck) => void;
    onpreview: (preview: ReviewPreview) => void;
    oncapturephase: (id: string, phase: ReviewCapture['phase']) => void;
  } = $props();

  const evidenceFiles = $derived(reviewFiles(files));
  const captureGroups = $derived(groupReviewCaptures(captures));
  const checkGroups = $derived(groupReviewChecks(checks));
  let now = $state(Date.now());
  const freshness = $derived(evidenceFreshness(updated, now));
  let selectedCapture = $state<ReviewCapture | null>(null);
  let captureDialog: HTMLDialogElement;
  const freshnessTimer = setInterval(() => (now = Date.now()), 60_000);
  onDestroy(() => clearInterval(freshnessTimer));

  function time(value: number): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<section class="review-evidence" aria-label="Review evidence">
  <header>
    <div>
      <h2>Review evidence</h2>
      <p>Current workspace · refreshed {time(updated)}</p>
    </div>
    <span class:stale={freshness === 'stale'}>{freshness}</span>
  </header>

  <details open>
    <summary>Captures ({captures.length})</summary>
    {#if captures.length}
      {#each captureGroups as group (group.turn ?? 'draft')}
        <section
          class="turn-group"
          aria-label={group.turn ? `Turn ${group.turn} captures` : 'Draft captures'}
        >
          <div class="turn-heading">
            <strong>{group.turn ? `Turn ${group.turn.slice(0, 8)}` : 'Draft'}</strong>
            <small>{time(group.updated)} · {evidenceFreshness(group.updated, now)}</small>
          </div>
          <div class="capture-grid">
            {#each group.captures as capture (capture.id)}
              <figure>
                {#if capture.previewUrl}
                  <button
                    class="capture-preview"
                    aria-label={`Open ${capture.phase} capture`}
                    onclick={() => {
                      selectedCapture = capture;
                      captureDialog.showModal();
                    }}
                  >
                    <img
                      src={capture.previewUrl}
                      alt={`${capture.phase} capture from ${capture.source}`}
                    />
                  </button>
                {:else}
                  <div class="capture-preview unavailable-preview">Preview unavailable</div>
                {/if}
                <figcaption>
                  <select
                    aria-label={`Capture phase for ${capture.source}`}
                    value={capture.phase}
                    onchange={(event) =>
                      oncapturephase(
                        capture.id,
                        (event.currentTarget as HTMLSelectElement).value as ReviewCapture['phase'],
                      )}
                  >
                    <option value="before">Before</option>
                    <option value="after">After</option>
                  </select>
                  <span class="source" title={capture.url}>{capture.source}</span>
                  <small>{time(capture.created)} · {evidenceFreshness(capture.created, now)}</small>
                </figcaption>
              </figure>
            {/each}
          </div>
        </section>
      {/each}
    {:else}
      <p class="empty">
        No browser captures recorded. Pick an element in a browser pane to add one.
      </p>
    {/if}
  </details>

  <details open>
    <summary>Changed files ({evidenceFiles.length})</summary>
    {#if evidenceFiles.length}
      <ul>
        {#each evidenceFiles as file (file.path)}
          <li>
            <button onclick={() => onfile(file.path)}>
              <span>{file.path}</span>
              <span class="evidence-meta">
                <small>Git working tree · {evidenceFreshness(filesUpdated, now)}</small>
                <small class:unavailable={file.state !== 'available'}>
                  {file.state === 'available'
                    ? `+${file.added} −${file.removed}`
                    : file.state === 'large'
                      ? 'Large · open fallback'
                      : file.state === 'binary'
                        ? 'Binary · open fallback'
                        : 'No text patch'}
                </small>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">No working tree changes at the last refresh.</p>
    {/if}
  </details>

  <details open>
    <summary>Checks ({checks.length})</summary>
    {#if checkGroups.length}
      {#each checkGroups as group (group.turn)}
        <section class="turn-group" aria-label={`Turn ${group.turn} checks`}>
          <div class="turn-heading">
            <strong>Turn</strong><small
              >{time(group.updated)} · {evidenceFreshness(group.updated, now)}</small
            >
          </div>
          {#each group.checks as check (check.id)}
            <button class="check" onclick={() => oncheck(check)}>
              <span>{check.command}</span>
              <span class="evidence-meta">
                <small>{check.source} check</small>
                <small
                  class:failed={check.status === 'failed' || check.status === 'timed_out'}
                  class:running={check.status === 'running'}
                  >{check.status.replaceAll('_', ' ')}</small
                >
              </span>
            </button>
          {/each}
        </section>
      {/each}
    {:else}
      <p class="empty">No checks recorded. Turn completion does not mean checks passed.</p>
    {/if}
  </details>

  <details>
    <summary>Previews ({previews.length})</summary>
    {#if previews.length}
      <ul>
        {#each previews as preview (preview.id)}
          <li>
            <button onclick={() => onpreview(preview)}>
              <span>{preview.url}</span><small>Browser pane · live</small>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">No browser preview is open for this workspace.</p>
    {/if}
  </details>
</section>

<dialog bind:this={captureDialog} aria-label="Browser capture">
  {#if selectedCapture?.previewUrl}
    <header>
      <strong>{selectedCapture.phase} capture</strong>
      <button onclick={() => captureDialog.close()} aria-label="Close capture">×</button>
    </header>
    <img src={selectedCapture.previewUrl} alt={`${selectedCapture.phase} capture`} />
    <p title={selectedCapture.url}>{selectedCapture.url}</p>
  {/if}
</dialog>

<style>
  .review-evidence {
    margin: 12px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--sui-primary) 35%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--sui-primary) 5%, transparent);
  }
  header,
  .turn-heading,
  figcaption,
  .check,
  li > button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  header h2,
  header p,
  figure {
    margin: 0;
  }
  header h2 {
    font-size: 0.95rem;
  }
  header p,
  small,
  header > span {
    color: var(--shell-muted);
    font-size: 0.75rem;
  }
  header > span {
    padding: 2px 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--sui-primary) 14%, transparent);
  }
  header > span.stale,
  .unavailable {
    color: var(--sui-warning-ink);
    background: var(--sui-warning-subtle);
  }
  details {
    margin-top: 10px;
    border-top: 1px solid var(--shell-divider);
    padding-top: 8px;
  }
  summary {
    cursor: pointer;
    font-weight: 650;
    font-size: 0.82rem;
  }
  ul {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
  }
  li > button,
  .check {
    width: 100%;
    border: 0;
    border-radius: 6px;
    padding: 7px;
    background: transparent;
    color: inherit;
    text-align: left;
  }
  li > button:hover,
  .check:hover {
    background: color-mix(in srgb, var(--sui-primary) 10%, transparent);
  }
  li span,
  .check span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .source {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .evidence-meta {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
  }
  .failed {
    color: var(--sui-danger-ink);
  }
  .running {
    color: var(--sui-primary);
  }
  .turn-group {
    margin-top: 8px;
  }
  .capture-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px;
    margin-top: 8px;
  }
  .unavailable-preview {
    display: grid;
    place-items: center;
    color: var(--shell-muted);
    font-size: 0.75rem;
  }
  figure {
    min-width: 0;
  }
  .capture-preview {
    width: 100%;
    height: 90px;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--shell-divider);
    border-radius: 6px;
    background: #111;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  figcaption {
    align-items: flex-start;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  select {
    max-width: 72px;
  }
  .empty {
    margin: 8px 0 0;
    color: var(--shell-muted);
    font-size: 0.8rem;
  }
  dialog {
    max-width: min(900px, 90vw);
    max-height: 90vh;
    padding: 12px;
    border: 1px solid var(--shell-divider);
    border-radius: 10px;
    background: var(--sui-surface);
    color: inherit;
  }
  dialog::backdrop {
    background: #0008;
  }
  dialog header button {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 1.3rem;
  }
  dialog img {
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 75vh;
    margin-top: 8px;
  }
  dialog p {
    max-width: 80vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { Button } from '@smykla-skalski/sui';
  import ReviewEvidencePanel from './ReviewEvidencePanel.svelte';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import type { ReviewCapture, ReviewPreview } from './lib/review-evidence';
  import {
    parsePatch,
    patchUnavailableReason,
    type DiffAnnotation,
    type WorkingDiffInfo,
  } from './lib/diff';
  import {
    commentRange,
    formatComments,
    reconcileComments,
    type DiffComment,
    withSnapshot,
  } from './lib/diff-comments';

  interface Props {
    files: WorkingDiffInfo[];
    directory: string;
    annotations: Record<string, DiffAnnotation>;
    selected: string | null;
    loading: boolean;
    error: string;
    onselect: (file: string) => void;
    onrefresh: () => void | Promise<void>;
    onclose: () => void;
    comments: DiffComment[];
    scope: string;
    oncomments: (scope: string, comments: DiffComment[]) => void;
    oncommentssent: (scope: string, ids: string[]) => void;
    onsendcomments: (scope: string, text: string) => Promise<void>;
    evidence?: {
      checks: PostTurnCheck[];
      captures: ReviewCapture[];
      previews: ReviewPreview[];
      updated: number;
      filesUpdated: number;
      oncheck: (check: PostTurnCheck) => void;
      onpreview: (preview: ReviewPreview) => void;
      oncapturephase: (id: string, phase: ReviewCapture['phase']) => void;
    };
  }

  let {
    files,
    directory,
    annotations,
    selected,
    loading,
    error,
    onselect,
    onrefresh,
    onclose,
    comments,
    scope,
    oncomments,
    oncommentssent,
    onsendcomments,
    evidence,
  }: Props = $props();
  let current = $derived(files.find((file) => file.file === selected));
  let area = $state<'all' | 'staged' | 'unstaged'>('all');
  let displayPatch = $derived(
    current
      ? area === 'staged'
        ? current.stagedPatch
        : area === 'unstaged'
          ? current.unstagedPatch
          : current.patch
      : '',
  );
  let lines = $derived(parsePatch(displayPatch));
  let unavailable = $derived(patchUnavailableReason(displayPatch));
  let actionError = $state('');
  let actionBusy = $state(false);
  let confirmRevert = $state<{ patch: string; hunk: number | null } | null>(null);
  let patchScroll = $state<HTMLDivElement>();
  let previousFile: string | null = null;
  let previousScope = '';
  let anchorIndex = $state<number | null>(null);
  let selectedIndex = $state<number | null>(null);
  let selectedPatch = $state<string | null>(null);
  let commentText = $state('');
  let commentError = $state('');
  let sendingComments = $state(false);
  let commentInput = $state<HTMLTextAreaElement>();
  let panel = $state<HTMLElement>();
  let selectedRange = $derived(
    area !== 'all' || anchorIndex === null || selectedIndex === null || !lines
      ? null
      : commentRange(selected ?? '', lines, anchorIndex, selectedIndex, commentText),
  );

  function selectLine(index: number, extend: boolean) {
    if (area !== 'all') return;
    if (!extend || anchorIndex === null) anchorIndex = index;
    selectedIndex = index;
    selectedPatch = displayPatch;
    commentError = '';
    void tick().then(() => commentInput?.focus());
  }

  function selectArea(next: typeof area) {
    area = next;
    anchorIndex = null;
    selectedIndex = null;
    selectedPatch = null;
    commentText = '';
    confirmRevert = null;
    actionError = '';
    if (patchScroll) patchScroll.scrollTop = 0;
  }

  function hunkOrdinal(index: number): number {
    return lines?.slice(0, index).filter((line) => line.kind === 'hunk').length ?? 0;
  }

  async function applyAction(action: 'stage' | 'unstage' | 'revert', hunk: number | null) {
    if (!current || area === 'all' || actionBusy) return;
    const patch = displayPatch;
    if (
      action === 'revert' &&
      (!confirmRevert || confirmRevert.patch !== patch || confirmRevert.hunk !== hunk)
    ) {
      confirmRevert = { patch, hunk };
      return;
    }
    actionBusy = true;
    actionError = '';
    try {
      await invoke('git_change_action', {
        path: directory,
        file: current.file,
        area,
        action,
        expectedPatch: patch,
        hunk,
      });
      confirmRevert = null;
      await onrefresh();
    } catch (cause) {
      actionError = String(cause);
      confirmRevert = null;
    } finally {
      actionBusy = false;
    }
  }

  async function readCommentFile(comment: DiffComment): Promise<string | null> {
    return invoke<string | null>('diff_file_contents', {
      path: directory,
      file: comment.file,
      side: comment.side,
    });
  }

  async function addComment() {
    if (!selectedRange || !commentText.trim()) {
      commentError = 'Choose one line or a continuous range, then write a comment.';
      return;
    }
    const pending = selectedRange;
    const currentScope = scope;
    const currentAnchor = anchorIndex;
    const currentIndex = selectedIndex;
    const currentText = commentText;
    try {
      const contents = await readCommentFile(pending);
      if (contents === null) throw new Error('The selected file is no longer available.');
      if (
        currentScope !== scope ||
        selectedPatch !== displayPatch ||
        currentAnchor !== anchorIndex ||
        currentIndex !== selectedIndex ||
        currentText !== commentText
      )
        return;
      oncomments(scope, [...comments, withSnapshot(pending, contents)]);
    } catch (cause) {
      commentError = String(cause);
      return;
    }
    commentText = '';
    anchorIndex = null;
    selectedIndex = null;
    selectedPatch = null;
    commentError = '';
  }

  async function sendComments() {
    if (sendingComments) return;
    if (commentText.trim() && !selectedRange) {
      commentError = 'Choose a continuous line range before sending.';
      return;
    }
    const extra = commentText.trim() ? selectedRange : null;
    const sent = [...comments, ...(extra ? [extra] : [])];
    if (!sent.length) return;
    const sentScope = scope;
    const sentInput = commentText;
    const sentAnchor = anchorIndex;
    const sentIndex = selectedIndex;
    const sentPatch = selectedPatch;
    sendingComments = true;
    commentError = '';
    try {
      await onsendcomments(sentScope, formatComments(sent));
      oncommentssent(
        sentScope,
        sent.map((comment) => comment.id),
      );
      if (
        extra &&
        sentScope === scope &&
        commentText === sentInput &&
        anchorIndex === sentAnchor &&
        selectedIndex === sentIndex &&
        selectedPatch === sentPatch
      ) {
        commentText = '';
        anchorIndex = null;
        selectedIndex = null;
        selectedPatch = null;
      }
    } catch (cause) {
      commentError = String(cause);
    } finally {
      sendingComments = false;
    }
  }

  function commentKeydown(event: KeyboardEvent) {
    if (
      !(event.metaKey || event.ctrlKey) ||
      event.key !== 'Enter' ||
      !(event.target instanceof Node) ||
      !panel?.contains(event.target)
    )
      return;
    event.preventDefault();
    void sendComments();
  }

  async function resetScroll(file: string | null) {
    await tick();
    if (selected === file && patchScroll) patchScroll.scrollTop = 0;
  }

  $effect(() => {
    if (selected === previousFile && scope === previousScope) return;
    previousFile = selected;
    previousScope = scope;
    anchorIndex = null;
    selectedIndex = null;
    selectedPatch = null;
    commentText = '';
    area = 'all';
    confirmRevert = null;
    const file = selected;
    void resetScroll(file);
  });

  $effect(() => {
    if (anchorIndex === null || selectedPatch === displayPatch) return;
    anchorIndex = null;
    selectedIndex = null;
    selectedPatch = null;
    commentError = 'The diff changed. Select the line again before adding your comment.';
  });

  $effect(() => {
    if (!current) return;
    if (area === 'staged' && !current.stagedPatch)
      selectArea(current.unstagedPatch ? 'unstaged' : 'all');
    else if (area === 'unstaged' && !current.unstagedPatch)
      selectArea(current.stagedPatch ? 'staged' : 'all');
  });

  let reconcileGeneration = 0;
  onDestroy(() => ++reconcileGeneration);
  $effect(() => {
    const generation = ++reconcileGeneration;
    if (!comments.length || loading) return;
    const currentScope = scope;
    const currentComments = comments;
    const currentFiles = files;
    void Promise.all(
      [...new Set(currentComments.map((comment) => `${comment.file}\0${comment.side}`))].map(
        async (key) => {
          const comment = currentComments.find((item) => `${item.file}\0${item.side}` === key)!;
          return [key, await readCommentFile(comment)] as const;
        },
      ),
    )
      .then((entries) => {
        if (generation !== reconcileGeneration || currentScope !== scope) return;
        const reconciled = reconcileComments(
          currentComments,
          currentFiles,
          Object.fromEntries(entries),
        );
        if (
          reconciled.some(
            (comment, index) =>
              comment.start !== currentComments[index].start ||
              comment.end !== currentComments[index].end ||
              comment.outdated !== currentComments[index].outdated,
          )
        )
          oncomments(scope, reconciled);
        return;
      })
      .catch((cause) => (commentError = String(cause)));
  });
</script>

<svelte:window onkeydown={commentKeydown} />
<aside class="diff-panel" aria-label="Working tree changes" bind:this={panel}>
  <header class="diff-heading">
    <div>
      <p class="eyebrow">WORKING TREE</p>
      <h2>Changes</h2>
    </div>
    <div class="diff-actions">
      <Button size="sm" variant="ghost" onclick={onrefresh} disabled={loading}
        >{loading ? 'Refreshing…' : 'Refresh'}</Button
      >
      <Button size="sm" variant="ghost" onclick={onclose} aria-label="Close Changes">Close</Button>
    </div>
  </header>
  {#if error}<p class="diff-error" role="alert">{error}</p>{/if}
  {#if evidence}
    <ReviewEvidencePanel
      {files}
      checks={evidence.checks}
      captures={evidence.captures}
      previews={evidence.previews}
      updated={evidence.updated}
      filesUpdated={evidence.filesUpdated}
      onfile={onselect}
      oncheck={evidence.oncheck}
      onpreview={evidence.onpreview}
      oncapturephase={evidence.oncapturephase}
    />
  {/if}
  <div class="diff-files" aria-label="Changed files">
    {#each files as file (file.file)}
      <button class:active={file.file === selected} onclick={() => onselect(file.file)}>
        <strong>{file.file}</strong><span
          >{file.status} · +{file.additions} −{file.deletions}{file.stagedPatch
            ? ' · Staged'
            : ''}{file.unstagedPatch ? ' · Unstaged' : ''}</span
        >
        {#if annotations[file.file]?.drift.length}<small class="drift"
            >Outside {annotations[file.file].drift.join(', ')} step files</small
          >{/if}
        {#if annotations[file.file]?.unattributed}<small class="drift"
            >Edited without an active step</small
          >{/if}
        {#if annotations[file.file]?.steps.length}<small
            >Steps: {annotations[file.file].steps.join(', ')}</small
          >{/if}
      </button>
    {:else}
      <p class="diff-empty">{loading ? 'Loading changes…' : 'No working tree changes.'}</p>
    {/each}
  </div>
  <div class="diff-content">
    {#if current}
      <div class="diff-file-heading">
        <strong>{current.file}</strong><span
          >{current.status} · +{current.additions} −{current.deletions}</span
        >
      </div>
      <div class="diff-area-tabs" aria-label="Diff area">
        <Button
          size="sm"
          variant={area === 'all' ? 'primary' : 'ghost'}
          onclick={() => selectArea('all')}>All</Button
        >
        {#if current.stagedPatch}<Button
            size="sm"
            variant={area === 'staged' ? 'primary' : 'ghost'}
            onclick={() => selectArea('staged')}>Staged</Button
          >{/if}
        {#if current.unstagedPatch}<Button
            size="sm"
            variant={area === 'unstaged' ? 'primary' : 'ghost'}
            onclick={() => selectArea('unstaged')}>Unstaged</Button
          >{/if}
      </div>
      {#if area !== 'all' && displayPatch}<div class="diff-file-actions">
          {#if area === 'unstaged'}
            <Button size="sm" onclick={() => void applyAction('stage', null)} disabled={actionBusy}
              >Stage file</Button
            >
            <Button
              size="sm"
              variant="ghost"
              onclick={() => void applyAction('revert', null)}
              disabled={actionBusy}>Revert file</Button
            >
          {:else}<Button
              size="sm"
              onclick={() => void applyAction('unstage', null)}
              disabled={actionBusy}>Unstage file</Button
            >{/if}
        </div>{/if}
      {#if confirmRevert}<div class="diff-confirm" role="alertdialog" aria-label="Confirm revert">
          <span
            >Discard {confirmRevert.hunk === null
              ? 'all unstaged changes in this file'
              : 'this hunk'}?</span
          >
          <Button size="sm" variant="ghost" onclick={() => (confirmRevert = null)}>Cancel</Button>
          <Button size="sm" onclick={() => void applyAction('revert', confirmRevert?.hunk ?? null)}
            >Discard changes</Button
          >
        </div>{/if}
      {#if actionError}<p class="diff-error" role="alert">{actionError}</p>{/if}
      {#if lines}
        <div
          class="patch-scroll"
          bind:this={patchScroll}
          role="region"
          aria-label={`Diff for ${current.file}`}
        >
          {#each lines as line, index (index)}
            {#if line.oldLine !== undefined || line.newLine !== undefined}
              <button
                type="button"
                class="diff-line"
                class:added={line.kind === 'added'}
                class:deleted={line.kind === 'deleted'}
                class:selected={anchorIndex !== null &&
                  selectedIndex !== null &&
                  index >= Math.min(anchorIndex, selectedIndex) &&
                  index <= Math.max(anchorIndex, selectedIndex)}
                aria-label={`Comment on ${line.kind === 'deleted' ? 'old' : 'new'} line ${line.kind === 'deleted' ? line.oldLine : line.newLine}`}
                disabled={area !== 'all'}
                onclick={(event) => selectLine(index, event.shiftKey)}
                ><span class="line-number">{line.oldLine ?? ''}</span><span class="line-number"
                  >{line.newLine ?? ''}</span
                ><code>{line.text || ' '}</code></button
              >
            {:else}<div class="diff-line" class:hunk={line.kind === 'hunk'}>
                <code>{line.text || ' '}</code>
                {#if line.kind === 'hunk' && area !== 'all'}<span class="hunk-actions">
                    {#if area === 'unstaged'}
                      <Button
                        size="sm"
                        onclick={() => void applyAction('stage', hunkOrdinal(index))}
                        disabled={actionBusy}>Stage hunk</Button
                      >
                      <Button
                        size="sm"
                        variant="ghost"
                        onclick={() => void applyAction('revert', hunkOrdinal(index))}
                        disabled={actionBusy}>Revert hunk</Button
                      >
                    {:else}<Button
                        size="sm"
                        onclick={() => void applyAction('unstage', hunkOrdinal(index))}
                        disabled={actionBusy}>Unstage hunk</Button
                      >{/if}
                  </span>{/if}
              </div>{/if}
          {/each}
        </div>
      {:else}<p class="diff-fallback">
          {unavailable === 'large'
            ? 'This patch is too large to preview here. Open the file in your editor to inspect it.'
            : unavailable === 'binary'
              ? 'Binary change: no readable text patch is available.'
              : 'No text patch is available. This may be a binary or metadata-only change.'}
        </p>{/if}
    {:else if selected}<p class="diff-fallback">No working tree diff for {selected}.</p>
    {:else}<p class="diff-fallback">Select a changed file to inspect its patch.</p>{/if}
  </div>
  {#if selectedRange}<div class="diff-comment-entry">
      <label for="diff-comment-input"
        >Comment on {selectedRange.file}:{selectedRange.start}{selectedRange.end !==
        selectedRange.start
          ? `-${selectedRange.end}`
          : ''}</label
      >
      <textarea
        id="diff-comment-input"
        bind:this={commentInput}
        bind:value={commentText}
        rows="2"
        placeholder="Tell the agent what to change…"></textarea>
      <Button size="sm" onclick={addComment} disabled={!commentText.trim()}>Add draft</Button>
    </div>{/if}
  {#if comments.length}<div class="diff-comment-drafts" aria-label="Draft diff comments">
      {#each comments as comment (comment.id)}<div class="diff-comment-draft">
          <strong
            >{comment.file}:{comment.start}{comment.end !== comment.start
              ? `-${comment.end}`
              : ''}</strong
          >
          {#if comment.outdated}<span class="diff-outdated">Outdated</span>{/if}
          <span>{comment.text}</span>
          <button
            aria-label="Remove draft comment"
            onclick={() =>
              oncomments(
                scope,
                comments.filter((item) => item.id !== comment.id),
              )}>×</button
          >
        </div>{/each}
      <Button size="sm" onclick={() => void sendComments()} disabled={sendingComments}
        >{sendingComments ? 'Sending…' : `Send ${comments.length} comments ⌘↵`}</Button
      >
    </div>{/if}
  {#if commentError}<p class="diff-error" role="alert">{commentError}</p>{/if}
</aside>

<style>
  .diff-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--sui-surface);
  }
  .diff-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .diff-actions {
    display: flex;
    gap: 4px;
  }
  .eyebrow {
    margin: 0 0 3px;
    color: var(--sui-primary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .diff-error {
    margin: 10px 16px;
    color: var(--sui-danger);
    font-size: 12px;
  }
  .diff-files {
    max-height: 34%;
    overflow: auto;
    border-bottom: 1px solid var(--shell-divider);
  }
  .diff-files button {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 9px 16px;
    border: 0;
    border-bottom: 1px solid var(--shell-divider);
    background: transparent;
    color: var(--sui-foreground);
    text-align: left;
  }
  .diff-files button.active {
    background: var(--shell-selected);
  }
  .diff-files strong {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .diff-files span,
  .diff-files small {
    color: var(--sui-muted);
    font-size: 11px;
  }
  .diff-files .drift {
    color: var(--sui-danger);
  }
  .diff-empty,
  .diff-fallback {
    margin: 16px;
    color: var(--sui-muted);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .diff-content {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }
  .diff-file-heading {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--shell-divider);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .diff-file-heading span {
    flex: 0 0 auto;
    color: var(--sui-muted);
  }
  .diff-area-tabs,
  .diff-file-actions,
  .diff-confirm,
  .hunk-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .diff-area-tabs,
  .diff-file-actions,
  .diff-confirm {
    padding: 6px 12px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .diff-confirm {
    flex-wrap: wrap;
    font-size: 12px;
  }
  .diff-confirm span {
    flex: 1;
  }
  .hunk-actions {
    margin-left: auto;
    padding-left: 16px;
  }
  .patch-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    font-size: 11px;
    line-height: 1.5;
  }
  .diff-line {
    width: max-content;
    min-width: 100%;
    padding: 0 12px;
    white-space: pre;
    display: flex;
    gap: 8px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .diff-line .line-number {
    width: 32px;
    flex: 0 0 32px;
    text-align: right;
    color: var(--sui-muted);
    user-select: none;
  }
  .diff-line:disabled {
    cursor: default;
  }
  .diff-line.selected {
    outline: 1px solid var(--sui-primary);
    background: var(--shell-selected);
  }
  .diff-comment-entry,
  .diff-comment-drafts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 16px;
    border-top: 1px solid var(--shell-divider);
    font-size: 12px;
  }
  .diff-comment-entry textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  .diff-comment-draft {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .diff-comment-draft > span:not(.diff-outdated) {
    flex: 1;
    min-width: 100px;
  }
  .diff-comment-draft button {
    border: 0;
    background: transparent;
    color: var(--sui-muted);
    cursor: pointer;
  }
  .diff-outdated {
    color: var(--sui-danger);
  }
  .diff-line.added {
    background: rgba(37, 153, 103, 0.13);
  }
  .diff-line.deleted {
    background: rgba(213, 82, 82, 0.13);
  }
  .diff-line.hunk {
    background: var(--shell-selected);
    color: var(--shell-selected-ink);
  }
</style>

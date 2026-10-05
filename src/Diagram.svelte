<script lang="ts">
  interface Props {
    source: string;
    dark: boolean;
    title?: string;
    onvalidation?: (valid: boolean) => void;
  }

  let { source, dark, title = 'Plan diagram', onvalidation }: Props = $props();
  let imageUrl = $state('');
  let error = $state('');
  let zoom = $state(100);
  let fullscreen: HTMLDialogElement;
  let generation = 0;

  function openFullscreen() {
    zoom = 100;
    fullscreen.showModal();
  }

  $effect(() => {
    const current = ++generation;
    imageUrl = '';
    error = '';
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'neutral',
        });
        try {
          await mermaid.parse(source);
        } catch {
          if (current === generation) {
            error = 'Diagram preview is unavailable.';
            onvalidation?.(false);
          }
          return;
        }
        if (current === generation) onvalidation?.(true);
        const rendered = await mermaid.render(
          `sai-plan-${current}-${Math.random().toString(36).slice(2)}`,
          source,
        );
        if (current === generation)
          imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
      } catch {
        if (current === generation) error = 'Diagram preview is unavailable.';
      }
    })();
  });
</script>

<div class="diagram" aria-label={title}>
  {#if imageUrl}
    <button class="diagram-preview" aria-label={`Expand ${title}`} onclick={openFullscreen}>
      <img src={imageUrl} alt={`${title}. Text version follows.`} />
      <span>Expand diagram ↗</span>
    </button>
  {:else if error}
    <p>{error}</p>
  {:else}
    <p>Rendering diagram…</p>
  {/if}
  <details class="diagram-source" open={!!error}>
    <summary>Read {title} as text</summary>
    <pre>{source}</pre>
  </details>
</div>

<dialog class="diagram-fullscreen" aria-label={`${title} fullscreen`} bind:this={fullscreen}>
  <div class="fullscreen-toolbar">
    <strong>{title}</strong>
    <div class="fullscreen-actions">
      <button aria-label="Zoom out" disabled={zoom <= 50} onclick={() => (zoom -= 25)}>−</button>
      <span>{zoom}%</span>
      <button aria-label="Zoom in" disabled={zoom >= 300} onclick={() => (zoom += 25)}>+</button>
      <button onclick={() => (zoom = 100)}>Reset</button>
      <button onclick={() => fullscreen.close()}>Close ✕</button>
    </div>
  </div>
  <div class="fullscreen-canvas">
    {#if imageUrl}<img
        src={imageUrl}
        alt={`${title}. Text version follows.`}
        style:width={`${zoom}%`}
      />{/if}
  </div>
  <details class="diagram-source">
    <summary>Read {title} as text</summary>
    <pre>{source}</pre>
  </details>
</dialog>

<style>
  .diagram {
    overflow: auto;
    padding: 16px;
    border: 1px solid var(--shell-divider);
    border-radius: 10px;
    background: var(--sui-surface);
  }
  .diagram-preview {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    color: var(--sui-primary);
    background: transparent;
    cursor: zoom-in;
    text-align: right;
  }
  .diagram-preview img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
  .diagram-preview span {
    display: block;
    margin-top: 8px;
    font-size: 12px;
  }
  p {
    margin: 0;
    color: var(--sui-muted);
    font-size: 13px;
  }
  pre {
    overflow: auto;
    font-size: 12px;
    white-space: pre-wrap;
  }
  .diagram-source {
    margin-top: 12px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
  }
  .diagram-fullscreen {
    position: fixed;
    inset: 0;
    width: 100vw;
    max-width: none;
    height: 100vh;
    max-height: none;
    margin: 0;
    padding: 16px;
    border: 0;
    color: var(--sui-foreground);
    background: var(--sui-canvas);
  }
  .diagram-fullscreen[open] {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .diagram-fullscreen::backdrop {
    background: rgb(0 0 0 / 70%);
  }
  .fullscreen-toolbar,
  .fullscreen-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fullscreen-toolbar {
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .fullscreen-actions button {
    padding: 6px 10px;
    border: 1px solid var(--sui-border);
    border-radius: 6px;
    color: var(--sui-foreground);
    background: var(--sui-surface);
  }
  .fullscreen-canvas {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--shell-divider);
    border-radius: 10px;
    background: var(--sui-surface);
  }
  .fullscreen-canvas img {
    display: block;
    min-width: 0;
    max-width: none;
    height: auto;
    margin: auto;
  }
</style>

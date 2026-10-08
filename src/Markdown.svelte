<script lang="ts">
  import { marked, type Token } from 'marked';
  import { openExternalLink } from './lib/external-link';
  import { safeMarkdownHref } from './lib/markdown';

  let { source, compact = false }: { source: string; compact?: boolean } = $props();
  let blocks = $derived(marked.lexer(source));
  let copied = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    copied = key;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = null), 1500);
  }
</script>

{#snippet inline(tokens: Token[])}
  {#each tokens as token, index (index)}
    {#if token.type === 'text' || token.type === 'escape'}{token.text}
    {:else if token.type === 'codespan'}<code>{token.text}</code>
    {:else if token.type === 'strong'}<strong>{@render inline(token.tokens ?? [])}</strong>
    {:else if token.type === 'em'}<em>{@render inline(token.tokens ?? [])}</em>
    {:else if token.type === 'del'}<del>{@render inline(token.tokens ?? [])}</del>
    {:else if token.type === 'link'}
      {#if safeMarkdownHref(token.href)}<a
          href={safeMarkdownHref(token.href) ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          onclick={(event) => openExternalLink(event, token.href)}
          >{@render inline(token.tokens ?? [])}</a
        >
      {:else}{@render inline(token.tokens ?? [])}{/if}
    {:else if token.type === 'image'}{token.text}
    {:else if token.type === 'br'}<br />
    {:else if 'text' in token && typeof token.text === 'string'}{token.text}{/if}
  {/each}
{/snippet}

{#snippet renderBlocks(tokens: Token[])}
  {#each tokens as token, index (index)}
    {#if token.type === 'paragraph'}<p>{@render inline(token.tokens ?? [])}</p>
    {:else if token.type === 'heading'}<svelte:element this={`h${token.depth}`}
        >{@render inline(token.tokens ?? [])}</svelte:element
      >
    {:else if token.type === 'code'}<div class="code-block">
        <button
          type="button"
          class="code-copy"
          aria-label="Copy code"
          onclick={() => void copy(`${index}`, token.text)}
          >{copied === `${index}` ? 'Copied' : 'Copy'}</button
        >
        <pre><code>{token.text}</code></pre>
      </div>
    {:else if token.type === 'blockquote'}<blockquote>
        {@render renderBlocks(token.tokens ?? [])}
      </blockquote>
    {:else if token.type === 'list'}
      {#if token.ordered}<ol start={token.start || 1}>
          {#each token.items as item, itemIndex (itemIndex)}<li>
              {@render renderBlocks(item.tokens)}
            </li>{/each}
        </ol>
      {:else}<ul>
          {#each token.items as item, itemIndex (itemIndex)}<li>
              {@render renderBlocks(item.tokens)}
            </li>{/each}
        </ul>{/if}
    {:else if token.type === 'table'}<div class="table-scroll">
        <table>
          <thead
            ><tr
              >{#each token.header as cell, cellIndex (cellIndex)}<th
                  >{@render inline(cell.tokens)}</th
                >{/each}</tr
            ></thead
          >
          <tbody
            >{#each token.rows as row, rowIndex (rowIndex)}<tr>
                {#each row as cell, cellIndex (cellIndex)}<td>{@render inline(cell.tokens)}</td
                  >{/each}
              </tr>{/each}</tbody
          >
        </table>
      </div>
    {:else if token.type === 'hr'}<hr />
    {:else if token.type === 'html'}<p>{token.text}</p>
    {:else if token.type === 'text'}<p>{@render inline(token.tokens ?? [token])}</p>{/if}
  {/each}
{/snippet}

<div class:compact class="markdown">{@render renderBlocks(blocks)}</div>

<style>
  .markdown {
    overflow-wrap: anywhere;
    font-size: var(--type-14);
    line-height: 1.5;
  }
  .markdown :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin: var(--space-16) 0 var(--space-8);
    font-size: var(--type-14);
    font-weight: 700;
    line-height: 1.3;
  }
  .markdown :global(:is(h1, h2, h3, h4, h5, h6):first-child) {
    margin-top: 0;
  }
  .markdown :global(h1) {
    font-size: var(--type-20);
  }
  .markdown :global(h2) {
    font-size: var(--type-16);
  }
  .markdown.compact :global(:is(h1, h2, h3, h4, h5, h6)) {
    font-size: inherit;
  }
  .markdown.compact {
    font-size: inherit;
    line-height: inherit;
  }
  .markdown.compact :global(p) {
    margin-bottom: 6px;
  }
  .markdown.compact :global(ul),
  .markdown.compact :global(ol) {
    margin: 4px 0;
  }
  .markdown :global(p) {
    margin: 0 0 10px;
    white-space: normal;
  }
  .markdown :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(pre) {
    overflow: auto;
    padding: 12px;
    border-radius: var(--radius-8);
    background: var(--sui-subtle);
  }
  .code-block {
    position: relative;
    margin: 0 0 10px;
  }
  .code-block pre {
    margin: 0;
  }
  .code-copy {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 8px;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-6);
    color: var(--sui-muted);
    background: var(--sui-surface);
    font-size: var(--type-12);
    opacity: 0;
    cursor: pointer;
  }
  .code-block:hover .code-copy,
  .code-copy:focus-visible {
    opacity: 1;
  }
  .markdown :global(code) {
    font:
      12px/1.5 ui-monospace,
      monospace;
  }
  .markdown :global(:not(pre) > code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--sui-subtle);
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 8px 0;
    padding-left: 24px;
  }
  .markdown :global(blockquote) {
    margin: 10px 0;
    padding-left: 12px;
    border-left: 3px solid var(--shell-divider);
  }
  .markdown :global(a) {
    color: var(--sui-primary);
  }
  .table-scroll {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
  }
  th,
  td {
    padding: 6px 9px;
    border: 1px solid var(--shell-divider);
    text-align: left;
  }
</style>

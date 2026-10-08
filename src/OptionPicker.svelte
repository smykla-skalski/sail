<script lang="ts">
  import { tick } from 'svelte';
  import HarnessIcon from './HarnessIcon.svelte';

  interface Choice {
    value: string;
    name: string;
    disabled?: boolean;
    icon?: string;
  }

  interface Props {
    label: string;
    value?: string;
    options: Choice[];
    open: boolean;
    disabled?: boolean;
    loading?: boolean;
    onopen: () => void;
    onclose: () => void;
    onchoose: (value: string) => void;
  }

  let {
    label,
    value,
    options,
    open,
    disabled = false,
    loading = false,
    onopen,
    onclose,
    onchoose,
  }: Props = $props();
  let menu = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let active = $state(0);
  let menuPosition = $state({ left: 0, top: 0, width: 210, maxHeight: 260 });
  const optionId = `picker-${crypto.randomUUID()}`;
  const selected = $derived(options.find((option) => option.value === value)?.name ?? value);
  const selectedIcon = $derived(options.find((option) => option.value === value)?.icon);

  $effect(() => {
    if (!open) return;
    active = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    void tick().then(() => {
      positionMenu();
      menu?.focus();
      return undefined;
    });
  });

  $effect(() => {
    if (!open) return;
    const observer = new ResizeObserver(positionMenu);
    if (trigger) observer.observe(trigger);
    const pane = trigger?.closest('.pane-leaf');
    if (pane) observer.observe(pane);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  });

  function positionMenu() {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const pane = trigger.closest('.pane-leaf')?.getBoundingClientRect();
    const leftEdge = Math.max(0, pane?.left ?? 0);
    const rightEdge = Math.min(window.innerWidth, pane?.right ?? window.innerWidth);
    const topEdge = Math.max(0, pane?.top ?? 0);
    const bottomEdge = Math.min(window.innerHeight, pane?.bottom ?? window.innerHeight);
    const width = Math.max(0, Math.min(210, rightEdge - leftEdge - 16));
    const above = Math.max(0, rect.top - topEdge - 8);
    const below = Math.max(0, bottomEdge - rect.bottom - 8);
    const menuHeight = Math.min(menu?.scrollHeight ?? 260, 260);
    const openAbove = above >= menuHeight || above >= below;
    const maxHeight = Math.min(260, openAbove ? above : below);
    menuPosition = {
      left: Math.max(leftEdge + 8, Math.min(rect.left, rightEdge - width - 8)),
      top: openAbove ? rect.top - Math.min(menuHeight, maxHeight) - 5 : rect.bottom + 5,
      width,
      maxHeight,
    };
  }

  $effect(() => {
    if (open && menu) {
      const index = active;
      void tick().then(() =>
        menu?.querySelectorAll('button')[index]?.scrollIntoView({ block: 'nearest' }),
      );
    }
  });

  function close() {
    onclose();
    void tick().then(() => trigger?.focus());
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      for (let offset = 1; offset <= options.length; offset++) {
        const next =
          (active + offset * (event.key === 'ArrowDown' ? 1 : -1) + options.length * offset) %
          options.length;
        if (!options[next].disabled) {
          active = next;
          break;
        }
      }
    } else if (event.key === 'Enter' && options[active] && !options[active].disabled) {
      event.preventDefault();
      event.stopPropagation();
      onchoose(options[active].value);
      close();
    }
  }
</script>

<div class="option-picker">
  <button
    type="button"
    class="option-trigger"
    bind:this={trigger}
    aria-label={`${label}: ${selected || 'Choose'}`}
    aria-expanded={open}
    {disabled}
    onclick={onopen}
    title={`${label}: ${selected || 'Choose'}`}
  >
    {#if selectedIcon}<HarnessIcon agent={selectedIcon} />{/if}
    <span class="option-value">{selected || label}</span>
    <svg class="option-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="m2.5 4.5 3.5 3.5 3.5-3.5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>
  {#if open}
    <div
      class="option-menu"
      style:left={`${menuPosition.left}px`}
      style:top={`${menuPosition.top}px`}
      style:width={`${menuPosition.width}px`}
      style:max-height={`${menuPosition.maxHeight}px`}
      role="listbox"
      aria-label={label}
      aria-activedescendant={options[active] ? `${optionId}-${active}` : undefined}
      tabindex="-1"
      bind:this={menu}
      onkeydown={keydown}
      onfocusout={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onclose();
      }}
    >
      {#if loading}
        <div class="option-empty">Loading…</div>
      {:else if !options.length}
        <div class="option-empty">No choices available for this model or agent.</div>
      {:else}
        {#each options as option, index (option.value)}
          <button
            id={`${optionId}-${index}`}
            type="button"
            role="option"
            tabindex="-1"
            aria-selected={option.value === value}
            class:active={index === active}
            disabled={option.disabled}
            onclick={() => {
              if (option.disabled) return;
              onchoose(option.value);
              close();
            }}
            >{#if option.icon}<HarnessIcon agent={option.icon} />{/if}{option.name}</button
          >
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .option-picker {
    position: relative;
    min-width: 0;
  }
  .option-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 190px;
    min-height: 30px;
    padding: 4px 6px;
    border: 0;
    border-radius: 5px;
    color: var(--sui-muted);
    background: transparent;
    font-size: 13px;
    white-space: nowrap;
  }
  .option-trigger:hover:not(:disabled),
  .option-trigger[aria-expanded='true'] {
    color: var(--sui-foreground);
    background: var(--shell-selected);
  }
  .option-trigger:disabled {
    opacity: 0.5;
  }
  .option-value {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .option-chevron {
    flex: none;
    width: 12px;
    height: 12px;
    opacity: 0.8;
  }
  .option-menu {
    position: fixed;
    z-index: 20;
    box-sizing: border-box;
    max-height: 260px;
    overflow: auto;
    padding: 4px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
    background: var(--sui-surface);
    box-shadow: 0 8px 24px #0002;
  }
  .option-menu button {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 8px;
    border: 0;
    border-radius: 5px;
    color: inherit;
    background: transparent;
    text-align: left;
  }
  .option-menu button.active,
  .option-menu button:hover:not(:disabled) {
    background: var(--shell-selected);
  }
  .option-menu button:disabled {
    opacity: 0.5;
  }
  .option-empty {
    padding: 8px;
    color: var(--sui-muted);
    font-size: 12px;
  }
</style>

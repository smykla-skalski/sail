<script lang="ts">
  import { tick, type Snippet } from 'svelte';

  let {
    label,
    menuLabel,
    ariaLabel,
    title,
    disabled = false,
    class: className = '',
    trigger,
    children,
  }: {
    label: string;
    menuLabel: string;
    ariaLabel?: string;
    title?: string;
    disabled?: boolean;
    class?: string;
    trigger?: Snippet;
    children: Snippet;
  } = $props();

  const id = $props.id();
  let open = $state(false);
  let x = $state(0);
  let y = $state(0);
  let triggerElement: HTMLButtonElement;
  let menuElement: HTMLDivElement;

  function items() {
    return [
      ...menuElement.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])',
      ),
    ];
  }

  async function show(focus: 'first' | 'last' = 'first') {
    open = true;
    x = 0;
    y = 0;
    await tick();
    // A container query ancestor becomes the containing block of this fixed popup.
    const origin = menuElement.getBoundingClientRect();
    const bounds = triggerElement.getBoundingClientRect();
    const width = menuElement.offsetWidth;
    const height = menuElement.offsetHeight;
    const left = Math.max(8, Math.min(bounds.right - width, innerWidth - width - 8));
    const top =
      bounds.bottom + 4 + height <= innerHeight - 8 ? bounds.bottom + 4 : bounds.top - height - 4;
    x = left - origin.left;
    y = Math.max(8, top) - origin.top;
    const list = items();
    const target = focus === 'first' ? list[0] : list.at(-1);
    (target ?? menuElement).focus({ preventScroll: true });
  }

  function hide(restoreFocus = false) {
    if (!open) return;
    open = false;
    if (restoreFocus) triggerElement.focus();
  }

  function moveFocus(key: string) {
    const list = items();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next =
      key === 'Home'
        ? 0
        : key === 'End'
          ? list.length - 1
          : key === 'ArrowDown'
            ? (index + 1) % list.length
            : (index - 1 + list.length) % list.length;
    list[next].focus();
  }

  function keydown(event: KeyboardEvent) {
    if (!open) {
      if (event.target !== triggerElement) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      void show(event.key === 'ArrowDown' ? 'first' : 'last');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide(true);
    } else if (event.key === 'Tab') hide(true);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveFocus(event.key);
    }
  }

  // Runs before the item's handler so a dialog it opens returns focus to the trigger.
  function itemClick(event: MouseEvent) {
    const item = (event.target as Element).closest('[role^="menuitem"]');
    if (item && !item.matches(':disabled, [aria-disabled="true"]')) hide(true);
  }
</script>

<svelte:window
  onclick={(event) => {
    if (
      open &&
      !menuElement.contains(event.target as Node) &&
      !triggerElement.contains(event.target as Node)
    )
      hide();
  }}
  onresize={() => hide()}
/>

<div class="menu-button {className}" role="none" onkeydown={keydown}>
  <button
    bind:this={triggerElement}
    type="button"
    class="menu-trigger"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={id}
    aria-label={ariaLabel}
    {title}
    {disabled}
    onclick={() => (open ? hide() : void show())}
    >{#if trigger}{@render trigger()}{:else}{label}{/if}</button
  >
  <div
    bind:this={menuElement}
    {id}
    class="menu-popup"
    role="menu"
    tabindex="-1"
    aria-label={menuLabel}
    hidden={!open}
    style={`left: ${x}px; top: ${y}px`}
    onclickcapture={itemClick}
  >
    {@render children()}
  </div>
</div>

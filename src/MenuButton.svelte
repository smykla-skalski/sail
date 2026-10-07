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
    await tick();
    const bounds = triggerElement.getBoundingClientRect();
    const width = menuElement.offsetWidth;
    const height = menuElement.offsetHeight;
    x = Math.max(8, Math.min(bounds.right - width, innerWidth - width - 8));
    y = bounds.bottom + 4 + height <= innerHeight - 8 ? bounds.bottom + 4 : bounds.top - height - 4;
    y = Math.max(8, y);
    const list = items();
    (focus === 'first' ? list[0] : list.at(-1))?.focus({ preventScroll: true });
  }

  function hide(restoreFocus = false) {
    if (!open) return;
    open = false;
    if (restoreFocus) triggerElement.focus();
  }

  function triggerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    void show(event.key === 'ArrowDown' ? 'first' : 'last');
  }

  function menuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide(true);
      return;
    }
    if (event.key === 'Tab') {
      hide();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const list = items();
    if (!list.length) return;
    event.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? list.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % list.length
            : (index - 1 + list.length) % list.length;
    list[next].focus();
  }

  function menuClick(event: MouseEvent) {
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

<div class="menu-button {className}">
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
    onkeydown={triggerKeydown}
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
    onkeydown={menuKeydown}
    onclick={menuClick}
  >
    {@render children()}
  </div>
</div>

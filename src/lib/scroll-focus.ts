/** True when a scroll container's content is taller than its box. */
export function overflows(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight > 1;
}

/**
 * Svelte attachment that puts a scroll container in the tab order while its
 * content overflows, so keyboard users can scroll a text-only transcript.
 * A focused container keeps its tab stop until focus leaves.
 */
export function keyboardScrollable(node: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    timer = undefined;
    if (overflows(node.scrollHeight, node.clientHeight)) node.tabIndex = 0;
    else if (document.activeElement !== node) node.removeAttribute('tabindex');
  };
  // A timer, not a frame: hidden or occluded windows skip animation frames.
  const schedule = () => {
    timer ??= setTimeout(update, 50);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(node);
  const mutations = new MutationObserver(schedule);
  mutations.observe(node, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  node.addEventListener('blur', schedule);
  schedule();
  return () => {
    clearTimeout(timer);
    resize.disconnect();
    mutations.disconnect();
    node.removeEventListener('blur', schedule);
  };
}

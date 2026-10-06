const activeClass = 'sail-scrollbar-active';
const idleDelay = 700;

export function installScrollbarVisibility(root: Document = document) {
  const idleTimers = new Map<Element, ReturnType<typeof setTimeout>>();

  const onScroll = (event: Event) => {
    if (!(event.target instanceof Element)) return;

    const element = event.target;
    const previous = idleTimers.get(element);
    if (previous) clearTimeout(previous);

    element.classList.add(activeClass);
    idleTimers.set(
      element,
      setTimeout(() => {
        element.classList.remove(activeClass);
        idleTimers.delete(element);
      }, idleDelay),
    );
  };

  root.addEventListener('scroll', onScroll, true);

  return () => {
    root.removeEventListener('scroll', onScroll, true);
    for (const [element, timer] of idleTimers) {
      clearTimeout(timer);
      element.classList.remove(activeClass);
    }
    idleTimers.clear();
  };
}

const activeClass = 'sail-scrollbar-active';
export const scrollbarIdleDelay = 700;

type ScrollbarElement = EventTarget & {
  classList: Pick<DOMTokenList, 'add' | 'remove'>;
};

export type ScrollbarRoot = EventTarget & {
  readonly scrollingElement: ScrollbarElement | null;
  addEventListener(type: 'scroll', listener: EventListener, capture: true): void;
  removeEventListener(type: 'scroll', listener: EventListener, capture: true): void;
};

function isScrollbarElement(target: EventTarget | null): target is ScrollbarElement {
  return target !== null && 'classList' in target;
}

export function installScrollbarVisibility(
  root: ScrollbarRoot = document,
  idleDelay = scrollbarIdleDelay,
) {
  const idleTimers = new Map<ScrollbarElement, ReturnType<typeof setTimeout>>();

  const onScroll = (event: Event) => {
    const target = event.target === root ? root.scrollingElement : event.target;
    if (!isScrollbarElement(target)) return;

    const element = target;
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

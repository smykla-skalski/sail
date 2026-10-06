import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installScrollbarVisibility,
  scrollbarIdleDelay,
  type ScrollbarRoot,
} from '../src/lib/scrollbars.ts';

class FakeElement extends EventTarget {
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
}

function fakeDocument(scrollingElement = new FakeElement()) {
  let scrollListener: EventListener | undefined;
  const root = Object.assign(new EventTarget(), { scrollingElement });
  root.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null) => {
    if (type === 'scroll' && typeof listener === 'function') scrollListener = listener;
  };
  root.removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ) => {
    if (type === 'scroll' && scrollListener === listener) scrollListener = undefined;
  };

  return {
    root: root satisfies ScrollbarRoot,
    scroll(target: EventTarget) {
      const event = new Event('scroll');
      Object.defineProperty(event, 'target', { value: target });
      scrollListener?.(event);
    },
  };
}

const activeClass = 'sail-scrollbar-active';
const wait = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));

await test('activates element scrollbars until the reset idle delay expires', async () => {
  const element = new FakeElement();
  const document = fakeDocument();
  const cleanup = installScrollbarVisibility(document.root, 100);

  document.scroll(element);
  await wait(60);
  document.scroll(element);
  await wait(60);
  assert.equal(element.classList.contains(activeClass), true);

  await wait(60);
  assert.equal(element.classList.contains(activeClass), false);
  cleanup();
});

await test('uses the scrolling element for viewport scrolls', () => {
  const scrollingElement = new FakeElement();
  const document = fakeDocument(scrollingElement);
  const cleanup = installScrollbarVisibility(document.root);

  document.scroll(document.root);
  assert.equal(scrollingElement.classList.contains(activeClass), true);
  cleanup();
});

await test('cleanup removes activity and stops observing scrolls', () => {
  const element = new FakeElement();
  const document = fakeDocument();
  const cleanup = installScrollbarVisibility(document.root);

  document.scroll(element);
  cleanup();
  assert.equal(element.classList.contains(activeClass), false);

  document.scroll(element);
  assert.equal(element.classList.contains(activeClass), false);
  assert.equal(scrollbarIdleDelay, 700);
});

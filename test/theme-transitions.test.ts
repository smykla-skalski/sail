import assert from 'node:assert/strict';
import test from 'node:test';
import {
  guardThemeTransitions,
  themeAttributes,
  type ThemeRoot,
} from '../src/lib/theme-transitions.ts';

type Entry = { callback: () => void; options?: MutationObserverInit; live: boolean };

function fakeRoot() {
  const events: string[] = [];
  const root: ThemeRoot = {
    dataset: {},
    getBoundingClientRect() {
      events.push(`layout:${'themeSwitching' in root.dataset ? 'guarded' : 'open'}`);
      return {};
    },
  };
  return { root, events };
}

function fakeObserver() {
  const entries: Entry[] = [];
  class Observer {
    readonly entry: Entry;
    constructor(callback: () => void) {
      this.entry = { callback, live: false };
      entries.push(this.entry);
    }
    observe(_target: ThemeRoot, options?: MutationObserverInit) {
      this.entry.options = options;
      this.entry.live = true;
    }
    disconnect() {
      this.entry.live = false;
    }
  }
  return { Observer, entries };
}

void test('theme changes flush styles with transitions disabled, then restore them', () => {
  const { root, events } = fakeRoot();
  const { Observer, entries } = fakeObserver();
  guardThemeTransitions(root, Observer);
  assert.deepEqual(entries[0].options, { attributes: true, attributeFilter: themeAttributes });

  root.dataset.suiTheme = 'dark';
  entries[0].callback();

  assert.deepEqual(events, ['layout:guarded']);
  assert.equal('themeSwitching' in root.dataset, false);
  assert.equal(root.dataset.suiTheme, 'dark');
});

void test('the guard ignores its own attribute and stops when removed', () => {
  const { root } = fakeRoot();
  const { Observer, entries } = fakeObserver();
  const remove = guardThemeTransitions(root, Observer);
  assert.equal(entries[0].options?.attributeFilter?.includes('data-theme-switching'), false);
  remove();
  assert.equal(entries[0].live, false);
});

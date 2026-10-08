import assert from 'node:assert/strict';
import test from 'node:test';
import { OPEN_IN_SPLIT_EVENT, openExternalLink } from '../src/lib/external-link.ts';

function run(url: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean }) {
  const calls: unknown[] = [];
  const target = new EventTarget();
  const globals = globalThis as Record<string, unknown>;
  globals.isTauri = true;
  globals.window = Object.assign(target, {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: unknown) => {
        calls.push({ command, args });
        return Promise.resolve();
      },
    },
  });
  const urls: string[] = [];
  target.addEventListener(OPEN_IN_SPLIT_EVENT, (event) => {
    if (event instanceof CustomEvent) urls.push(String(event.detail.url));
  });
  let prevented = false;
  openExternalLink(
    {
      metaKey: false,
      ctrlKey: false,
      ...modifiers,
      preventDefault: () => (prevented = true),
    },
    url,
  );
  return { calls, urls, prevented };
}

void test('plain click opens the system browser', () => {
  const result = run('https://example.com', {});
  assert.deepEqual(result.urls, []);
  assert.equal(result.calls.length, 1);
  assert.ok(result.prevented);
});

void test('cmd or ctrl click on http(s) opens a split browser pane', () => {
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
    const result = run('https://example.com/a', modifiers);
    assert.deepEqual(result.urls, ['https://example.com/a']);
    assert.equal(result.calls.length, 0);
    assert.ok(result.prevented);
  }
});

void test('cmd click on non-http links keeps the system handler', () => {
  const result = run('mailto:a@b.c', { metaKey: true });
  assert.deepEqual(result.urls, []);
  assert.equal(result.calls.length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseThemePreference, resolveTheme, watchSystemDark } from '../src/lib/theme.ts';

void test('stored Light and Dark choices survive and everything else follows the OS', () => {
  const cases: [string | null, string][] = [
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    [null, 'system'],
    ['', 'system'],
    ['Dark', 'system'],
  ];
  for (const [stored, expected] of cases)
    assert.equal(parseThemePreference(stored), expected, String(stored));
});

void test('System resolves from the OS appearance; explicit choices ignore it', () => {
  const cases: [Parameters<typeof resolveTheme>[0], boolean, string][] = [
    ['system', true, 'dark'],
    ['system', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
  ];
  for (const [preference, systemDark, expected] of cases)
    assert.equal(resolveTheme(preference, systemDark), expected, `${preference} ${systemDark}`);
});

void test('watchSystemDark reports the current OS state, live changes, and stops on cleanup', () => {
  let listener: ((event: { matches: boolean }) => void) | undefined;
  const query = {
    matches: true,
    addEventListener: (_: 'change', next: (event: { matches: boolean }) => void) =>
      (listener = next),
    removeEventListener: () => (listener = undefined),
  };
  const seen: boolean[] = [];
  const stop = watchSystemDark((dark) => seen.push(dark), query);
  listener?.({ matches: false });
  stop();
  listener?.({ matches: true });
  assert.deepEqual(seen, [true, false]);
  assert.equal(listener, undefined);
});

void test('watchSystemDark falls back to light without matchMedia', () => {
  const seen: boolean[] = [];
  watchSystemDark((dark) => seen.push(dark), undefined);
  assert.deepEqual(seen, [false]);
});

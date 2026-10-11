import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ariaKeyShortcutsFor,
  detectShortcutPlatform,
  matches,
  shortcutFor,
  shortcutForEvent,
  shortcutLabel,
  shortcuts,
  terminalOwnsKey,
  type ShortcutId,
  type ShortcutPlatform,
} from '../src/lib/shortcuts.ts';

const key = (
  value: string,
  modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

void test('primary shortcuts use Command on macOS and Control elsewhere', () => {
  for (const shortcut of shortcuts.filter((entry) => entry.modifier === 'primary')) {
    for (const platform of ['mac', 'other'] as const) {
      const primary = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
      const secondary = platform === 'mac' ? { ctrlKey: true } : { metaKey: true };
      const event = { shiftKey: shortcut.shift ?? false };
      assert.equal(
        matches(key(shortcut.keys[0], { ...primary, ...event }), shortcut.id, platform),
        true,
        shortcut.id,
      );
      assert.equal(
        matches(key(shortcut.keys[0], { ...secondary, ...event }), shortcut.id, platform),
        false,
        shortcut.id,
      );
      assert.equal(
        matches(
          key(shortcut.keys[0], { metaKey: true, ctrlKey: true, ...event }),
          shortcut.id,
          platform,
        ),
        false,
        shortcut.id,
      );
    }
  }
  assert.equal(shortcutForEvent(key('j', { metaKey: true }), 'mac')?.id, 'attention.next');
  assert.equal(shortcutForEvent(key('j', { ctrlKey: true }), 'mac'), undefined);
  assert.equal(shortcutForEvent(key('j', { ctrlKey: true }), 'other')?.id, 'attention.next');
  assert.equal(
    shortcutForEvent(key('J', { metaKey: true, shiftKey: true }), 'mac')?.id,
    'chat.side',
  );
  assert.equal(shortcutForEvent(key('j', { ctrlKey: true, shiftKey: true }), 'mac'), undefined);
  assert.equal(shortcutForEvent(key('j'), 'mac'), undefined);
  assert.equal(shortcutForEvent(key('j', { metaKey: true, altKey: true }), 'mac'), undefined);
});

void test('no two shortcuts match the same key press', () => {
  const combos = shortcuts.flatMap((shortcut) =>
    shortcut.keys.flatMap((value) =>
      [false, true].flatMap((shiftKey) =>
        [
          { metaKey: true, ctrlKey: false },
          { metaKey: false, ctrlKey: true },
        ].map((modifiers) => key(value, { ...modifiers, shiftKey })),
      ),
    ),
  );
  for (const platform of ['mac', 'other'] as const) {
    for (const event of combos) {
      const owners = shortcuts.filter((shortcut) => matches(event, shortcut.id, platform));
      assert.ok(
        owners.length <= 1,
        `${platform} ${event.key} ${JSON.stringify(event)} matches ${owners.length}`,
      );
    }
  }
});

void test('existing workspace shortcuts keep their modifiers', () => {
  const cases: [ShortcutId, ReturnType<typeof key>, ShortcutPlatform, boolean][] = [
    ['sidebar.toggle', key('b', { metaKey: true }), 'mac', true],
    ['sidebar.toggle', key('b', { ctrlKey: true, shiftKey: true }), 'mac', false],
    ['threads.cycle', key('Tab', { ctrlKey: true, shiftKey: true }), 'mac', true],
    ['threads.cycle', key('Tab', { metaKey: true }), 'mac', false],
    ['threads.jump', key('3', { metaKey: true }), 'mac', true],
    ['threads.jump', key('3', { ctrlKey: true }), 'mac', false],
    ['threads.jump', key('0', { metaKey: true }), 'mac', false],
    ['worktree.close', key('W', { metaKey: true, shiftKey: true }), 'mac', true],
    ['pane.close', key('w', { ctrlKey: true }), 'mac', false],
    ['pane.split', key('d', { metaKey: true, shiftKey: true }), 'mac', true],
    ['settings.open', key(',', { metaKey: true }), 'mac', true],
    ['details.toggle', key('l', { metaKey: true }), 'mac', true],
  ];
  for (const [id, event, platform, expected] of cases)
    assert.equal(matches(event, id, platform), expected, `${id} ${event.key}`);
});

void test('labels and aria-keyshortcuts come from the registry', () => {
  assert.equal(shortcutLabel(shortcutFor('attention.next'), 'mac'), '⌘J');
  assert.equal(shortcutLabel(shortcutFor('attention.next'), 'other'), 'Ctrl+J');
  assert.equal(shortcutLabel(shortcutFor('chat.side'), 'mac'), '⌘⇧J');
  assert.equal(shortcutLabel(shortcutFor('threads.cycle'), 'mac'), '⌃Tab');
  assert.equal(ariaKeyShortcutsFor('attention.next', 'mac'), 'Meta+J');
  assert.equal(ariaKeyShortcutsFor('attention.next', 'other'), 'Control+J');
  assert.equal(ariaKeyShortcutsFor('chat.side', 'mac'), 'Meta+Shift+J');
  assert.equal(shortcutFor('attention.next').label, 'Go to next item needing attention');
  assert.equal(new Set(shortcuts.map((shortcut) => shortcut.id)).size, shortcuts.length);
});

void test('shortcut sheet uses the platform primary modifier with any Shift state', () => {
  assert.equal(shortcutForEvent(key('/', { metaKey: true }), 'mac')?.id, 'shortcuts.help');
  assert.equal(shortcutForEvent(key('/', { ctrlKey: true }), 'mac'), undefined);
  assert.equal(shortcutForEvent(key('/', { ctrlKey: true }), 'other')?.id, 'shortcuts.help');
  assert.equal(
    shortcutForEvent(key('/', { metaKey: true, shiftKey: true }), 'mac')?.id,
    'shortcuts.help',
  );
  assert.equal(shortcutForEvent(key('/'), 'mac'), undefined);
  assert.equal(shortcutLabel(shortcutFor('shortcuts.help'), 'mac'), '⌘/');
  assert.equal(shortcutLabel(shortcutFor('shortcuts.help'), 'other'), 'Ctrl+/');
});

void test('every registry entry has a label and a sheet label on each platform', () => {
  for (const shortcut of shortcuts) {
    assert.ok(shortcut.label.length > 0, shortcut.id);
    assert.ok(shortcutLabel(shortcut, 'mac').length > 1, shortcut.id);
    assert.ok(shortcutLabel(shortcut, 'other').length > 1, shortcut.id);
  }
});

void test('platform detection reads the platform string, then the user agent', () => {
  assert.equal(detectShortcutPlatform({ platform: 'MacIntel', userAgent: '' }), 'mac');
  assert.equal(detectShortcutPlatform({ platform: 'Win32', userAgent: 'Mozilla Mac' }), 'other');
  assert.equal(detectShortcutPlatform({ platform: '', userAgent: 'X11; Linux' }), 'other');
  assert.equal(detectShortcutPlatform({ platform: '', userAgent: 'Macintosh' }), 'mac');
});

await test('a terminal keeps Ctrl+[ while Cmd and shifted shortcuts still work there', () => {
  const terminal = { closest: (selector: string) => (selector === '.xterm' ? {} : null) };
  const composer = { closest: () => null };
  type Keys = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>;
  const ctrl: Keys = { ctrlKey: true, metaKey: false, shiftKey: false };
  const cases: [Keys, typeof terminal | null, boolean][] = [
    [ctrl, terminal, true],
    [{ ...ctrl, shiftKey: true }, terminal, false],
    [ctrl, composer, false],
    [ctrl, null, false],
    [{ ctrlKey: false, metaKey: true, shiftKey: false }, terminal, false],
  ];
  for (const [event, target, expected] of cases)
    assert.equal(terminalOwnsKey(event, target), expected);
});

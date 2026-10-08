import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ariaKeyShortcutsFor,
  matches,
  shortcutFor,
  shortcutForEvent,
  shortcutLabel,
  shortcuts,
  type ShortcutId,
} from '../src/lib/shortcuts.ts';

const key = (
  value: string,
  modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });

void test('Command J goes to the next attention item and Command Shift J stays side chat', () => {
  assert.equal(shortcutForEvent(key('j', { metaKey: true }))?.id, 'attention.next');
  assert.equal(shortcutForEvent(key('J', { metaKey: true, shiftKey: true }))?.id, 'chat.side');
  assert.equal(shortcutForEvent(key('j', { ctrlKey: true }))?.id, 'attention.next');
  assert.equal(shortcutForEvent(key('j', { ctrlKey: true, shiftKey: true })), undefined);
  assert.equal(shortcutForEvent(key('j')), undefined);
  assert.equal(shortcutForEvent(key('j', { metaKey: true, altKey: true })), undefined);
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
  for (const event of combos) {
    const owners = shortcuts.filter((shortcut) => matches(event, shortcut.id));
    assert.ok(owners.length <= 1, `${event.key} ${JSON.stringify(event)} matches ${owners.length}`);
  }
});

void test('existing workspace shortcuts keep their modifiers', () => {
  const cases: [ShortcutId, ReturnType<typeof key>, boolean][] = [
    ['sidebar.toggle', key('b', { metaKey: true }), true],
    ['sidebar.toggle', key('b', { ctrlKey: true, shiftKey: true }), false],
    ['threads.cycle', key('Tab', { ctrlKey: true, shiftKey: true }), true],
    ['threads.cycle', key('Tab', { metaKey: true }), false],
    ['threads.jump', key('3', { metaKey: true }), true],
    ['threads.jump', key('3', { ctrlKey: true }), false],
    ['threads.jump', key('0', { metaKey: true }), false],
    ['worktree.close', key('W', { metaKey: true, shiftKey: true }), true],
    ['pane.close', key('w', { ctrlKey: true }), true],
    ['pane.split', key('d', { metaKey: true, shiftKey: true }), true],
    ['settings.open', key(',', { metaKey: true }), true],
    ['details.toggle', key('l', { metaKey: true }), true],
  ];
  for (const [id, event, expected] of cases)
    assert.equal(matches(event, id), expected, `${id} ${event.key}`);
});

void test('labels and aria-keyshortcuts come from the registry', () => {
  assert.equal(shortcutLabel(shortcutFor('attention.next'), 'mac'), '⌘J');
  assert.equal(shortcutLabel(shortcutFor('attention.next'), 'other'), 'Ctrl+J');
  assert.equal(shortcutLabel(shortcutFor('chat.side'), 'mac'), '⌘⇧J');
  assert.equal(shortcutLabel(shortcutFor('threads.cycle'), 'mac'), '⌃Tab');
  assert.equal(ariaKeyShortcutsFor('attention.next'), 'Meta+J Control+J');
  assert.equal(ariaKeyShortcutsFor('chat.side'), 'Meta+Shift+J');
  assert.equal(shortcutFor('attention.next').label, 'Go to next item needing attention');
  assert.equal(new Set(shortcuts.map((shortcut) => shortcut.id)).size, shortcuts.length);
});

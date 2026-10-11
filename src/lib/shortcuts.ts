/**
 * One registry for the workspace keyboard shortcuts. `keydownWorkspace` matches
 * events against it, controls publish `aria-keyshortcuts` from it, and the
 * shortcut sheet and command palette read their labels from it.
 */
export type ShortcutModifier =
  /** Command on macOS, Control elsewhere. */
  | 'primary'
  /** Command only. */
  | 'meta'
  /** Control only. */
  | 'ctrl';

export type Shortcut = {
  id: string;
  label: string;
  modifier: ShortcutModifier;
  /** Accepted `KeyboardEvent.key` values, compared case-insensitively. */
  keys: readonly string[];
  /** `undefined` accepts both states of Shift. */
  shift?: boolean;
  alt?: boolean;
  /** Shown instead of `keys[0]` when several keys share one shortcut. */
  display?: string;
};

export const digitKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const shortcuts = [
  {
    id: 'sidebar.toggle',
    label: 'Toggle sidebar',
    modifier: 'primary',
    keys: ['b'],
    shift: false,
  },
  {
    id: 'chat.side',
    label: 'Open side chat',
    modifier: 'meta',
    keys: ['j'],
    shift: true,
  },
  {
    id: 'attention.next',
    label: 'Go to next item needing attention',
    modifier: 'primary',
    keys: ['j'],
    shift: false,
  },
  {
    id: 'subagent.parent',
    label: 'Go to parent thread',
    modifier: 'primary',
    keys: ['['],
    shift: false,
  },
  {
    id: 'subagent.previous',
    label: 'Go to previous sibling subagent',
    modifier: 'primary',
    keys: ['[', '{'],
    shift: true,
    display: '[',
  },
  {
    id: 'subagent.next',
    label: 'Go to next sibling subagent',
    modifier: 'primary',
    keys: [']', '}'],
    shift: true,
    display: ']',
  },
  {
    id: 'settings.open',
    label: 'Open settings',
    modifier: 'primary',
    keys: [','],
    shift: false,
  },
  {
    id: 'threads.cycle',
    label: 'Cycle recent threads',
    modifier: 'ctrl',
    keys: ['tab'],
    display: 'Tab',
  },
  {
    id: 'threads.jump',
    label: 'Jump to recent thread',
    modifier: 'meta',
    keys: digitKeys,
    shift: false,
    display: '1-9',
  },
  {
    id: 'palette.open',
    label: 'Open command palette',
    modifier: 'primary',
    keys: ['k'],
    shift: false,
  },
  {
    id: 'shortcuts.help',
    label: 'Show keyboard shortcuts',
    modifier: 'primary',
    keys: ['/'],
  },
  {
    id: 'worktree.close',
    label: 'Close worktree',
    modifier: 'primary',
    keys: ['w'],
    shift: true,
  },
  {
    id: 'worktree.new',
    label: 'New worktree',
    modifier: 'primary',
    keys: ['n'],
    shift: false,
  },
  {
    id: 'pane.close',
    label: 'Close pane',
    modifier: 'primary',
    keys: ['w'],
    shift: false,
  },
  {
    id: 'terminal.split',
    label: 'Split with terminal',
    modifier: 'primary',
    keys: ['t'],
    shift: false,
  },
  {
    id: 'pane.split',
    label: 'Split pane',
    modifier: 'primary',
    keys: ['d'],
  },
  {
    id: 'details.toggle',
    label: 'Toggle changes and Ship details',
    modifier: 'primary',
    keys: ['l'],
    shift: false,
  },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof shortcuts)[number]['id'];

const registry: ReadonlyMap<string, Shortcut> = new Map(
  shortcuts.map((shortcut) => [shortcut.id, shortcut]),
);

export function shortcutFor(id: ShortcutId): Shortcut {
  const shortcut = registry.get(id);
  if (!shortcut) throw new Error(`Unknown shortcut ${id}.`);
  return shortcut;
}

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

export type ShortcutPlatform = 'mac' | 'other';

export function detectShortcutPlatform(
  agent: Pick<Navigator, 'platform' | 'userAgent'> | undefined = globalThis.navigator,
): ShortcutPlatform {
  return /mac/i.test(agent?.platform || agent?.userAgent || '') ? 'mac' : 'other';
}

export function matchesShortcut(
  event: KeyEventLike,
  shortcut: Shortcut,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  const modifier =
    shortcut.modifier === 'primary' ? (platform === 'mac' ? 'meta' : 'ctrl') : shortcut.modifier;
  return (
    (modifier === 'meta' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    event.altKey === (shortcut.alt ?? false) &&
    (shortcut.shift === undefined || event.shiftKey === shortcut.shift) &&
    shortcut.keys.includes(event.key.toLowerCase())
  );
}

/** Ctrl+[ is Escape in a terminal, so it stays there. Cmd on macOS and the shifted sibling
 * shortcuts still work from a terminal. */
export function terminalOwnsKey(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  target: { closest?: (selector: string) => unknown } | null,
): boolean {
  return event.ctrlKey && !event.metaKey && !event.shiftKey && !!target?.closest?.('.xterm');
}

/** The registered shortcut that matches the event, if any. */
export function shortcutForEvent(
  event: KeyEventLike,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): Shortcut | undefined {
  return shortcuts.find((shortcut) => matchesShortcut(event, shortcut, platform));
}

export function matches(
  event: KeyEventLike,
  id: ShortcutId,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  return matchesShortcut(event, shortcutFor(id), platform);
}

function keyName(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Human label such as `⌘J`, `⌘⇧J` or `Ctrl+J`. */
export function shortcutLabel(shortcut: Shortcut, platform: ShortcutPlatform = 'mac'): string {
  const key = shortcut.display ?? keyName(shortcut.keys[0]);
  const shift = shortcut.shift === true;
  if (platform === 'mac') {
    const modifier = shortcut.modifier === 'ctrl' ? '⌃' : '⌘';
    return `${modifier}${shift ? '⇧' : ''}${key}`;
  }
  const modifier = shortcut.modifier === 'meta' ? 'Meta' : 'Ctrl';
  return `${modifier}+${shift ? 'Shift+' : ''}${key}`;
}

/** Value for `aria-keyshortcuts`. */
export function ariaKeyShortcuts(
  shortcut: Shortcut,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  const key = shortcut.display ?? keyName(shortcut.keys[0]);
  const shift = shortcut.shift === true ? 'Shift+' : '';
  const modifier =
    shortcut.modifier === 'primary' ? (platform === 'mac' ? 'meta' : 'ctrl') : shortcut.modifier;
  return `${modifier === 'meta' ? 'Meta' : 'Control'}+${shift}${key}`;
}

export function ariaKeyShortcutsFor(
  id: ShortcutId,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return ariaKeyShortcuts(shortcutFor(id), platform);
}

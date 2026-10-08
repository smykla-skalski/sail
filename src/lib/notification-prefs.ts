import type { AttentionKind, AttentionTarget } from './attention-items.ts';

export const notificationTypes = ['input', 'completed', 'ship'] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notificationTypeLabels: Record<NotificationType, string> = {
  input: 'Needs your input',
  completed: 'Turn completed',
  ship: 'Ship updates',
};

export const notificationPreferences = ['never', 'background', 'always'] as const;
export type NotificationPreference = (typeof notificationPreferences)[number];

export const notificationPreferenceLabels: Record<NotificationPreference, string> = {
  never: 'Never',
  background: 'Only when Sail is in the background',
  always: 'Always',
};

export type NotificationPrefs = Record<NotificationType, NotificationPreference>;

export const notificationPrefsKey = 'sai-notification-prefs';
export const legacyNotificationsKey = 'sai-notifications-enabled';

function uniform(preference: NotificationPreference): NotificationPrefs {
  return { input: preference, completed: preference, ship: preference };
}

/** New profiles notify only while Sail is in the background. */
export const defaultNotificationPrefs: NotificationPrefs = uniform('background');

function isPreference(value: unknown): value is NotificationPreference {
  return (
    typeof value === 'string' && (notificationPreferences as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parsePrefs(raw: string): NotificationPrefs | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const prefs = { ...defaultNotificationPrefs };
    for (const type of notificationTypes) {
      const preference = value[type];
      if (isPreference(preference)) prefs[type] = preference;
    }
    return prefs;
  } catch {
    return null;
  }
}

export type NotificationPrefsLoad = {
  prefs: NotificationPrefs;
  /** True when the value came from the old on/off setting and must be saved. */
  migrated: boolean;
};

/**
 * Reads the per-type preferences. Without them, the old
 * `sai-notifications-enabled=false` becomes Never for every type; anything else
 * falls back to the default.
 */
export function loadNotificationPrefs(
  raw: string | null,
  legacyEnabled: string | null,
): NotificationPrefsLoad {
  const stored = raw === null ? null : parsePrefs(raw);
  if (stored) return { prefs: stored, migrated: false };
  if (legacyEnabled === 'false') return { prefs: uniform('never'), migrated: true };
  return { prefs: { ...defaultNotificationPrefs }, migrated: false };
}

export function notificationAllowed(
  preference: NotificationPreference,
  appInBackground: boolean,
): boolean {
  return preference === 'always' || (preference === 'background' && appInBackground);
}

export function attentionNotificationType(kind: AttentionKind): NotificationType {
  switch (kind) {
    case 'permission':
    case 'question':
    case 'ship-needs-input':
    case 'subagent-waiting':
      return 'input';
    default:
      return 'ship';
  }
}

export const notificationWindowMillis = 10_000;

export type AppNotification = {
  type: NotificationType;
  title: string;
  body: string;
  target: AttentionTarget;
};

export type SentNotification = {
  title: string;
  body: string;
  target: AttentionTarget;
  count: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type NotificationCoalescerOptions = {
  send: (notification: SentNotification) => void;
  /** Checked when the window closes, so a notification for a focused app is dropped. */
  allow: (notification: AppNotification) => boolean;
  windowMillis?: number;
  setTimer?: (callback: () => void, millis: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export type NotificationCoalescer = {
  enqueue: (notification: AppNotification) => void;
  flush: () => void;
  dispose: () => void;
};

/**
 * Sends at most one notification per window. The window opens with the first
 * notification and closes `windowMillis` later. Everything that arrived meanwhile
 * goes out as one notification with a count, targeting the first item.
 */
export function createNotificationCoalescer(
  options: NotificationCoalescerOptions,
): NotificationCoalescer {
  const windowMillis = options.windowMillis ?? notificationWindowMillis;
  const setTimer = options.setTimer ?? ((callback, millis) => setTimeout(callback, millis));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let pending: AppNotification[] = [];
  let timer: TimerHandle | null = null;

  function flush() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const batch = pending.filter(options.allow);
    pending = [];
    const first = batch[0];
    if (!first) return;
    if (batch.length === 1) {
      options.send({ title: first.title, body: first.body, target: first.target, count: 1 });
      return;
    }
    const titles = batch.slice(0, 3).map((item) => item.title);
    const more = batch.length - titles.length;
    options.send({
      title: `${batch.length} items need your attention`,
      body: `${titles.join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
      target: first.target,
      count: batch.length,
    });
  }

  return {
    enqueue(notification) {
      pending.push(notification);
      if (timer === null) timer = setTimer(flush, windowMillis);
    },
    flush,
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = [];
    },
  };
}

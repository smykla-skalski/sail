import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import {
  attentionNotificationType,
  createNotificationCoalescer,
  defaultNotificationPrefs,
  loadNotificationPrefs,
  notificationAllowed,
  notificationTypes,
  type AppNotification,
  type SentNotification,
} from '../src/lib/notification-prefs.ts';
import { attentionKinds } from '../src/lib/attention-items.ts';

void test('new profiles notify only while Sail is in the background', () => {
  const load = loadNotificationPrefs(null, null);
  assert.deepEqual(load, { prefs: defaultNotificationPrefs, migrated: false });
  for (const type of notificationTypes) assert.equal(load.prefs[type], 'background');
});

void test('sai-notifications-enabled=false becomes Never for every type', () => {
  const load = loadNotificationPrefs(null, 'false');
  assert.equal(load.migrated, true);
  for (const type of notificationTypes) assert.equal(load.prefs[type], 'never');
  assert.deepEqual(loadNotificationPrefs(null, 'true'), {
    prefs: defaultNotificationPrefs,
    migrated: false,
  });
});

void test('stored preferences win over the legacy flag and ignore bad values', () => {
  const stored = JSON.stringify({ input: 'always', completed: 'never', ship: 'sometimes' });
  assert.deepEqual(loadNotificationPrefs(stored, 'false'), {
    prefs: { input: 'always', completed: 'never', ship: 'background' },
    migrated: false,
  });
  assert.equal(loadNotificationPrefs('[]', 'false').migrated, true);
  assert.equal(loadNotificationPrefs('{broken', null).prefs.input, 'background');
});

void test('preferences decide by whether Sail is in the background', () => {
  assert.equal(notificationAllowed('never', true), false);
  assert.equal(notificationAllowed('background', true), true);
  assert.equal(notificationAllowed('background', false), false);
  assert.equal(notificationAllowed('always', false), true);
});

void test('every attention kind maps to a notification type', () => {
  for (const kind of attentionKinds)
    assert.ok(notificationTypes.includes(attentionNotificationType(kind)), kind);
  assert.equal(attentionNotificationType('ship-ready-to-merge'), 'ship');
  assert.equal(attentionNotificationType('permission'), 'input');
});

function notification(name: string): AppNotification {
  return {
    type: 'ship',
    title: name,
    body: `${name} body`,
    target: { type: 'ship-issue', runId: 'r', issueId: name, repository: '/repo' },
  };
}

function harness(allow: (item: AppNotification) => boolean = () => true) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const sent: SentNotification[] = [];
  const coalescer = createNotificationCoalescer({ send: (item) => sent.push(item), allow });
  return { sent, coalescer };
}

afterEach(() => mock.timers.reset());

void test('a burst within 10 s becomes one notification with a count', () => {
  const { sent, coalescer } = harness();
  for (const name of ['a', 'b', 'c', 'd', 'e']) coalescer.enqueue(notification(name));
  mock.timers.tick(9_999);
  assert.deepEqual(sent, []);
  mock.timers.tick(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].count, 5);
  assert.equal(sent[0].title, '5 items need your attention');
  assert.equal(sent[0].body, 'a, b, c and 2 more');
  assert.deepEqual(sent[0].target, notification('a').target);
  mock.timers.tick(60_000);
  assert.equal(sent.length, 1);
});

void test('a lone notification keeps its own text and the next burst opens a new window', () => {
  const { sent, coalescer } = harness();
  coalescer.enqueue(notification('a'));
  mock.timers.tick(10_000);
  assert.deepEqual(sent, [
    { title: 'a', body: 'a body', target: notification('a').target, count: 1 },
  ]);
  coalescer.enqueue(notification('b'));
  coalescer.enqueue(notification('c'));
  mock.timers.tick(10_000);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].count, 2);
});

void test('notifications that are no longer allowed when the window closes are dropped', () => {
  let focused = false;
  const { sent, coalescer } = harness(() => !focused);
  coalescer.enqueue(notification('a'));
  focused = true;
  mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});

void test('disposing the coalescer discards pending notifications', () => {
  const { sent, coalescer } = harness();
  coalescer.enqueue(notification('a'));
  coalescer.dispose();
  mock.timers.tick(10_000);
  coalescer.flush();
  assert.deepEqual(sent, []);
});

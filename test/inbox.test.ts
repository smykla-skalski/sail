import assert from 'node:assert/strict';
import test from 'node:test';
import {
  failedCheckOutcome,
  inboxPermissionDecisionTitle,
  inboxPermissionProfile,
  inboxLocations,
  inboxTurnMessageIndex,
  loadInboxOutcomes,
  loadInboxSeen,
  markInboxOutcomeRead,
  maxInboxSeen,
  maxInboxOutcomes,
  openCodeRequestTime,
  recordInboxOutcome,
  sortInbox,
  type InboxItem,
  type InboxOutcome,
} from '../src/lib/inbox.ts';

const item = (key: string, receivedAt: number): InboxItem => ({
  key,
  receivedAt,
  kind: 'question',
  agent: 'OpenCode',
  directory: '/projects/alpha',
  project: 'alpha',
  worktree: null,
  sessionId: 'session',
  requestId: key,
  text: key,
});

const id = (prefix: string, timestamp: number) =>
  `${prefix}_${((BigInt(timestamp) * 4096n) % (1n << 48n)).toString(16).padStart(12, '0')}${'a'.repeat(14)}`;

void test('inbox covers repositories and worktrees with their parent project', () => {
  assert.deepEqual(
    inboxLocations({
      repositories: ['/projects/alpha', '/projects/beta', 'C:\\projects\\gamma'],
      groups: [],
      worktrees: { '/projects/alpha': [{ path: '/worktrees/feature', branch: 'feature' }] },
    }),
    [
      { directory: '/projects/alpha', project: 'alpha', worktree: null },
      { directory: '/worktrees/feature', project: 'alpha', worktree: 'feature' },
      { directory: '/projects/beta', project: 'beta', worktree: null },
      { directory: 'C:\\projects\\gamma', project: 'gamma', worktree: null },
    ],
  );
});

void test('inbox orders requests by arrival then stable key', () => {
  assert.deepEqual(
    sortInbox([item('later', 20), item('b', 10), item('a', 10)]).map((entry) => entry.key),
    ['a', 'b', 'later'],
  );
  assert.deepEqual(loadInboxSeen('{"a":10,"b":"bad"}'), { a: 10 });
  assert.deepEqual(loadInboxSeen('{broken'), {});
  assert.deepEqual(
    loadInboxSeen(JSON.stringify({ [`opencode:permission:${id('per', 123)}`]: 123, custom: 456 })),
    { custom: 456 },
  );
  assert.equal(
    Object.keys(
      loadInboxSeen(
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`custom:${i}`, i])),
        ),
      ),
    ).length,
    maxInboxSeen,
  );
});

void test('OpenCode request IDs preserve creation order across projects and timestamp wrap', () => {
  const cycle = 2 ** 36;
  const beforeWrap = cycle - 100;
  const afterWrap = cycle + 100;
  assert.equal(openCodeRequestTime(id('per', beforeWrap), afterWrap + 50), beforeWrap);
  assert.equal(openCodeRequestTime(id('frm', afterWrap), afterWrap + 50), afterWrap);
  assert.deepEqual(
    sortInbox([
      item('new project', openCodeRequestTime(id('frm', afterWrap), afterWrap + 50)!),
      item('old project', openCodeRequestTime(id('per', beforeWrap), afterWrap + 50)!),
    ]).map((entry) => entry.key),
    ['old project', 'new project'],
  );
  assert.equal(openCodeRequestTime('custom-id', afterWrap + 50), null);
});

void test('recent outcomes deduplicate provider events and preserve read state', () => {
  const outcome: InboxOutcome = {
    key: 'turn:one',
    kind: 'turn-completed',
    directory: '/projects/alpha',
    agentId: 'opencode',
    sessionId: 'session',
    text: 'Completed',
    receivedAt: 123,
    eventId: 'evt_1',
    read: false,
  };
  const recorded = recordInboxOutcome([], outcome);
  assert.equal(recordInboxOutcome(recorded, { ...outcome, receivedAt: 456 }), recorded);
  const read = markInboxOutcomeRead(recorded, outcome.key);
  assert.deepEqual(loadInboxOutcomes(JSON.stringify(read)), [{ ...outcome, read: true }]);
  assert.deepEqual(loadInboxOutcomes('{broken'), []);
  assert.deepEqual(loadInboxOutcomes(JSON.stringify([{ ...outcome, kind: 'permission' }])), []);
  assert.equal(
    recordInboxOutcome(
      Array.from({ length: maxInboxOutcomes }, (_, index) => ({ ...outcome, key: String(index) })),
      outcome,
    ).length,
    maxInboxOutcomes,
  );
});

void test('failed check results stay informational and point at their thread', () => {
  const check = {
    id: 'check-1',
    directory: '/projects/alpha',
    thread: 'acp:codex:session:with-colon',
    command: 'npm test',
    status: 'failed',
    updated: 456,
  };
  assert.deepEqual(failedCheckOutcome(check), {
    key: 'check:check-1',
    kind: 'check-failed',
    directory: '/projects/alpha',
    agentId: 'codex',
    sessionId: 'session:with-colon',
    text: 'npm test',
    receivedAt: 456,
    eventId: 'check-1',
    read: false,
  });
  assert.equal(failedCheckOutcome({ ...check, status: 'passed' }), null);
  assert.equal(failedCheckOutcome({ ...check, thread: 'broken' }), null);
});

void test('permission settlements retain the session profile stored by the inbox', () => {
  const permission: InboxItem = {
    ...item('permission', 123),
    kind: 'opencode-permission',
    policy: {
      profile: 'explore',
      risk: 'low',
      recommendation: 'allow',
      optionId: 'once',
      reason: 'Low-risk action is enabled for exploration.',
      policyRevision: '2026-10-07.1',
    },
  };

  assert.equal(inboxPermissionProfile(permission, 'build'), 'explore');
});

void test('rejected inbox permissions record the actual outcome', () => {
  const permission: InboxItem = {
    ...item('permission-rejected', 123),
    kind: 'acp-permission',
    permissionTitle: 'Read README.md',
    text: 'explore · low risk · policy 2026-10-07.1 — Allowed by policy',
    policy: {
      profile: 'explore',
      risk: 'low',
      recommendation: 'allow',
      optionId: 'once',
      reason: 'low-risk action is enabled for the explore profile.',
      policyRevision: '2026-10-07.1',
    },
  };

  assert.match(inboxPermissionDecisionTitle(permission, 'rejected'), /— Rejected:/);
  assert.doesNotMatch(inboxPermissionDecisionTitle(permission, 'rejected'), /Allowed by policy/);
});

void test('allowed inbox permissions record the actual outcome', () => {
  const permission: InboxItem = {
    ...item('permission-allowed', 123),
    kind: 'opencode-permission',
    permissionTitle: 'Inspect repository',
    text: 'review · unknown risk · policy 2026-10-07.1 — Awaiting approval',
    policy: {
      profile: 'review',
      risk: 'unknown',
      recommendation: 'interactive',
      reason: 'The action does not match a reviewed policy rule.',
      policyRevision: '2026-10-07.1',
    },
  };

  assert.match(inboxPermissionDecisionTitle(permission, 'completed'), /— Allowed:/);
  assert.doesNotMatch(inboxPermissionDecisionTitle(permission, 'completed'), /Awaiting approval/);
});

void test('completed turn navigation stays between its user message and the next turn', () => {
  const messages = [
    { kind: 'user' as const, created: 100 },
    { kind: 'assistant' as const, created: 110 },
    { kind: 'assistant' as const, created: 120 },
    { kind: 'user' as const, created: 1000 },
    { kind: 'assistant' as const, created: 1001 },
  ];
  assert.equal(inboxTurnMessageIndex(messages, 999), 2);
  assert.equal(inboxTurnMessageIndex(messages, 1002), 4);
  assert.equal(inboxTurnMessageIndex([{ kind: 'user', created: 100 }], 101), 0);
});

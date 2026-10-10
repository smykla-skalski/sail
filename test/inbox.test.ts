import assert from 'node:assert/strict';
import test from 'node:test';
import {
  failedCheckOutcome,
  inboxPermissionDecisionTitle,
  inboxLocations,
  persistedInboxKinds,
  repositoryName,
  inboxTurnMessageIndex,
  loadInboxOutcomes,
  markInboxOutcomeRead,
  maxInboxOutcomes,
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
  agentId: 'opencode',
  directory: '/projects/alpha',
  project: 'alpha',
  worktree: null,
  sessionId: 'session',
  requestId: key,
  text: key,
});

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
    kind: 'acp-permission',
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

const outcome = (kind: string) => ({
  key: kind,
  kind,
  directory: '/d',
  agentId: 'claude',
  sessionId: 's',
  text: 't',
  receivedAt: 1,
  read: false,
});

void test('only finished work is persisted, never requests or attention items', () => {
  assert.deepEqual(persistedInboxKinds, ['turn-completed', 'check-failed']);
  const kinds = [
    'turn-completed',
    'check-failed',
    'acp-permission',
    'question',
    'ship-needs-input',
    'ship-ready-to-merge',
    'subagent-waiting',
  ];
  assert.deepEqual(
    loadInboxOutcomes(JSON.stringify(kinds.map(outcome))).map((entry) => entry.kind),
    ['turn-completed', 'check-failed'],
  );
});

void test('repositories are named by their last path part on every platform', () => {
  assert.equal(repositoryName('/projects/alpha/'), 'alpha');
  assert.equal(repositoryName('C:\\projects\\gamma'), 'gamma');
  assert.equal(repositoryName('alpha'), 'alpha');
});

void test('inbox orders requests by arrival then stable key', () => {
  assert.deepEqual(
    sortInbox([item('later', 20), item('b', 10), item('a', 10)]).map((entry) => entry.key),
    ['a', 'b', 'later'],
  );
});

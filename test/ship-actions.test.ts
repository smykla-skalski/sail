import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shipArchiveAction,
  shipArchiveConfirmation,
  shipCheckpointCommit,
  shipMergeAction,
  shipMergeConfirmation,
  shipMergeRetryDelay,
  shipMergeRetryReason,
  shipPoolLabel,
  shipPoolUsage,
  shipReopenAction,
  shipReopenConfirmation,
  shipReplacementConfirmation,
  shipReopenHeadWarning,
  shipRetryAction,
  shipStopAction,
  shipStopConfirmation,
} from '../src/lib/ship-actions.ts';
import { terminalClaimReleaseReason, type ShipIssue } from '../src/lib/issue-shipping.ts';
import { fixture, withMergeEvidence } from './ship-fixtures.ts';

function mergeable(): ShipIssue {
  const issue: ShipIssue = Object.assign(
    fixture().issues[0],
    withMergeEvidence(fixture().issues[0]),
  );
  issue.checkpoint!.revision = 'revision-one';
  issue.evidenceCommit = 'revision-one';
  Object.assign(issue, {
    state: 'awaiting_merge',
    pullRequest: 'https://github.com/a/b/pull/9',
    pullRequestState: 'OPEN',
    pullRequestHead: 'revision-one',
    pullRequestMergeable: true,
    checks: [],
  });
  return issue;
}

void test('merge is available only for a ready pull request at the checkpoint revision', () => {
  assert.deepEqual(shipMergeAction(mergeable()), { enabled: true, reason: null });
  const moved = mergeable();
  moved.pullRequestHead = 'someone-pushed';
  assert.match(shipMergeAction(moved).reason!, /does not match the pull request head/);
  moved.evidenceCommit = 'someone-pushed';
  assert.match(shipMergeAction(moved).reason!, /differs from the checkpoint revision/);
  const noEvidence = mergeable();
  noEvidence.evidenceManifests = [];
  assert.equal(shipMergeAction(noEvidence).enabled, false);
  const conflicted = mergeable();
  conflicted.pullRequestMergeable = false;
  assert.match(shipMergeAction(conflicted).reason!, /not mergeable/);
  const failing = mergeable();
  failing.checks = [{ name: 'test', state: 'FAILURE', url: 'https://example.test' }];
  assert.match(shipMergeAction(failing).reason!, /CI evidence missing/);
  const closed = mergeable();
  closed.pullRequestState = 'CLOSED';
  assert.match(shipMergeAction(closed).reason!, /not open/);
});

void test('a recent merge request blocks a duplicate comment', () => {
  const requested = mergeable();
  const now = Date.now();
  requested.mergeRequested = { at: now, head: 'revision-one', comment: 'squash' };
  const state = shipMergeAction(requested, now);
  assert.equal(state.enabled, false);
  assert.match(state.reason!, /Merge already requested with “squash”/);
  requested.pullRequestState = 'MERGED';
  assert.match(shipMergeAction(requested).reason!, /not open/);
});

void test('a stale merge request can be confirmed again at the threshold', () => {
  const requested = mergeable();
  const now = Date.now();
  requested.mergeRequested = {
    at: now - shipMergeRetryDelay + 1,
    head: 'revision-one',
    comment: 'squash',
  };
  assert.equal(shipMergeAction(requested, now).enabled, false);
  requested.mergeRequested.at -= 1;
  assert.deepEqual(shipMergeAction(requested, now), { enabled: true, reason: null });
  const confirmation = shipMergeConfirmation(requested, 'a/b');
  assert.match(confirmation.title, /Request merge again/);
  assert.match(confirmation.message, /post a bot comment or merge the pull request directly/);
  assert.equal(confirmation.confirmLabel, 'Request again');
  requested.checks = [{ name: 'test', state: 'FAILURE', url: 'https://example.test' }];
  assert.equal(shipMergeAction(requested, now).enabled, false);
});

void test('a new reviewed head allows a fresh merge request', () => {
  const requested = mergeable();
  requested.mergeRequested = { at: Date.now(), head: 'previous-head', comment: 'squash' };
  assert.match(shipMergeRetryReason(requested)!, /head changed/);
  assert.equal(shipMergeAction(requested).enabled, true);
  requested.pullRequestHead = 'unreviewed-head';
  assert.equal(shipMergeAction(requested).enabled, false);
});

void test('retry applies to failed issues whose pull request is still usable', () => {
  const run = fixture();
  const issue = run.issues[0];
  assert.equal(shipRetryAction(issue).enabled, false);
  issue.state = 'failed';
  issue.error = 'Worker failed.';
  assert.equal(shipRetryAction(issue).enabled, true);
  issue.error = 'Pull request closed without merging.';
  assert.match(shipRetryAction(issue).reason!, /closed without merging/);
  issue.error = 'Issue closed before its worker launched.';
  assert.match(shipRetryAction(issue).reason!, /closed before launch/);
});

void test('reopen applies only to a stopped issue whose pull request closed unmerged', () => {
  const issue = mergeable();
  assert.match(shipReopenAction(issue).reason!, /closed without merging/);
  issue.pullRequestState = 'CLOSED';
  assert.match(shipReopenAction(issue).reason!, /worker to stop/);
  Object.assign(issue, { state: 'failed', error: 'Pull request closed without merging.' });
  assert.deepEqual(shipReopenAction(issue), { enabled: true, reason: null });
  issue.claim = {
    id: 'c',
    holder: 'h',
    task: 't',
    acquiredAt: 'a',
    heartbeatAt: 'a',
    expiresAt: 'a',
    status: 'active',
    commentId: 1,
  };
  issue.claimFencePending = true;
  assert.match(shipReopenAction(issue).reason!, /claim to settle/);
  issue.claimFencePending = false;
  issue.pullRequest = null;
  assert.match(shipReopenAction(issue).reason!, /No pull request/);
  issue.state = 'merged';
  issue.pullRequest = 'https://github.com/a/b/pull/9';
  assert.equal(shipReopenAction(issue).enabled, false);
});

void test('the reopen confirmation names the pull request, issue and repository', () => {
  const issue = mergeable();
  const confirmation = shipReopenConfirmation(issue, 'a/b');
  assert.match(confirmation.title, /^Reopen pull request #9 for #\d+/);
  assert.match(confirmation.message, /pull request #9 in a\/b/);
  assert.equal(confirmation.confirmLabel, 'Reopen');
});

void test('a replacement confirmation names the closed and new pull requests', () => {
  const issue = mergeable();
  const confirmation = shipReplacementConfirmation(issue, 'a/b');
  assert.match(confirmation.title, /replacement for pull request #9/);
  assert.match(confirmation.message, /replacement pull request for #\d+/);
  assert.match(confirmation.message, /saved checkpoint/);
  assert.equal(confirmation.confirmLabel, 'Start replacement');
});

void test('reopen warns when the live head differs from the saved checkpoint', () => {
  const checkpoint = '0123456789abcdef0123456789abcdef01234567';
  const moved = 'fedcba9876543210fedcba9876543210fedcba98';
  assert.equal(shipReopenHeadWarning(checkpoint, checkpoint), '');
  assert.match(shipReopenHeadWarning(moved, checkpoint), /differs from checkpoint commit/);
  assert.match(shipReopenHeadWarning(moved, checkpoint), /fedcba98/);
  assert.match(shipReopenHeadWarning(moved, checkpoint), /01234567/);
  assert.match(shipReopenHeadWarning(moved, null), /no Git commit to compare/);
});

void test('legacy checkpoints recover only a commit recorded for their exact digest', () => {
  const issue = mergeable();
  issue.checkpoint!.revision = '0123456789abcdef';
  issue.checkpoint!.commit = null;
  issue.evidenceRevision = '0123456789abcdef';
  issue.evidenceCommit = 'a'.repeat(40);
  assert.equal(shipCheckpointCommit(issue), issue.evidenceCommit);
  issue.evidenceRevision = 'fedcba9876543210';
  assert.equal(shipCheckpointCommit(issue), null);
  issue.checkpoint!.commit = 'b'.repeat(40);
  assert.equal(shipCheckpointCommit(issue), 'b'.repeat(40));
});

void test('stop needs live work and archive needs a stopped run', () => {
  const run = fixture();
  assert.equal(shipStopAction(run).enabled, true);
  assert.match(shipArchiveAction(run).reason!, /Stop the run/);
  for (const issue of run.issues) issue.state = 'failed';
  assert.equal(shipStopAction(run).enabled, false);
  assert.equal(shipArchiveAction(run).enabled, true);
  run.issues[0].claim = {
    id: 'c',
    holder: 'h',
    task: 't',
    acquiredAt: 'a',
    heartbeatAt: 'a',
    expiresAt: 'a',
    status: 'active',
    commentId: 1,
  };
  assert.match(shipArchiveAction(run).reason!, /claim/);
  run.archivedAt = 1;
  assert.match(shipArchiveAction(run).reason!, /Already archived/);
  assert.match(shipStopAction(run).reason!, /archived/);
});

void test('a stopped issue releases its claim as cancelled', () => {
  const issue = fixture().issues[0];
  issue.state = 'failed';
  assert.equal(terminalClaimReleaseReason(issue), 'failed');
  issue.cancelledAt = 5;
  assert.equal(terminalClaimReleaseReason(issue), 'cancelled');
  issue.state = 'merged';
  issue.cancelledAt = undefined;
  assert.equal(terminalClaimReleaseReason(issue), 'merged');
});

void test('every confirmation names its target and stop is destructive', () => {
  const run = fixture();
  const issue = run.issues[0];
  assert.match(shipMergeConfirmation(issue, 'a/b').title, /#2 First/);
  assert.match(shipMergeConfirmation(issue, 'a/b').message, /a\/b/);
  const stop = shipStopConfirmation(run);
  assert.match(stop.title, /Umbrella/);
  assert.match(stop.message, /2 unfinished issues/);
  assert.equal(stop.destructive, true);
  assert.match(shipArchiveConfirmation(run).message, /Unarchive/);
});

void test('worker pool usage sums live workers against run limits and counts gates', () => {
  const run = fixture();
  run.limit = 4;
  run.issues[0].state = 'working';
  run.issues[0].gates = [
    {
      id: 'g',
      gate: 'code-adversary',
      requestedModel: 'm',
      provider: 'p',
      model: 'm',
      threadId: null,
      directory: null,
      state: 'working',
      created: 1,
      updated: 1,
      error: null,
    },
  ];
  const other = fixture();
  other.id = 'other';
  other.limit = 2;
  other.issues[0].state = 'starting';
  const archived = fixture();
  archived.archivedAt = 1;
  archived.issues[0].state = 'working';
  const usage = shipPoolUsage([run, other, archived]);
  assert.deepEqual(usage, { workers: 2, limit: 6, gates: 1, runs: 2 });
  assert.equal(shipPoolLabel(usage), '2 of 6 workers · 1 gate running');
  assert.equal(shipPoolLabel(shipPoolUsage([])), 'No workers running');
});

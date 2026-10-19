import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentQueuePauseReason,
  queuedTurnDisposition,
  setAgentQueuePaused,
} from '../src/lib/agent-queue.ts';

void test('a completed prompt stays delivered after local bookkeeping fails', () => {
  assert.equal(queuedTurnDisposition('done', null), 'completed');
  assert.equal(queuedTurnDisposition(null, 'done'), 'completed');
});

void test('a dispatched prompt is never placed back in the automatic retry queue', () => {
  assert.equal(queuedTurnDisposition('failed', 'failed'), 'sent');
  assert.equal(queuedTurnDisposition(null, 'dispatched'), 'sent');
  assert.equal(queuedTurnDisposition('interrupted', null), 'sent');
  assert.equal(queuedTurnDisposition(null, 'dispatch_uncertain'), 'uncertain');
});

void test('only a prompt with no dispatch evidence can be retried automatically', () => {
  assert.equal(queuedTurnDisposition(null, 'prepared'), 'unsent');
  assert.equal(queuedTurnDisposition(null, null), 'unsent');
});

void test('a paused queue keeps its reason per session until it resumes', () => {
  setAgentQueuePaused('codex', '/repo', 'one', 'Private Git state requires recovery.');
  assert.equal(
    agentQueuePauseReason('codex', '/repo', 'one'),
    'Private Git state requires recovery.',
  );
  assert.equal(agentQueuePauseReason('codex', '/repo', 'two'), null);
  setAgentQueuePaused('codex', '/repo', 'one', null);
  assert.equal(agentQueuePauseReason('codex', '/repo', 'one'), null);
});

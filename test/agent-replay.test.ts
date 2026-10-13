import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentReplay, updateReplayingAgentSessions } from '../src/lib/agent-replay.ts';

void test('switching sessions during replay clears the original session count', () => {
  const replay = new AgentReplay();
  let counts: Record<string, number> = {};
  const change = (replaying: boolean, activeSessionId: string) => {
    const sessionId = replay.set(replaying, activeSessionId);
    if (sessionId)
      counts = updateReplayingAgentSessions(counts, 'claude', '/worktree', sessionId, replaying);
  };

  change(true, 'thread-a');
  assert.deepEqual(counts, { '["claude","/worktree","thread-a"]': 1 });
  change(false, 'thread-b');
  assert.deepEqual(counts, {});
  assert.equal(replay.active, false);

  change(true, 'thread-b');
  change(false, 'thread-b');
  change(true, 'thread-a');
  change(false, 'thread-a');
  change(false, 'thread-a');
  assert.deepEqual(counts, {});
});

void test('a replay stop preserves another workspace replaying the same session', () => {
  let counts: Record<string, number> = {};
  counts = updateReplayingAgentSessions(counts, 'claude', '/worktree', 'thread-a', true);
  counts = updateReplayingAgentSessions(counts, 'claude', '/worktree', 'thread-a', true);
  counts = updateReplayingAgentSessions(counts, 'claude', '/worktree', 'thread-a', false);
  assert.deepEqual(counts, { '["claude","/worktree","thread-a"]': 1 });
  counts = updateReplayingAgentSessions(counts, 'claude', '/worktree', 'thread-a', false);
  assert.deepEqual(counts, {});
});

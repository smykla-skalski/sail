import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionMessageInfo } from '@opencode/client';
import {
  cachedOpenCodeTimelines,
  clearOpenCodeTimelineCache,
  recallOpenCodeTimeline,
  rememberOpenCodeTimeline,
} from '../src/lib/opencode-timeline-cache.ts';

const message = (id: string): SessionMessageInfo => ({
  id,
  time: { created: 1 },
  type: 'user',
  text: id,
});

await test('recalls an OpenCode conversation without sharing mutable arrays', () => {
  clearOpenCodeTimelineCache();
  const messages = [message('one')];
  rememberOpenCodeTimeline('/repo', 'session', { messages, cursor: 'older' });
  messages.push(message('two'));

  const recalled = recallOpenCodeTimeline('/repo', 'session');
  assert.deepEqual(recalled, { messages: [message('one')], cursor: 'older' });
  recalled?.messages.push(message('three'));
  assert.equal(recallOpenCodeTimeline('/repo', 'session')?.messages.length, 1);
});

await test('bounds cached conversations and retains recently recalled sessions', () => {
  clearOpenCodeTimelineCache();
  for (let index = 0; index < 8; index += 1)
    rememberOpenCodeTimeline('/repo', `session-${index}`, {
      messages: [message(String(index))],
      cursor: null,
    });
  recallOpenCodeTimeline('/repo', 'session-0');
  rememberOpenCodeTimeline('/repo', 'session-8', { messages: [], cursor: null });

  assert.equal(recallOpenCodeTimeline('/repo', 'session-1'), null);
  assert.equal(recallOpenCodeTimeline('/repo', 'session-0')?.messages[0]?.id, '0');
});

await test('lists cached conversations with source identity for activity history', () => {
  clearOpenCodeTimelineCache();
  rememberOpenCodeTimeline('/repo/a', 'session-a', {
    messages: [message('one')],
    cursor: 'older',
  });

  assert.deepEqual(cachedOpenCodeTimelines(), [
    {
      directory: '/repo/a',
      sessionID: 'session-a',
      messages: [message('one')],
      cursor: 'older',
    },
  ]);
});

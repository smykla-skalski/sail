import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAttention,
  markAttentionRead,
  openCodeExecutionStatus,
  preserveAttentionOnCheckOpen,
  reconcileAttention,
  updateAttention,
  type AttentionMap,
} from '../src/lib/attention.ts';

void test('OpenCode execution events keep interrupted distinct from completed', () => {
  assert.equal(openCodeExecutionStatus('session.execution.started'), 'working');
  assert.equal(openCodeExecutionStatus('session.execution.succeeded'), 'done');
  assert.equal(openCodeExecutionStatus('session.execution.failed'), 'failed');
  assert.equal(openCodeExecutionStatus('session.execution.interrupted'), 'interrupted');
});

void test('background input and completion become unread once', () => {
  let state: AttentionMap = {};
  let result = updateAttention(state, 'thread', 'working', false);
  assert.equal(result.notify, false);
  state = result.next;

  result = updateAttention(state, 'thread', 'waiting', false);
  assert.equal(result.notify, true);
  assert.equal(result.next.thread?.unread, true);
  state = result.next;

  result = updateAttention(state, 'thread', 'waiting', false);
  assert.equal(result.notify, false);
  assert.equal(result.next.thread?.unread, true);
  state = result.next;

  result = updateAttention(state, 'thread', 'done', false);
  assert.equal(result.notify, true);
  assert.equal(result.next.thread?.unread, true);
  result = updateAttention(result.next, 'thread', 'done', false);
  assert.equal(result.notify, false);
  assert.equal(result.next.thread?.unread, true);
  assert.equal(markAttentionRead(result.next, 'thread').thread?.unread, false);
});

void test('visible, failed, and cancelled turns do not become unread', () => {
  const waiting = updateAttention({}, 'thread', 'waiting', true);
  assert.equal(waiting.notify, false);
  assert.equal(waiting.next.thread?.unread, false);

  const failed = updateAttention(waiting.next, 'thread', 'failed', false);
  assert.equal(failed.notify, false);
  assert.equal(failed.next.thread?.unread, false);

  const cancelled = updateAttention({}, 'thread', 'interrupted', false, false);
  assert.equal(cancelled.notify, false);
  assert.equal(cancelled.next.thread?.unread, false);
  assert.deepEqual(loadAttention(JSON.stringify(cancelled.next)), cancelled.next);
});

void test('saved activity survives reload until backend reconciliation', () => {
  const saved: AttentionMap = {
    working: { status: 'working', unread: false },
    waiting: { status: 'waiting', unread: true },
    done: { status: 'done', unread: true },
  };
  assert.deepEqual(loadAttention(JSON.stringify(saved)), {
    working: { status: 'working', unread: false },
    waiting: { status: 'waiting', unread: true },
    done: { status: 'done', unread: true },
  });
  assert.deepEqual(
    reconcileAttention(
      saved,
      [
        { agent: 'codex', sessionId: 'w', key: 'working', viewed: false },
        { agent: 'codex', sessionId: 'p', key: 'waiting', viewed: false },
      ],
      { codex: { alive: true, active: ['w', 'p'], waiting: ['p'], finished: {} } },
    ),
    saved,
  );
  assert.deepEqual(
    reconcileAttention(
      saved,
      [{ agent: 'codex', sessionId: 'p', key: 'waiting', viewed: false }],
      {},
    ).waiting,
    { status: 'failed', unread: false },
  );
  assert.deepEqual(
    reconcileAttention(saved, [{ agent: 'codex', sessionId: 'd', key: 'done', viewed: false }], {
      codex: { alive: true, active: ['d'], waiting: [], finished: {} },
    }).done,
    { status: 'working', unread: false },
  );
  assert.deepEqual(
    reconcileAttention(saved, [{ agent: 'codex', sessionId: 'w', key: 'working', viewed: false }], {
      codex: {
        alive: true,
        active: [],
        waiting: [],
        finished: { w: { status: 'failed', notify: true } },
      },
    }).working,
    { status: 'failed', unread: false },
  );
  for (const notify of [true, false]) {
    assert.deepEqual(
      reconcileAttention(
        saved,
        [{ agent: 'codex', sessionId: 'w', key: 'working', viewed: false }],
        {
          codex: {
            alive: true,
            active: [],
            waiting: [],
            finished: { w: { status: 'done', notify } },
          },
        },
      ).working,
      { status: 'done', unread: notify },
    );
  }
  assert.deepEqual(
    reconcileAttention(saved, [{ agent: 'codex', sessionId: 'w', key: 'working', viewed: false }], {
      codex: {
        alive: true,
        active: [],
        waiting: [],
        finished: { w: { status: 'interrupted', notify: false } },
      },
    }).working,
    { status: 'interrupted', unread: false },
  );
  assert.deepEqual(loadAttention('{broken'), {});
});

void test('unsaved waiting activity becomes unread without aborting reconciliation', () => {
  const next = reconcileAttention(
    {},
    [
      { agent: 'codex', sessionId: 'a', key: 'waiting', viewed: false },
      { agent: 'codex', sessionId: 'b', key: 'working', viewed: false },
    ],
    { codex: { alive: true, active: ['a', 'b'], waiting: ['a'], finished: {} } },
  );
  assert.deepEqual(next.waiting, { status: 'waiting', unread: true });
  assert.deepEqual(next.working, { status: 'working', unread: false });
});

void test('opening a failed check keeps prior unread attention without hiding a new status', () => {
  const before: AttentionMap = { target: { status: 'waiting', unread: true } };
  const navigated = markAttentionRead(before, 'target');
  assert.deepEqual(preserveAttentionOnCheckOpen(navigated, before, 'target'), before);
  const changed: AttentionMap = { target: { status: 'done', unread: false } };
  assert.equal(preserveAttentionOnCheckOpen(changed, before, 'target'), changed);
});

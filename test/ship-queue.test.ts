import assert from 'node:assert/strict';
import test from 'node:test';
import { shipQueueHiddenDone, shipQueueRows, shipQueueRuns } from '../src/lib/ship-queue.ts';
import { fixture } from './ship-fixtures.ts';

function runs() {
  const first = fixture();
  first.id = 'first';
  first.approvedAt = 10;
  first.issues[0].state = 'merged';
  first.issues[1].state = 'failed';
  first.issues[1].error = 'Worker failed.';
  const second = fixture();
  second.id = 'second';
  second.approvedAt = 20;
  second.repository = '/other';
  second.issues[0].state = 'working';
  second.issues[1].state = 'pending';
  const old = fixture();
  old.id = 'old';
  old.approvedAt = 5;
  old.archivedAt = 6;
  old.issues.forEach((issue) => (issue.state = 'merged'));
  return [first, second, old];
}

const options = { mergeOwner: 'you' as const };

void test('the queue lists issues from every active run with needs-input first and merged hidden', () => {
  const active = shipQueueRuns(runs(), { repository: null, archived: false });
  assert.deepEqual(
    active.map((run) => run.id),
    ['second', 'first'],
  );
  const rows = shipQueueRows(active, { runId: null, showDone: false, archived: false }, options);
  assert.deepEqual(
    rows.map((row) => `${row.run.id}:${row.issue.number}:${row.group}`),
    ['first:3:needs-input', 'second:2:active', 'second:3:waiting'],
  );
  assert.equal(shipQueueHiddenDone(active, options), 1);
  const all = shipQueueRows(active, { runId: null, showDone: true, archived: false }, options);
  assert.equal(all.length, 4);
  assert.equal(all.at(-1)?.group, 'done');
});

void test('a run filter narrows the queue and the Archived view lists only archived runs', () => {
  const active = shipQueueRuns(runs(), { repository: null, archived: false });
  const only = shipQueueRows(
    active,
    { runId: 'second', showDone: false, archived: false },
    options,
  );
  assert.deepEqual(
    only.map((row) => row.run.id),
    ['second', 'second'],
  );
  const archived = shipQueueRuns(runs(), { repository: null, archived: true });
  assert.deepEqual(
    archived.map((run) => run.id),
    ['old'],
  );
  const rows = shipQueueRows(archived, { runId: null, showDone: false, archived: true }, options);
  assert.equal(rows.length, 2);
  const scoped = shipQueueRuns(runs(), { repository: '/other', archived: false });
  assert.deepEqual(
    scoped.map((run) => run.id),
    ['second'],
  );
});

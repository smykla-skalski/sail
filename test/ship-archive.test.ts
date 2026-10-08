import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShipIssue, ShipRun } from '../src/lib/issue-shipping.ts';
import {
  autoArchiveShipRuns,
  migrateShipArchive,
  parseShipArchiveDelay,
  shipArchiveNoticeText,
  shipRunArchivable,
  shipRunFinishedAt,
  unarchiveShipRun,
} from '../src/lib/ship-archive.ts';
import { loadShipRuns } from '../src/lib/ship-progress.ts';
import { initialTaskCheckpoint, updateTaskCheckpoint } from '../src/lib/task-checkpoint.ts';
import { fixture } from './ship-fixtures.ts';

const day = 24 * 60 * 60 * 1000;
const merged = 1_000_000;

function finished(id: string, at = merged, patch: Partial<ShipIssue> = {}): ShipRun {
  const run = fixture();
  run.id = id;
  run.approvedAt = 1;
  for (const issue of run.issues) {
    Object.assign(issue, {
      state: 'merged',
      events: [{ at, stage: 'merged' }],
      claim: {
        id: 'claim',
        holder: 'Sail',
        task: 'ship',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:02:00.000Z',
        status: 'released',
        releasedAt: new Date(at).toISOString(),
        commentId: 1,
      },
      checkpoint: updateTaskCheckpoint(
        initialTaskCheckpoint({ id: issue.id, url: issue.url, title: issue.title }, 1),
        { phase: 'complete', status: 'completed' },
        at,
      ),
      ...patch,
    });
  }
  return run;
}

void test('a run archives one day after every issue is merged and released', () => {
  const run = finished('done');
  assert.equal(shipRunFinishedAt(run), merged);
  assert.equal(autoArchiveShipRuns([run], '1d', merged + day - 1).archived, 0);
  const { runs, archived } = autoArchiveShipRuns([run], '1d', merged + day);
  assert.equal(archived, 1);
  assert.equal(runs[0].archivedAt, merged + day);
  assert.equal(runs[0].archivedBy, 'auto');
  assert.equal(autoArchiveShipRuns([run], '7d', merged + 6 * day).archived, 0);
  assert.equal(autoArchiveShipRuns([run], '7d', merged + 7 * day).archived, 1);
  assert.equal(autoArchiveShipRuns([run], 'immediately', merged).archived, 1);
  assert.equal(autoArchiveShipRuns([run], 'off', merged + 365 * day).archived, 0);
});

void test('nothing archives while work, a claim or a checkpoint is still open', () => {
  const open = finished('open');
  open.issues[1].state = 'working';
  const claimed = finished('claimed');
  claimed.issues[0].claim!.status = 'active';
  const checkpoint = finished('checkpoint');
  checkpoint.issues[0].checkpoint = initialTaskCheckpoint(
    { id: 'x', url: checkpoint.issues[0].url, title: 'x' },
    1,
  );
  const empty = finished('empty');
  empty.issues = [];
  for (const run of [open, claimed, checkpoint, empty]) {
    assert.equal(shipRunArchivable(run), false, run.id);
    assert.equal(autoArchiveShipRuns([run], 'immediately', merged + 30 * day).archived, 0, run.id);
  }
});

void test('closed issues count as finished and a missing checkpoint holds nothing to keep', () => {
  const run = finished('closed');
  run.issues[0].state = 'failed';
  run.issues[0].error = 'Issue closed before its worker launched.';
  run.issues[1].issueState = 'CLOSED';
  run.issues[1].state = 'failed';
  for (const issue of run.issues) delete issue.checkpoint;
  assert.equal(shipRunArchivable(run), true);
});

void test('the upgrade pass archives qualifying runs, deletes nothing and counts them', () => {
  const old = finished('old', merged);
  const recent = finished('recent', merged + 3 * day);
  const running = finished('running', merged);
  running.issues[0].state = 'working';
  const before = JSON.stringify([old, recent, running]);
  const input: ShipRun[] = structuredClone([old, recent, running]);
  const { runs, archived } = migrateShipArchive(input, '1d', merged + 3 * day + 1000);
  assert.equal(archived, 1);
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((run) => run.archivedAt !== undefined),
    [true, false, false],
  );
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(
    runs.map((run) => run.issues.length),
    [2, 2, 2],
  );
  assert.equal(shipArchiveNoticeText(archived), '1 run archived');
  assert.equal(shipArchiveNoticeText(2), '2 runs archived');
});

void test('archived state survives storage and unarchive returns the run to the list', () => {
  const { runs } = autoArchiveShipRuns([finished('kept')], 'immediately', merged);
  const restored = loadShipRuns(JSON.stringify(runs));
  assert.equal(restored[0].archivedAt, merged);
  assert.equal(restored[0].archivedBy, 'auto');
  const back = unarchiveShipRun(restored[0], merged + 5 * day);
  assert.equal(back.archivedAt, undefined);
  assert.equal('archivedBy' in back, false);
  assert.equal(back.issues.length, 2);
  assert.equal(autoArchiveShipRuns([back], 'immediately', merged + 30 * day).archived, 0);
  assert.equal(loadShipRuns(JSON.stringify([back]))[0].unarchivedAt, merged + 5 * day);
});

void test('archive delays fall back to one day for unknown values', () => {
  assert.equal(parseShipArchiveDelay('off'), 'off');
  assert.equal(parseShipArchiveDelay('7d'), '7d');
  assert.equal(parseShipArchiveDelay('soon'), '1d');
  assert.equal(parseShipArchiveDelay(null), '1d');
});

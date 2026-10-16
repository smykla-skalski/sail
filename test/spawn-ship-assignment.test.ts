import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSpawnShipIssue,
  spawnShipRetry,
  finishSpawnShipRetry,
  requireSpawnShipIssueAvailable,
} from '../src/lib/spawn-ship-assignment.ts';

void test('retry receipt stays pending until confirmation then records the queue outcome', async () => {
  let resolve!: (value: string) => void;
  const confirmation = new Promise<string>((done) => {
    resolve = done;
  });
  const recorded: Array<{ state: string; result: string | null; error: string | null }> = [];
  const operation = finishSpawnShipRetry(
    () => confirmation,
    async (result) => {
      recorded.push(result);
    },
  );
  await Promise.resolve();
  assert.deepEqual(recorded, []);
  resolve('Retry queued.');
  await operation;
  assert.deepEqual(recorded, [{ state: 'completed', result: 'Retry queued.', error: null }]);
});

void test('retry receipt records cancellation and failures without claiming a launch', async () => {
  const recorded: Array<{ state: string; result: string | null; error: string | null }> = [];
  const record = async (result: { state: string; result: string | null; error: string | null }) => {
    recorded.push(result);
  };
  await finishSpawnShipRetry(async () => '', record);
  await finishSpawnShipRetry(async () => {
    throw new Error('Claim ownership changed.');
  }, record);
  assert.deepEqual(recorded, [
    { state: 'interrupted', result: 'Retry cancelled.', error: null },
    { state: 'failed', result: null, error: 'Claim ownership changed.' },
  ]);
  await assert.rejects(
    finishSpawnShipRetry(
      async () => 'queued',
      async () => {
        throw new Error('Storage failed.');
      },
    ),
    /Storage failed/,
  );
});
import { adoptRegisteredDirectShipRun, type ShipRun } from '../src/lib/issue-shipping.ts';
import {
  loadShipRuns,
  serializeShipRuns,
  shipOwner,
  shipCheckpointOwner,
} from '../src/lib/ship-progress.ts';

void test('Ship spawn assignment is explicit and limited to implementation workers', () => {
  assert.equal(parseSpawnShipIssue(undefined, 'implementation'), undefined);
  assert.deepEqual(
    parseSpawnShipIssue({ repository: 'Owner/Repo', number: 789 }, 'implementation'),
    {
      repository: 'owner/repo',
      number: 789,
    },
  );
  for (const role of [undefined, 'review', 'testing', 'exploration'])
    assert.throws(
      () => parseSpawnShipIssue({ repository: 'a/b', number: 1 }, role),
      /implementation/,
    );
  for (const value of [
    null,
    [],
    {},
    { repository: '../a/b', number: 1 },
    { repository: 'a/b', number: '1' },
    { repository: 'a/b', number: 0 },
    { repository: 'a/b', number: 1.5 },
    { repository: 'a/b', number: Number.MAX_SAFE_INTEGER + 1 },
    { repository: 'a/b', number: 1, threadId: 'unrelated' },
  ])
    assert.throws(
      () => parseSpawnShipIssue(value, 'implementation'),
      /repository and positive issue/,
    );
});

const input = {
  id: 'spawned',
  project: '/repo',
  directory: '/repo/worker',
  branch: 'fix/789',
  repository: 'a/b',
  number: 789,
  provider: 'codex' as const,
  threadId: 'acp:codex:worker',
  approvedAt: 100,
};

void test('Ship retry retains the assignment and rejects foreign or live workers', async () => {
  let runs: ShipRun[] = [];
  await adoptRegisteredDirectShipRun(
    Promise.resolve([
      { path: input.directory, branch: input.branch, present: true, generation: null },
    ]),
    input,
    () => runs,
    (value) => {
      runs = value;
    },
    async () => {},
  );
  const issue = runs[0].issues[0];
  issue.receiptId = 'old';
  const receipt: import('../src/lib/agent-results.ts').SpawnReceipt = {
    receiptId: 'old',
    project: input.project,
    sourceId: 'coordinator',
    sourceDirectory: input.project,
    targetId: issue.threadId,
    targetDirectory: issue.path,
    state: 'interrupted',
    accessKey: 'key',
    requestId: 'request',
    turnId: 'turn',
    worktreeId: input.directory,
    provider: 'codex',
    prompt: null,
    created: 1,
    updated: 2,
    result: null,
    error: null,
  };
  const lookup = (receipts = [receipt], source = 'coordinator', directory = input.project) =>
    spawnShipRetry(
      runs,
      receipts,
      input.project,
      { repository: 'A/B', number: 789 },
      source,
      directory,
    );
  const selected = lookup();
  assert.equal(selected.run, runs[0]);
  assert.equal(selected.issue, issue);
  assert.equal(selected.issue.path, input.directory);
  assert.throws(() => lookup([], 'coordinator'), /original coordinator/);
  assert.throws(() => lookup([receipt], 'other'), /original coordinator/);
  assert.throws(() => lookup([receipt], 'coordinator', '/other'), /original coordinator/);
  assert.throws(() => lookup([{ ...receipt, targetId: 'foreign' }]), /original coordinator/);
  for (const state of ['working', 'waiting', 'queued', 'starting', 'completed'] as const)
    assert.throws(() => lookup([{ ...receipt, state }]), /has not stopped/);
});

void test('persisted spawned assignment grants all worker controls only to its thread and worktree', async () => {
  let runs: ShipRun[] = [];
  let saved = '';
  await adoptRegisteredDirectShipRun(
    Promise.resolve([
      { path: input.directory, branch: input.branch, present: true, generation: null },
    ]),
    input,
    () => runs,
    (value) => {
      runs = value;
    },
    async () => {
      saved = serializeShipRuns(runs, []);
    },
  );
  const restored = loadShipRuns(saved);
  const owner = shipOwner(restored, input.directory, input.threadId);
  assert.equal(owner?.issue.number, 789);
  assert.ok(owner?.issue.checkpoint);
  assert.equal(owner?.issue.validationPolicyRequired, true);
  assert.equal(shipCheckpointOwner(restored, input.directory, input.threadId)?.issue, owner?.issue);
  for (const [directory, threadId] of [
    [input.project, input.threadId],
    [input.directory, 'acp:codex:coordinator'],
    [input.directory, 'acp:codex:unrelated'],
  ]) {
    assert.equal(shipOwner(restored, directory, threadId), undefined);
    assert.equal(shipCheckpointOwner(restored, directory, threadId), undefined);
  }
  assert.throws(
    () =>
      requireSpawnShipIssueAvailable(restored, input.project, { repository: 'A/B', number: 789 }),
    /already has a tracked assignment/,
  );
  assert.throws(
    () =>
      requireSpawnShipIssueAvailable(
        restored,
        input.project,
        { repository: 'a/b', number: 790 },
        input.directory,
      ),
    /worktree already has a Ship assignment/,
  );
  assert.doesNotThrow(() =>
    requireSpawnShipIssueAvailable(restored, input.project, { repository: 'a/b', number: 790 }),
  );
});

void test('failed assignment persistence leaves no accessible worker checkpoint', async () => {
  let runs: ShipRun[] = [];
  await assert.rejects(
    adoptRegisteredDirectShipRun(
      Promise.resolve([
        { path: input.directory, branch: input.branch, present: true, generation: null },
      ]),
      input,
      () => runs,
      (value) => {
        runs = value;
      },
      async () => {
        throw new Error('storage unavailable');
      },
    ),
    /storage unavailable/,
  );
  assert.equal(shipOwner(runs, input.directory, input.threadId), undefined);
  assert.equal(shipCheckpointOwner(runs, input.directory, input.threadId), undefined);
});

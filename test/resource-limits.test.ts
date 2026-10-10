import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceQueue } from '../src/lib/resource-queue.ts';
import { isSetting } from '../src/lib/settings.ts';
import { acp } from '../src/lib/acp.ts';
import { resourceQueues } from '../src/lib/resource-limits.ts';
import {
  defaultPressureThresholds,
  parsePressureThreshold,
  pressureReason,
  type MachineReading,
} from '../src/lib/machine-pressure.ts';

const healthy: MachineReading = {
  totalMemory: 100,
  availableMemory: 20,
  totalSwap: 100,
  usedSwap: 20,
  totalDisk: 100,
  availableDisk: 20,
};

void test('pressure thresholds include the boundary and recover above it', () => {
  assert.match(
    pressureReason({ ...healthy, availableMemory: 10 }, defaultPressureThresholds)!,
    /free memory at or below 10%/,
  );
  assert.equal(
    pressureReason({ ...healthy, availableMemory: 10.01 }, defaultPressureThresholds),
    null,
  );
  assert.match(
    pressureReason({ ...healthy, usedSwap: 70 }, defaultPressureThresholds)!,
    /swap use at or above 70%/,
  );
  assert.equal(pressureReason({ ...healthy, usedSwap: 69.99 }, defaultPressureThresholds), null);
  assert.match(
    pressureReason({ ...healthy, availableDisk: 2 }, defaultPressureThresholds)!,
    /free disk at or below 2%/,
  );
  assert.equal(
    pressureReason({ ...healthy, availableDisk: 2.01 }, defaultPressureThresholds),
    null,
  );
});

void test('invalid readings queue starts and report every affected reading', () => {
  const reason = pressureReason(
    { ...healthy, totalMemory: 0, usedSwap: 101, availableDisk: -1 },
    defaultPressureThresholds,
  );
  assert.match(reason!, /memory reading unavailable/);
  assert.match(reason!, /swap reading unavailable/);
  assert.match(reason!, /disk reading unavailable/);
  assert.equal(
    pressureReason({ ...healthy, totalSwap: 0, usedSwap: 0 }, defaultPressureThresholds),
    null,
  );
});

void test('configured thresholds parse strictly and zero disables each threshold', () => {
  assert.equal(parsePressureThreshold('0', 10), 0);
  assert.equal(parsePressureThreshold('101', 10), 10);
  assert.equal(parsePressureThreshold('-1', 10), 10);
  assert.equal(
    pressureReason(
      { ...healthy, availableMemory: 0, usedSwap: 100, availableDisk: 0 },
      { memoryFreePercent: 0, swapUsedPercent: 0, diskFreePercent: 0 },
    ),
    null,
  );
});

void test('pressure recovery starts queued work without disturbing active work', async () => {
  const queue = new ResourceQueue(2);
  const first = await queue.acquire('active');
  queue.setBlockedReason('Waiting for machine pressure: free disk at or below 2%.');
  const second = queue.acquire('queued');
  assert.equal(await settled(second), false);
  assert.equal(queue.status.active, 1);
  queue.setBlockedReason(null);
  const releaseSecond = await second;
  assert.equal(queue.status.active, 2);
  first();
  releaseSecond();
  assert.equal(queue.status.active, 0);
});

void test('queued work retains its workspace disk until admission', async () => {
  const queue = new ResourceQueue(1, 'Checking machine pressure…');
  const pending = queue.acquire('external', '/Volumes/work');
  assert.deepEqual(queue.waitingDirectories(), ['/Volumes/work']);
  queue.setBlockedReason(null);
  const release = await pending;
  assert.deepEqual(queue.waitingDirectories(), []);
  release();
});

void test('cancelled agent connection never reaches process startup', async () => {
  resourceQueues.agent.setBlockedReason(
    'Waiting for machine pressure: free memory at or below 10%.',
  );
  const controller = new AbortController();
  try {
    const pending = acp.connect('codex', undefined, { signal: controller.signal });
    assert.equal(await settled(pending), false);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    resourceQueues.agent.setBlockedReason('Checking machine pressure…');
  }
});

void test('E2E job limit loads with user settings, unlike test-only E2E keys', () => {
  assert.equal(isSetting('sai-e2e-job-limit'), true);
  assert.equal(isSetting('sai-e2e-delete-worktree'), false);
});

void test('queued agent startup can be cancelled before acquiring a slot', async () => {
  resourceQueues.agent.setLimit(0);
  const limits: (number | null)[] = [];
  try {
    const pending = acp.acquireTurnSlot('queued-startup', (limit) => limits.push(limit));
    assert.equal(await settled(pending), false);
    assert.equal(acp.cancelQueuedTurn('queued-startup'), true);
    await assert.rejects(pending, /cancelled/);
    assert.equal(limits[0], 0);
    assert.equal(limits.at(-1), null);
    assert.ok(limits.slice(0, -1).every((limit) => limit === 0));
    assert.equal(resourceQueues.agent.status.active, 0);
  } finally {
    resourceQueues.agent.setLimit(4);
  }
});

async function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
  ]);
}

void test('zero pauses new work and cancellation never starts it', async () => {
  const queue = new ResourceQueue(0);
  const pending = queue.acquire('first');
  assert.equal(await settled(pending), false);
  assert.deepEqual(queue.status, { active: 0, waiting: 1, limit: 0 });
  assert.equal(queue.cancel('first'), true);
  await assert.rejects(pending, /cancelled/);
  queue.setLimit(1);
  assert.equal(queue.status.active, 0);
});

void test('one slot starts queued work in launch order', async () => {
  const queue = new ResourceQueue(1);
  const first = await queue.acquire('first');
  const second = queue.acquire('second');
  const third = queue.acquire('third');
  assert.equal(await settled(second), false);
  first();
  const releaseSecond = await second;
  assert.equal(await settled(third), false);
  releaseSecond();
  (await third)();
  assert.deepEqual(queue.status, { active: 0, waiting: 0, limit: 1 });
});

void test('the configured maximum runs and one above it waits', async () => {
  const queue = new ResourceQueue(3);
  const releases = await Promise.all([0, 1, 2].map((index) => queue.acquire(String(index))));
  const extra = queue.acquire('extra');
  assert.deepEqual(queue.status, { active: 3, waiting: 1, limit: 3 });
  releases[0]();
  const releaseExtra = await extra;
  releases[1]();
  releases[2]();
  releaseExtra();
  assert.equal(queue.status.active, 0);
});

void test('lowering a limit keeps active work and blocks new starts', async () => {
  const queue = new ResourceQueue(2);
  const first = await queue.acquire('first');
  const second = await queue.acquire('second');
  queue.setLimit(1);
  const third = queue.acquire('third');
  first();
  assert.equal(await settled(third), false);
  second();
  (await third)();
  assert.equal(queue.status.active, 0);
});

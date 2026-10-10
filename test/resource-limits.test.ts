import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceQueue } from '../src/lib/resource-queue.ts';

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

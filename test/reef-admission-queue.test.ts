import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceQueue, type AdmissionProvider } from '../src/lib/resource-queue.ts';

function deferredAdmission() {
  const requests: {
    signal: AbortSignal;
    reason: (value: string) => void;
    grant: (release: () => void) => void;
  }[] = [];
  const provider: AdmissionProvider = (signal, reason) =>
    new Promise((grant) => requests.push({ signal, reason, grant }));
  return { requests, provider };
}

void test('Reef owns admission and reasons while local pressure is bypassed', async () => {
  const queue = new ResourceQueue(2, 'Local pressure');
  const admission = deferredAdmission();
  queue.setAdmission(admission.provider);
  const first = queue.acquire('agent');
  const second = queue.acquire('browser');
  assert.equal(queue.status.active, 0);
  admission.requests[0].reason('CPU budget in use');
  assert.equal(queue.reasonFor('agent'), 'CPU budget in use');
  assert.equal(queue.status.waiting, 2);
  let released = 0;
  admission.requests[0].grant(() => released++);
  const release = await first;
  assert.equal(queue.isActive('agent'), true);
  queue.setBlockedReason('Memory pressure');
  assert.equal(queue.isActive('agent'), true);
  release();
  release();
  assert.equal(released, 1);
  admission.requests[1].grant(() => {});
  (await second)();
});

void test('cancelled request releases a racing grant without starting work', async () => {
  const queue = new ResourceQueue(1);
  const admission = deferredAdmission();
  queue.setAdmission(admission.provider);
  const pending = queue.acquire('cancel');
  const rejected = assert.rejects(pending, /cancelled/);
  assert.equal(queue.cancel('cancel'), true);
  assert.equal(admission.requests[0].signal.aborted, true);
  let released = 0;
  admission.requests[0].grant(() => released++);
  await rejected;
  await Promise.resolve();
  assert.equal(released, 1);
  assert.equal(queue.status.active, 0);
});

void test('disabling Reef restores local pressure and releases stale grants', async () => {
  const queue = new ResourceQueue(1, 'Local pressure');
  const admission = deferredAdmission();
  queue.setAdmission(admission.provider);
  const pending = queue.acquire('switch');
  queue.setAdmission(null);
  assert.equal(admission.requests[0].signal.aborted, true);
  assert.equal(queue.isQueued('switch'), true);
  let staleRelease = 0;
  admission.requests[0].grant(() => staleRelease++);
  await Promise.resolve();
  assert.equal(staleRelease, 1);
  assert.equal(queue.isActive('switch'), false);
  queue.setBlockedReason(null);
  (await pending)();
  assert.equal(queue.status.active, 0);
});

void test('Reef reservations respect local concurrency until work releases a slot', async () => {
  const queue = new ResourceQueue(1);
  const admission = deferredAdmission();
  queue.setAdmission(admission.provider);
  const first = queue.acquire('first');
  const second = queue.acquire('second');
  assert.equal(admission.requests.length, 1);
  admission.requests[0].grant(() => {});
  const release = await first;
  assert.equal(admission.requests.length, 1);
  release();
  assert.equal(admission.requests.length, 2);
  admission.requests[1].grant(() => {});
  (await second)();
});

void test('lowering concurrency to zero releases a late Reef grant without starting', async () => {
  const queue = new ResourceQueue(1);
  const admission = deferredAdmission();
  queue.setAdmission(admission.provider);
  const pending = queue.acquire('paused');
  queue.setLimit(0);
  let released = 0;
  admission.requests[0].grant(() => released++);
  await Promise.resolve();
  assert.equal(released, 1);
  assert.equal(queue.isQueued('paused'), true);
  assert.equal(queue.isActive('paused'), false);
  queue.setLimit(1);
  admission.requests[1].grant(() => released++);
  (await pending)();
  assert.equal(released, 2);
});

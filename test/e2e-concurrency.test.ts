import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { E2eJobQueue, e2eJobLimit } from './e2e-concurrency.ts';

async function notStarted(promise: Promise<void>): Promise<void> {
  assert.equal(
    await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 40)),
    ]),
    false,
  );
}

void test('E2E jobs honor zero, one, maximum, and one above maximum', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sail-e2e-limit-test-'));
  const previous = process.env.SAIL_E2E_JOB_LIMIT;
  const jobs = Array.from({ length: 4 }, () => new E2eJobQueue(root));
  try {
    process.env.SAIL_E2E_JOB_LIMIT = '0';
    const first = jobs[0].acquire();
    await notStarted(first);
    process.env.SAIL_E2E_JOB_LIMIT = '1';
    await first;
    const second = jobs[1].acquire();
    await notStarted(second);
    process.env.SAIL_E2E_JOB_LIMIT = '3';
    await second;
    await jobs[2].acquire();
    const fourth = jobs[3].acquire();
    await notStarted(fourth);
    process.env.SAIL_E2E_JOB_LIMIT = '1';
    jobs[0].release();
    await notStarted(fourth);
    jobs[1].release();
    await notStarted(fourth);
    jobs[2].release();
    await fourth;
  } finally {
    for (const job of jobs) job.release();
    if (previous === undefined) delete process.env.SAIL_E2E_JOB_LIMIT;
    else process.env.SAIL_E2E_JOB_LIMIT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

void test('E2E limit rejects invalid values', () => {
  assert.equal(e2eJobLimit({ SAIL_E2E_JOB_LIMIT: '0' }), 0);
  assert.equal(e2eJobLimit({ SAIL_E2E_JOB_LIMIT: '32' }), 32);
  assert.throws(() => e2eJobLimit({ SAIL_E2E_JOB_LIMIT: '-1' }), /integer/);
  assert.throws(() => e2eJobLimit({ SAIL_E2E_JOB_LIMIT: '33' }), /integer/);
});

void test('cancelled queued E2E work never takes a slot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sail-e2e-cancel-test-'));
  const previous = process.env.SAIL_E2E_JOB_LIMIT;
  const first = new E2eJobQueue(root);
  const queued = new E2eJobQueue(root);
  try {
    process.env.SAIL_E2E_JOB_LIMIT = '1';
    await first.acquire();
    const waiting = queued.acquire();
    await notStarted(waiting);
    queued.release();
    await assert.rejects(waiting, /cancelled/);
    first.release();
    const next = new E2eJobQueue(root);
    await next.acquire();
    next.release();
  } finally {
    first.release();
    queued.release();
    if (previous === undefined) delete process.env.SAIL_E2E_JOB_LIMIT;
    else process.env.SAIL_E2E_JOB_LIMIT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnVerificationQueue } from '../src/lib/turn-verification-queue.ts';

await test('a retry completed during a slow check acknowledges the turn once without rerunning commands', async () => {
  const verifyTurn = createTurnVerificationQueue();
  let releaseSlowCheck!: () => void;
  const slowCheck = new Promise<void>((resolve) => (releaseSlowCheck = resolve));
  let signalSlowCheck!: () => void;
  const slowCheckStarted = new Promise<void>((resolve) => (signalSlowCheck = resolve));
  let slowDurable = false;
  let retryDurable = false;
  let slowRuns = 0;
  let retryRuns = 0;
  let finishes = 0;
  const verify = async () => {
    const retryWasDurable = retryDurable;
    if (!slowDurable) {
      slowRuns++;
      signalSlowCheck();
      await slowCheck;
      slowDurable = true;
    }
    if (retryWasDurable) finishes++;
  };

  const automatic = verifyTurn('agent:session:turn', verify);
  await slowCheckStarted;
  retryRuns++;
  retryDurable = true;
  const manualRetry = verifyTurn('agent:session:turn', verify);
  const duplicateSignal = verifyTurn('agent:session:turn', verify);
  assert.equal(finishes, 0);
  releaseSlowCheck();
  await Promise.all([automatic, manualRetry, duplicateSignal]);

  assert.equal(finishes, 1);
  assert.equal(slowRuns, 1);
  assert.equal(retryRuns, 1);
});

await test('an unsuccessful pass waits for another event instead of retrying forever', async () => {
  const verifyTurn = createTurnVerificationQueue();
  let attempts = 0;
  const verify = async () => {
    attempts++;
  };

  await verifyTurn('agent:session:turn', verify);
  assert.equal(attempts, 1);
  await verifyTurn('agent:session:turn', verify);
  assert.equal(attempts, 2);
});

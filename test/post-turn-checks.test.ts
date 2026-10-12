import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasDurableCheckOutcome,
  personalChecks,
  retryInterruptedCheck,
  upsertCheck,
  type PostTurnCheck,
} from '../src/lib/post-turn-checks.ts';

await test('personal checks reject malformed settings while keeping configured commands', () => {
  assert.deepEqual(personalChecks('["mise run test", "", 5, "mise run lint"]'), [
    'mise run test',
    'mise run lint',
  ]);
  assert.deepEqual(personalChecks('{'), []);
});

await test('restart-interrupted checks require one automatic retry; declined checks remain settled', () => {
  const base: PostTurnCheck = {
    id: 'check',
    updated: 1,
    directory: '/repo',
    thread: 'acp:claude:session',
    turn: 'turn',
    source: 'personal',
    command: 'mise run test',
    status: 'canceled',
    output: '',
    code: null,
  };
  const interrupted = { ...base, restartInterrupted: true };
  assert.equal(retryInterruptedCheck(interrupted), true);
  assert.equal(hasDurableCheckOutcome(interrupted), false);
  assert.equal(hasDurableCheckOutcome({ ...base, restartInterrupted: false }), true);
  assert.equal(hasDurableCheckOutcome(base), true);
  assert.equal(retryInterruptedCheck({ ...interrupted, status: 'passed' }), false);
});

await test('check updates replace one turn without hiding a later turn or source', () => {
  const check: PostTurnCheck = {
    id: 'check-1',
    updated: 1,
    directory: '/repo',
    thread: 'acp:claude:one',
    turn: 'turn-1',
    source: 'repository',
    command: 'mise run test',
    status: 'running',
    output: '',
    code: null,
  };
  const other = { ...check, turn: 'turn-2' };
  const personal = { ...check, source: 'personal' as const };
  const results = upsertCheck([check, other, personal], { ...check, status: 'failed', code: 7 });
  assert.equal(results.length, 3);
  assert.equal(
    results.find((item) => item.turn === 'turn-1' && item.source === 'repository')?.code,
    7,
  );
  assert.ok(results.some((item) => item.turn === 'turn-2'));
  assert.ok(results.some((item) => item.source === 'personal'));
});

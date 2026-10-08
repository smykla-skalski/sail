import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runOpenCodeCleanup,
  runOpenCodePromptStart,
  runSerialOpenCodeTurn,
} from '../src/lib/opencode-turns.ts';

void test('turns in one session start after the prior turn settles', async () => {
  const events: string[] = [];
  let finishFirst!: () => void;
  const first = runSerialOpenCodeTurn('serial-a', async () => {
    events.push('first snapshot');
    await new Promise<void>((resolve) => (finishFirst = resolve));
    events.push('first done');
  });
  const second = runSerialOpenCodeTurn('serial-a', async () => {
    events.push('second snapshot');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first snapshot']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first snapshot', 'first done', 'second snapshot']);
});

void test('a failed turn does not block later turns', async () => {
  const first = runSerialOpenCodeTurn('serial-b', async () => {
    throw new Error('prompt failed');
  });
  const second = runSerialOpenCodeTurn('serial-b', async () => 'sent');
  await assert.rejects(first, /prompt failed/);
  assert.equal(await second, 'sent');
});

void test('prompt acceptance and cleanup cannot overlap in one worktree', async () => {
  const events: string[] = [];
  let acceptPrompt!: () => void;
  let finishCleanup!: () => void;
  const prompt = runOpenCodePromptStart('/worktree', async () => {
    events.push('prompt started');
    await new Promise<void>((resolve) => (acceptPrompt = resolve));
    events.push('prompt accepted');
  });
  const cleanup = runOpenCodeCleanup('/worktree', async () => {
    events.push('cleanup started');
    await new Promise<void>((resolve) => (finishCleanup = resolve));
    events.push('cleanup finished');
  });
  const latePrompt = runOpenCodePromptStart('/worktree', async () => {
    events.push('late prompt started');
  });
  const latePromptFailure = assert.rejects(latePrompt, /cleanup is in progress/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['prompt started']);

  acceptPrompt();
  await prompt;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['prompt started', 'prompt accepted', 'cleanup started']);

  finishCleanup();
  await cleanup;
  await latePromptFailure;
  assert.deepEqual(events, [
    'prompt started',
    'prompt accepted',
    'cleanup started',
    'cleanup finished',
  ]);
});

void test('a failed cleanup allows later prompt starts', async () => {
  await assert.rejects(
    runOpenCodeCleanup('/recoverable-worktree', async () => {
      throw new Error('still active');
    }),
    /still active/,
  );

  const result = await runOpenCodePromptStart('/recoverable-worktree', async () => 'started');

  assert.equal(result, 'started');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openCodeInboxSettled,
  runOpenCodeCleanup,
  runOpenCodePromptStart,
  runReservedOpenCodeTurn,
  runSerialOpenCodeTurn,
  waitForAuthoritativeOpenCodeSettlement,
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

void test('accepted turns reserve their profile until execution settlement', async () => {
  const firstStarted = Promise.withResolvers<void>();
  const finishFirst = Promise.withResolvers<void>();
  const promptAccepted = Promise.withResolvers<void>();
  const executionSettled = Promise.withResolvers<void>();
  const events: string[] = [];
  const first = runSerialOpenCodeTurn('reserved-session', async () => {
    firstStarted.resolve();
    await finishFirst.promise;
  });
  await firstStarted.promise;

  const second = runReservedOpenCodeTurn(
    'reserved-session',
    async () => {
      events.push('reserved');
      return () => events.push('released');
    },
    async () => {
      events.push('prompting');
      await promptAccepted.promise;
      events.push('accepted');
    },
    async () => {
      events.push('settling');
      await executionSettled.promise;
      events.push('settled');
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(events, []);
  finishFirst.resolve();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['reserved', 'prompting']);
  promptAccepted.resolve();
  await second;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['reserved', 'prompting', 'accepted', 'settling']);
  executionSettled.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    'reserved',
    'prompting',
    'accepted',
    'settling',
    'settled',
    'released',
  ]);
});

void test('failed waits retry until provider settlement is authoritative', async () => {
  const retry = Promise.withResolvers<void>();
  const secondWait = Promise.withResolvers<void>();
  const waits = [
    async () => {
      throw new Error('connection lost');
    },
    () => secondWait.promise,
  ];
  let waitAttempts = 0;
  let settledChecks = 0;
  let finished = false;
  const completion = waitForAuthoritativeOpenCodeSettlement(
    async () => {
      waitAttempts++;
      return waits.shift()!();
    },
    async () => {
      settledChecks++;
      return settledChecks > 1;
    },
    { retry: () => retry.promise },
  ).then(() => {
    finished = true;
    return undefined;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(finished, false);
  assert.equal(waitAttempts, 1);
  assert.equal(settledChecks, 1);
  retry.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(waitAttempts, 2);
  secondWait.resolve();
  await completion;
  assert.equal(finished, true);
});

void test('successful waits still require the accepted inbox execution to settle', async () => {
  const retry = Promise.withResolvers<void>();
  let correlated = false;
  let finished = false;
  const completion = waitForAuthoritativeOpenCodeSettlement(
    async () => undefined,
    async () => correlated,
    { retry: () => retry.promise },
  ).then(() => {
    finished = true;
    return undefined;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(finished, false);
  correlated = true;
  retry.resolve();
  await completion;
  assert.equal(finished, true);
});

void test('settlement belongs to the accepted inbox instead of an earlier outcome', async () => {
  assert.equal(
    await openCodeInboxSettled('accepted', async () => ({
      data: [
        { id: 'accepted', type: 'user' },
        { id: 'prior-idle', type: 'idle' },
      ],
      cursor: {},
    })),
    false,
  );
  assert.equal(
    await openCodeInboxSettled('accepted', async () => ({
      data: [
        { id: 'new-idle', type: 'idle' },
        { id: 'accepted', type: 'user' },
        { id: 'prior-idle', type: 'idle' },
      ],
      cursor: {},
    })),
    true,
  );
});

void test('settlement correlation follows pagination to the accepted inbox', async () => {
  const pages: Record<string, { data: { id: string; type: string }[]; cursor: { next?: string } }> =
    {
      first: {
        data: [{ id: 'new-idle', type: 'idle' }],
        cursor: { next: 'older' },
      },
      older: {
        data: [{ id: 'accepted', type: 'user' }],
        cursor: {},
      },
    };

  assert.equal(
    await openCodeInboxSettled('accepted', async (cursor) => pages[cursor ?? 'first']),
    true,
  );
});

void test('missing sessions stop settlement recovery', async () => {
  const missing = new Error('session not found');
  let retries = 0;

  await waitForAuthoritativeOpenCodeSettlement(
    async () => {
      throw new Error('connection lost');
    },
    async () => {
      throw missing;
    },
    {
      retry: async () => {
        retries++;
      },
      terminal: (cause) => cause === missing,
    },
  );

  assert.equal(retries, 0);
});

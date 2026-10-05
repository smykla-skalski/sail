import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from '../src/lib/acp.ts';
import {
  activeImplementationModels,
  implementationModels,
  recoverImplementationModels,
} from '../src/lib/implementation-models.ts';
import { trackImplementationSteer } from '../src/lib/implementation-steering.ts';

type SteerResult = Awaited<Awaited<ReturnType<typeof trackImplementationSteer>>['response']>;

function transport(directory: string) {
  const values = new Map<string, string>();
  let revision = 'before';
  let callback: ((event: { payload: AgentEvent }) => void) | undefined;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        transformCallback: (handler: typeof callback) => {
          callback = handler;
          return 1;
        },
        invoke: async (command: string) => {
          if (command === 'plugin:event|listen') return 1;
          if (command === 'plugin:event|unlisten') return undefined;
          assert.equal(command, 'working_tree_revision');
          return revision;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => {
          callback = undefined;
        },
      },
    },
  });
  const emit = (message: AgentEvent['message'], agent: AgentEvent['agent'] = 'codex') =>
    callback?.({ payload: { agent, message } });
  return {
    edit: () => {
      revision = 'after';
    },
    emit,
    status: (type: string, sessionId = 'session') =>
      emit({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            _meta: { codex: { threadStatus: { type } } },
          },
        },
      }),
    pending: (): unknown[] => {
      const saved: unknown = JSON.parse(
        values.get(`sai-implementation-pending:${directory}`) ?? '[]',
      );
      assert.ok(Array.isArray(saved));
      return saved;
    },
  };
}

function deferredResponse() {
  let resolve!: (result: SteerResult) => void;
  const response = new Promise<SteerResult>((finish) => {
    resolve = finish;
  });
  return { response, resolve };
}

void test('old prompt completion preserves pending detached steering attribution', async () => {
  const directory = '/test/steer-old-prompt';
  const fake = transport(directory);
  const pending = deferredResponse();
  const tracking = await trackImplementationSteer(
    directory,
    'model-a',
    'codex',
    'session',
    'old-turn',
    () => pending.response,
  );

  fake.emit({
    method: 'sail/prompt_finished',
    params: { sessionId: 'session', turnId: 'old-turn' },
  });
  assert.equal(
    await Promise.race([tracking.response, Promise.resolve('original-finished')]),
    'original-finished',
  );
  fake.status('idle');
  await recoverImplementationModels(directory);

  assert.equal(fake.pending().length, 1);
  assert.deepEqual(implementationModels(directory), []);
  pending.resolve({ outcome: 'startedNewTurn' });
  assert.deepEqual(await tracking.response, { outcome: 'startedNewTurn' });
  assert.deepEqual(await activeImplementationModels(directory, 'acp:codex:session'), ['model-a']);
  assert.equal(fake.pending().length, 1);
  fake.status('active');
  fake.edit();
  fake.status('idle');
  await tracking.completed;
  assert.deepEqual(implementationModels(directory), ['model-a']);
  assert.deepEqual(fake.pending(), []);
});

void test('detached steering records delayed edits only after its active turn ends', async () => {
  const directory = '/test/steer-delayed-edit';
  const fake = transport(directory);
  const tracking = await trackImplementationSteer(
    directory,
    'model-a',
    'codex',
    'session',
    'old-turn',
    async () => ({ outcome: 'startedNewTurn' }),
  );
  await tracking.response;

  fake.status('idle');
  fake.status('active');
  fake.edit();
  fake.status('idle', 'unrelated-session');
  fake.emit({ method: 'sail/disconnected' }, 'claude');
  await recoverImplementationModels(directory);

  assert.equal(fake.pending().length, 1);
  assert.deepEqual(implementationModels(directory), []);
  assert.deepEqual(await activeImplementationModels(directory), ['model-a']);
  fake.status('idle');
  await tracking.completed;
  assert.deepEqual(implementationModels(directory), ['model-a']);
  assert.deepEqual(fake.pending(), []);
  assert.deepEqual(await activeImplementationModels(directory), []);
});

void test('a detached turn completed before the steering response retains its edits', async () => {
  const directory = '/test/steer-fast-completion';
  const fake = transport(directory);
  const pending = deferredResponse();
  const tracking = await trackImplementationSteer(
    directory,
    'model-a',
    'codex',
    'session',
    'old-turn',
    () => pending.response,
  );

  fake.status('idle');
  fake.status('active');
  fake.edit();
  fake.status('idle');
  assert.equal(fake.pending().length, 1);
  pending.resolve({ outcome: 'startedNewTurn' });
  await tracking.completed;

  assert.deepEqual(implementationModels(directory), ['model-a']);
  assert.deepEqual(fake.pending(), []);
});

void test('disconnect records edits from a detached steering turn', async () => {
  const directory = '/test/steer-disconnected';
  const fake = transport(directory);
  const tracking = await trackImplementationSteer(
    directory,
    'model-a',
    'codex',
    'session',
    'old-turn',
    async () => ({ outcome: 'startedNewTurn' }),
  );
  await tracking.response;

  fake.edit();
  fake.emit({ method: 'sail/disconnected' });
  await tracking.completed;

  assert.deepEqual(implementationModels(directory), ['model-a']);
  assert.deepEqual(fake.pending(), []);
  assert.deepEqual(await activeImplementationModels(directory), []);
});

void test('injected steering records edits without waiting for a detached lifecycle', async () => {
  const directory = '/test/steer-injected';
  const fake = transport(directory);
  const pending = deferredResponse();
  const tracking = await trackImplementationSteer(
    directory,
    'model-a',
    'codex',
    'session',
    'old-turn',
    () => pending.response,
  );

  fake.edit();
  pending.resolve({ outcome: 'injected' });
  await tracking.completed;

  assert.deepEqual(await tracking.response, { outcome: 'injected' });
  assert.deepEqual(implementationModels(directory), ['model-a']);
  assert.deepEqual(fake.pending(), []);
  assert.deepEqual(await activeImplementationModels(directory), []);
});

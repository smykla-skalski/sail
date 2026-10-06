import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeImplementationModels,
  abandonImplementationTurn,
  beginImplementationTurn,
  beginShipItRun,
  claimLegacyPendingImplementationTurn,
  hasPendingImplementationTurn,
  implementationAttributionUncertain,
  implementationModels,
  recoverImplementationModels,
  recordImplementationModel,
  savedShipItIssue,
  settledImplementationAttribution,
} from '../src/lib/implementation-models.ts';

void test('archive waits for in-flight attribution even when the backend turn has finished', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const revision = Promise.withResolvers<string>();
  let recording = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: { invoke: async () => (recording ? revision.promise : 'before') },
    },
  });
  const directory = '/test/archive-active';
  const turn = await beginImplementationTurn(directory, 'model-a', 'worker');
  recording = true;
  const completion = recordImplementationModel(directory, 'model-a', turn);
  await assert.rejects(settledImplementationAttribution(directory), /still settling/);
  revision.resolve('after');
  await completion;
  assert.deepEqual(await settledImplementationAttribution(directory), {
    models: ['model-a'],
    modelUncertain: false,
  });
});

void test('pending implementation recovery stays with its owning session', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => 'before' } },
  });
  const directory = '/test/owned-pending-turn';
  const turn = await beginImplementationTurn(directory, 'model-a', 'acp:codex:session-a');
  assert.equal(hasPendingImplementationTurn(directory), true);
  assert.equal(hasPendingImplementationTurn(directory, 'acp:codex:session-a'), true);
  assert.equal(hasPendingImplementationTurn(directory, 'acp:codex:session-b'), false);
  abandonImplementationTurn(directory, turn);
});

void test('a single legacy pending turn can be claimed by its Ship session', () => {
  const values = new Map<string, string>();
  const directory = '/test/legacy-pending-turn';
  values.set(
    `sai-implementation-pending:${directory}`,
    JSON.stringify([{ id: 'turn', before: 'before', model: 'model-a' }]),
  );
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  assert.equal(claimLegacyPendingImplementationTurn(directory, 'acp:codex:ship-session'), true);
  assert.equal(hasPendingImplementationTurn(directory, 'acp:codex:ship-session'), true);
  assert.equal(hasPendingImplementationTurn(directory, 'acp:codex:other-session'), false);

  values.set(
    `sai-implementation-pending:${directory}`,
    JSON.stringify([
      { id: 'legacy-a', before: 'before' },
      { id: 'legacy-b', before: 'before' },
    ]),
  );
  assert.equal(claimLegacyPendingImplementationTurn(directory, 'acp:codex:ship-session'), false);
});

for (const model of ['provider:model-a', undefined]) {
  void test(`archive attribution recovers an interrupted ${model ?? 'unknown'} model`, async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    let revision = 'before';
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke: async () => revision } },
    });
    const directory = `/test/archive-${model ?? 'unknown'}`;
    const turn = await beginImplementationTurn(directory, model, 'worker');
    abandonImplementationTurn(directory, turn);
    revision = 'committed-after-restart';
    const snapshot = await settledImplementationAttribution(directory);
    assert.deepEqual(snapshot, {
      models: model ? [model] : [],
      modelUncertain: !model,
    });
    assert.deepEqual(JSON.parse(values.get(`sai-implementation-pending:${directory}`)!), []);
  });
}

void test('model history survives equivalent references and rejects a second issue', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => 'example/repo' } },
  });
  const directory = '/test/reused-worktree';
  assert.deepEqual(await beginShipItRun(directory, '/ship-it #1'), {
    repository: 'example/repo',
    number: 1,
  });
  assert.deepEqual(savedShipItIssue(directory), { repository: 'example/repo', number: 1 });
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-a']));
  await beginShipItRun(directory, '/ship-it #1');
  assert.deepEqual(implementationModels(directory), ['model-a']);
  await beginShipItRun(directory, '/ship-it https://github.com/example/repo/issues/1');
  assert.deepEqual(implementationModels(directory), ['model-a']);
  await beginShipItRun(directory, '/ship-it Example/Repo#001');
  assert.equal(values.get(`sai-implementation-run:${directory}`), 'example/repo#1');
  await assert.rejects(
    () => beginShipItRun(directory, '/ship-it other/repo#1'),
    /This worktree tracks example\/repo#1\. Start other\/repo#1 in a new worktree/,
  );
  await assert.rejects(
    () => beginShipItRun(directory, '/ship-it https://github.com/example/other/issues/1'),
    /Start example\/other#1 in a new worktree/,
  );
  await assert.rejects(
    () => beginShipItRun(directory, '/ship-it #2'),
    /This worktree tracks example\/repo#1\. Start example\/repo#2 in a new worktree/,
  );
  assert.deepEqual(implementationModels(directory), ['model-a']);
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-b']));
  await beginShipItRun(directory, '/ship-it');
  assert.deepEqual(implementationModels(directory), ['model-b']);
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-c']));
  await beginShipItRun(directory, '/ship-it');
  assert.deepEqual(implementationModels(directory), ['model-c']);
});

void test('legacy run identities resolve against the worktree before comparison', async () => {
  const values = new Map<string, string>([['sai-implementation-run:/test/legacy-run', '#210']]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => 'Owner/Repo' } },
  });
  await assert.rejects(
    () => beginShipItRun('/test/legacy-run', '/ship-it other/repo#210'),
    /This worktree tracks owner\/repo#210/,
  );
  await beginShipItRun('/test/legacy-run', '/ship-it #210');
  assert.equal(values.get('sai-implementation-run:/test/legacy-run'), 'owner/repo#210');
});

void test('unresolved bare references require qualification', async () => {
  const values = new Map<string, string>();
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
        invoke: async () => {
          throw new Error('Use owner/repo#number.');
        },
      },
    },
  });
  await assert.rejects(() => beginShipItRun('/test/no-remote', '/ship-it #210'), /Use owner/);
  assert.equal(values.get('sai-implementation-run:/test/no-remote'), undefined);
  await beginShipItRun('/test/no-remote', '/ship-it owner/repo#210');
  assert.equal(values.get('sai-implementation-run:/test/no-remote'), 'owner/repo#210');
});

void test('overlapping known turns reserve both models for validation', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let revision = 'before';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) =>
          command === 'github_issue_repository' ? 'example/repo' : revision,
      },
    },
  });
  const directory = '/test/concurrent-worktree';
  await beginShipItRun(directory, '/ship-it #3');
  const first = await beginImplementationTurn(directory, 'model-a', 'agent-a');
  const second = await beginImplementationTurn(directory, 'model-b', 'agent-b');
  revision = 'after';
  await recordImplementationModel(directory, 'model-a', first);
  await recordImplementationModel(directory, 'model-b', second);
  assert.deepEqual(implementationModels(directory), ['model-a', 'model-b']);
  assert.equal(implementationAttributionUncertain(directory), false);
});

void test('active implementation models are available before turns finish', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => 'same' } },
  });
  const directory = '/test/active-models';
  const known = await beginImplementationTurn(directory, 'provider:model-a', 'agent-a');
  assert.deepEqual(await activeImplementationModels(directory, 'agent-a'), []);
  assert.deepEqual(await activeImplementationModels(directory, 'agent-b'), ['provider:model-a']);
  let revision = 'same';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) =>
          command === 'github_issue_repository' ? 'example/repo' : revision,
      },
    },
  });
  revision = 'changed';
  assert.deepEqual(await activeImplementationModels(directory, 'agent-a'), ['provider:model-a']);
  const unknown = await beginImplementationTurn(directory, undefined, 'agent-b');
  assert.equal(await activeImplementationModels(directory, 'agent-a'), null);
  revision = 'changed-again';
  assert.equal(await activeImplementationModels(directory, 'agent-a'), null);
  abandonImplementationTurn(directory, unknown);
  assert.equal(await activeImplementationModels(directory, 'agent-a'), null);
  abandonImplementationTurn(directory, known);
  assert.deepEqual(await activeImplementationModels(directory, 'agent-a'), []);
});

void test('a read-only coordinator does not inherit another active model', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => 'same' } },
  });
  const directory = '/test/active-coordinator';
  const implementer = await beginImplementationTurn(directory, 'model-a', 'agent-a');
  const coordinator = await beginImplementationTurn(directory, 'model-b', 'agent-b');
  assert.deepEqual(await activeImplementationModels(directory, 'agent-b'), ['model-a']);
  abandonImplementationTurn(directory, coordinator);
  abandonImplementationTurn(directory, implementer);
});

void test('shipping preserves models from implementation before the first run', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let revision = 'before';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) =>
          command === 'github_issue_repository' ? 'example/repo' : revision,
      },
    },
  });
  const directory = '/test/pre-ship-it';
  const turn = await beginImplementationTurn(directory, 'provider:model-a');
  revision = 'after';
  await recordImplementationModel(directory, 'provider:model-a', turn);
  await beginShipItRun(directory, '/ship-it #210');
  assert.deepEqual(implementationModels(directory), ['provider:model-a']);
});

void test('an edit by a turn with an unknown model blocks strict attribution', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let revision = 'before';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) =>
          command === 'github_issue_repository' ? 'example/repo' : revision,
      },
    },
  });
  const directory = '/test/unknown-model';
  await beginShipItRun(directory, '/ship-it #4');
  const turn = await beginImplementationTurn(directory);
  revision = 'after';
  await recordImplementationModel(directory, undefined, turn);
  assert.equal(implementationAttributionUncertain(directory), true);
});

void test('an interrupted editing turn recovers its model from persisted state', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  let revision = 'before';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) =>
          command === 'github_issue_repository' ? 'example/repo' : revision,
      },
    },
  });
  const directory = '/test/interrupted-model';
  const turn = await beginImplementationTurn(directory, 'provider:model-a', 'agent-a');
  revision = 'after';
  abandonImplementationTurn(directory, turn);
  await recoverImplementationModels(directory);
  assert.deepEqual(implementationModels(directory), ['provider:model-a']);
  assert.deepEqual(JSON.parse(values.get(`sai-implementation-pending:${directory}`) ?? 'null'), []);
});

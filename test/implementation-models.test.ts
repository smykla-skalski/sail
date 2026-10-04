import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeImplementationModels,
  abandonImplementationTurn,
  beginImplementationTurn,
  beginShipItRun,
  implementationAttributionUncertain,
  implementationModels,
  recordImplementationModel,
} from '../src/lib/implementation-models.ts';

void test('model history survives equivalent references and rejects a second issue', () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  const directory = '/test/reused-worktree';
  beginShipItRun(directory, '/ship-it #1');
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-a']));
  beginShipItRun(directory, '/ship-it #1');
  assert.deepEqual(implementationModels(directory), ['model-a']);
  beginShipItRun(directory, '/ship-it https://github.com/example/repo/issues/1');
  assert.deepEqual(implementationModels(directory), ['model-a']);
  assert.throws(
    () => beginShipItRun(directory, '/ship-it #2'),
    /This worktree tracks #1\. Start #2 in a new worktree/,
  );
  assert.deepEqual(implementationModels(directory), ['model-a']);
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-b']));
  beginShipItRun(directory, '/ship-it');
  assert.deepEqual(implementationModels(directory), ['model-b']);
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-c']));
  beginShipItRun(directory, '/ship-it');
  assert.deepEqual(implementationModels(directory), ['model-c']);
});

void test('overlapping turns do not attribute one agent’s edit to another', async () => {
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
  const directory = '/test/concurrent-worktree';
  beginShipItRun(directory, '/ship-it #3');
  const first = await beginImplementationTurn(directory);
  const second = await beginImplementationTurn(directory);
  revision = 'after';
  await recordImplementationModel(directory, 'model-a', first);
  await recordImplementationModel(directory, 'model-b', second);
  assert.deepEqual(implementationModels(directory), []);
  assert.equal(implementationAttributionUncertain(directory), true);
});

void test('active implementation models are available before turns finish', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => 'same' } },
  });
  const directory = '/test/active-models';
  const known = await beginImplementationTurn(directory, 'provider:model-a');
  assert.deepEqual(await activeImplementationModels(directory), []);
  let revision = 'same';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async () => revision } },
  });
  revision = 'changed';
  assert.deepEqual(await activeImplementationModels(directory), ['provider:model-a']);
  const unknown = await beginImplementationTurn(directory);
  assert.equal(await activeImplementationModels(directory), null);
  revision = 'changed-again';
  assert.equal(await activeImplementationModels(directory), null);
  abandonImplementationTurn(directory, unknown);
  assert.equal(await activeImplementationModels(directory), null);
  abandonImplementationTurn(directory, known);
  assert.deepEqual(await activeImplementationModels(directory), []);
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
    value: { __TAURI_INTERNALS__: { invoke: async () => revision } },
  });
  const directory = '/test/pre-ship-it';
  const turn = await beginImplementationTurn(directory, 'provider:model-a');
  revision = 'after';
  await recordImplementationModel(directory, 'provider:model-a', turn);
  beginShipItRun(directory, '/ship-it #210');
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
    value: { __TAURI_INTERNALS__: { invoke: async () => revision } },
  });
  const directory = '/test/unknown-model';
  beginShipItRun(directory, '/ship-it #4');
  const turn = await beginImplementationTurn(directory);
  revision = 'after';
  await recordImplementationModel(directory, undefined, turn);
  assert.equal(implementationAttributionUncertain(directory), true);
});

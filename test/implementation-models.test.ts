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

void test('a second issue in the same worktree starts with a fresh implementation set', () => {
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
  beginShipItRun(directory, '/ship-it #2');
  assert.deepEqual(implementationModels(directory), []);
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-b']));
  beginShipItRun(directory, '/ship-it');
  assert.deepEqual(implementationModels(directory), []);
  values.set(`sai-implementation-models:${directory}`, JSON.stringify(['model-c']));
  beginShipItRun(directory, '/ship-it');
  assert.deepEqual(implementationModels(directory), []);
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
  assert.deepEqual(activeImplementationModels(directory), ['provider:model-a']);
  const unknown = await beginImplementationTurn(directory);
  assert.equal(activeImplementationModels(directory), null);
  abandonImplementationTurn(directory, unknown);
  assert.deepEqual(activeImplementationModels(directory), ['provider:model-a']);
  abandonImplementationTurn(directory, known);
  assert.deepEqual(activeImplementationModels(directory), []);
});

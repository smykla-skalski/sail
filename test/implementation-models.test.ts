import assert from 'node:assert/strict';
import test from 'node:test';
import { beginShipItRun, implementationModels } from '../src/lib/implementation-models.ts';

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

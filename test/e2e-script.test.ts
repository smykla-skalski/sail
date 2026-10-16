import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedScript } from './e2e-script.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = (script: string | ((...args: never[]) => unknown), ...args: unknown[]) =>
  new AsyncFunction(protectedScript(script))(...args);

await test('execute transport isolates arbitrary returned data from protocol errors', async () => {
  const value = { error: 'Fixture paused', value: 42, success: false, __wdio_error__: 'data' };
  assert.deepEqual(await execute('return arguments[0]', value), [value]);
  assert.deepEqual(await execute(async () => ({ error: 'async data' })), [{ error: 'async data' }]);
  assert.deepEqual(await execute('return null'), [null]);
  assert.deepEqual(await execute('return [1, 2]'), [[1, 2]]);
  assert.deepEqual(await execute(''), [undefined]);
  assert.deepEqual(await execute('return this.answer'), [undefined]);
  await assert.rejects(execute('throw new Error("genuine failure")'), /genuine failure/);
  await assert.rejects(
    execute(async () => {
      throw new Error('rejected promise');
    }),
    /rejected promise/,
  );
});

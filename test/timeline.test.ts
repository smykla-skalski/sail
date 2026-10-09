import assert from 'node:assert/strict';
import test from 'node:test';
import { nearBottom } from '../src/lib/timeline.ts';

await test('follow only when within the bottom threshold', () => {
  assert.equal(nearBottom({ scrollHeight: 500, scrollTop: 210, clientHeight: 200 }), false);
  assert.equal(nearBottom({ scrollHeight: 500, scrollTop: 230, clientHeight: 200 }), true);
});

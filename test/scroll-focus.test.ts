import assert from 'node:assert/strict';
import test from 'node:test';
import { overflows } from '../src/lib/scroll-focus.ts';

void test('a transcript joins the tab order only when its content overflows', () => {
  assert.equal(overflows(400, 400), false);
  assert.equal(overflows(401, 400), false);
  assert.equal(overflows(2000, 400), true);
  assert.equal(overflows(0, 0), false);
});

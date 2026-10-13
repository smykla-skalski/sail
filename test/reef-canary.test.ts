import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReefCanaryPercent, reefCanarySettingKey } from '../src/lib/reef-canary.ts';

void test('Reef canary defaults off and keeps a zero-percent control baseline distinct', () => {
  assert.equal(reefCanarySettingKey, 'sai-reef-canary-percent');
  assert.equal(parseReefCanaryPercent(null), null);
  assert.equal(parseReefCanaryPercent('off'), null);
  assert.equal(parseReefCanaryPercent('0'), 0);
  assert.equal(parseReefCanaryPercent('10'), 10);
  assert.equal(parseReefCanaryPercent('100'), 100);
});

void test('invalid canary values do not silently enable treatment in the UI', () => {
  for (const value of ['', '-1', '1.5', '010', '101', 'yes'])
    assert.equal(parseReefCanaryPercent(value), null);
});

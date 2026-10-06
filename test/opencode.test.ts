import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compatibleOpenCodeVersion, OPENCODE_VERSION } from '../src/lib/opencode.ts';

await test('OpenCode server matches the generated client contract exactly', () => {
  assert.equal(OPENCODE_VERSION, '2.0.24');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.dependencies['@opencode/client'], OPENCODE_VERSION);
  assert.equal(compatibleOpenCodeVersion('2.0.24'), true);
  assert.equal(compatibleOpenCodeVersion('2.0.22'), false);
  assert.equal(compatibleOpenCodeVersion('2.1.0'), false);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { e2eIdentity } from '../scripts/e2e-identity.mjs';

await test('every E2E build gets a private identity', () => {
  const release = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const base = JSON.parse(readFileSync('src-tauri/tauri.e2e.conf.json', 'utf8'));
  const first = e2eIdentity();
  const second = e2eIdentity();

  assert.notEqual(base.identifier, release.identifier);
  assert.notEqual(base.productName, release.productName);
  assert.notEqual(first.identifier, release.identifier);
  assert.notEqual(first.identifier, second.identifier);
  assert.notEqual(first.productName, second.productName);
  assert.match(first.identifier, /^dev\.smykla\.sail\.e2e\.[a-f0-9]{32}$/);
});

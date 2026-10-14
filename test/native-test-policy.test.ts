import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  artifactKey,
  artifactMatches,
  nativeEnvironment,
  nativeVerdict,
  setupAttemptLimit,
} from '../scripts/native-test-policy.mjs';

await test('setup attempts are finite and reject malformed limits', () => {
  assert.equal(setupAttemptLimit(), 2);
  assert.equal(setupAttemptLimit('5'), 5);
  for (const invalid of ['0', '6', '-1', '1.5', 'Infinity', '', '01'])
    assert.throws(() => setupAttemptLimit(invalid), /must be 1–5/);
});

await test('exit success cannot produce PASS before every native precondition passes', () => {
  assert.equal(nativeVerdict(0, null), 'SETUP_FAILED');
  assert.equal(nativeVerdict(0, { status: 'failed' }), 'SETUP_FAILED');
  assert.equal(nativeVerdict(0, { status: 'ready' }), 'PASS');
  assert.equal(nativeVerdict(1, { status: 'ready' }), 'FAIL');
  assert.equal(nativeVerdict(0, { status: 'ready' }, true), 'CANCELLED');
});

await test('artifact reuse rejects source, toolchain, signature, identity and binary changes', () => {
  const requirements = { revision: 'a', rust: '1', signing: 'ad-hoc', sourceHash: 'original' };
  const identifier = `dev.smykla.sail.e2e.${'a'.repeat(32)}`;
  const manifest = { key: artifactKey(requirements), binaryHash: 'binary', identifier };
  assert.equal(artifactMatches(manifest, requirements, 'binary', identifier, true), true);
  for (const field of Object.keys(requirements))
    assert.equal(
      artifactMatches(
        manifest,
        { ...requirements, [field]: 'changed' },
        'binary',
        identifier,
        true,
      ),
      false,
    );
  assert.equal(artifactMatches(manifest, requirements, 'modified', identifier, true), false);
  assert.equal(artifactMatches(manifest, requirements, 'binary', identifier, false), false);
  assert.equal(artifactMatches(manifest, requirements, 'binary', 'dev.smykla.sail', true), false);
});

await test('sequential runs canonicalize aliases and isolate every fixture path', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'sail-native-policy-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const alias = join(root, 'alias');
  symlinkSync(realpathSync(root), alias, 'dir');
  const inherited = {
    SAIL_E2E_CONFIG_DIR: '/user/config',
    XDG_DATA_HOME: '/user/data',
    SAIL_HOOK_CONNECTION_FILE: '/owning-app/hook-connection.json',
  };
  const first = nativeEnvironment(join(alias, 'first'), process.cwd(), inherited, 12345);
  const second = nativeEnvironment(join(alias, 'second'), process.cwd(), inherited, 12346);
  for (const name of [
    'TMPDIR',
    'SAIL_E2E_CONFIG_DIR',
    'SAIL_WORKTREE_ROOT',
    'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'SAIL_E2E_FAKE_GH_DIR',
    'SAIL_E2E_FAKE_GH_BIN',
  ]) {
    assert.equal(first[name], realpathSync(first[name]));
    assert.notEqual(first[name], second[name]);
    assert.ok(first[name].startsWith(realpathSync(root)));
  }
  assert.ok(first.SAIL_E2E_CONFIG_DIR.startsWith(first.TMPDIR + '/'));
  assert.equal(first.TAURI_WEBDRIVER_PORT, '12345');
  assert.equal(first.SAIL_E2E_MACHINE_READING, 'healthy');
  assert.equal(inherited.SAIL_E2E_CONFIG_DIR, '/user/config');
  assert.equal(
    first.SAIL_HOOK_CONNECTION_FILE,
    join(realpathSync(root), 'first', 'hook-connection.json'),
  );
  assert.notEqual(first.SAIL_HOOK_CONNECTION_FILE, second.SAIL_HOOK_CONNECTION_FILE);
  assert.equal(inherited.SAIL_HOOK_CONNECTION_FILE, '/owning-app/hook-connection.json');
});

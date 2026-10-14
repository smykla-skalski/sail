import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

await test(
  'native toolchain precondition failures retain a diagnostic result before building',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'sail-native-preflight-'));
    const result = spawnSync(process.execPath, ['scripts/run-native-tests.mjs'], {
      encoding: 'utf8',
      timeout: 45_000,
      env: {
        ...process.env,
        SAIL_NATIVE_ROOT: root,
        SAIL_NATIVE_SETUP_ATTEMPTS: '2',
        DEVELOPER_DIR: join(root, 'missing-developer-directory'),
      },
    });
    assert.equal(result.status, 1, result.stderr);
    const run = result.stdout.match(/Native diagnostics: (.+)/)?.[1];
    assert.ok(run, result.stdout);
    const diagnostic = JSON.parse(readFileSync(join(run, 'result.json'), 'utf8'));
    assert.equal(diagnostic.verdict, 'SETUP_FAILED');
    assert.equal(diagnostic.phase, 'source/toolchain preflight');
    assert.match(diagnostic.error, /xcrun.*missing DEVELOPER_DIR path/s);
    assert.match(result.stdout, /SETUP_FAILED:/);
    assert.doesNotMatch(result.stdout, /\bPASS\b/);
  },
);

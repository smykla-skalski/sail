import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

await test('private gh fixtures fail closed until real integration is explicitly enabled', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'sail-fake-gh-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  const fixture = join(root, 'fixture');
  mkdirSync(real);
  mkdirSync(fixture);
  writeFileSync(join(real, 'gh'), '#!/bin/sh\nprintf "REAL_GH_SENTINEL\\n" >&2\nexit 73\n', {
    mode: 0o755,
  });
  const run = (args: string[], allow = '0') =>
    spawnSync(process.execPath, [new URL('./e2e/fake-gh.mjs', import.meta.url).pathname, ...args], {
      env: {
        ...process.env,
        PATH: real,
        SAIL_E2E_FAKE_GH_DIR: fixture,
        SAIL_E2E_FAKE_GH_BIN: join(root, 'bin'),
        SAIL_E2E_GH_ALLOW_REAL: allow,
      },
      encoding: 'utf8',
    });
  for (const state of [null, {}, { pulls: {} }]) {
    if (state !== null) writeFileSync(join(fixture, 'state.json'), JSON.stringify(state));
    const result = run(['auth', 'status']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Fake gh fixture has no response/);
    assert.doesNotMatch(result.stderr, /REAL_GH_SENTINEL/);
  }
  const fixtureResult = run(['repo', 'view']);
  assert.equal(fixtureResult.status, 0);
  assert.equal(JSON.parse(fixtureResult.stdout).nameWithOwner, 'fixture/repo');
  const integration = run(['auth', 'status'], '1');
  assert.equal(integration.status, 73);
  assert.match(integration.stderr, /REAL_GH_SENTINEL/);
});

import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPrivateE2eConfigRoot,
  isolatedPaths,
  privatePort,
  PrivateEndpointGuard,
} from './e2e-isolation.ts';

await test('attached runner rejects config roots outside its private temporary directory', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sail-e2e-isolation-'));
  const temporary = join(fixture, 'temporary');
  const outside = join(fixture, 'outside');
  mkdirSync(temporary);
  mkdirSync(outside);
  try {
    assert.doesNotThrow(() =>
      assertPrivateE2eConfigRoot(join(temporary, 'run', 'config'), temporary),
    );
    assert.throws(() => assertPrivateE2eConfigRoot(temporary, temporary), /inside/);
    assert.throws(() => assertPrivateE2eConfigRoot(outside, temporary), /inside/);
    assert.throws(() => assertPrivateE2eConfigRoot(join(temporary, '..', 'outside'), temporary));
    assert.throws(() => assertPrivateE2eConfigRoot('relative', temporary));
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(temporary, 'outside-link'));
      symlinkSync(join(fixture, 'missing'), join(temporary, 'dangling-link'));
      assert.throws(
        () => assertPrivateE2eConfigRoot(join(temporary, 'outside-link', 'config'), temporary),
        /inside/,
      );
      assert.throws(
        () => assertPrivateE2eConfigRoot(join(temporary, 'dangling-link', 'config'), temporary),
        /dangling symlink/,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

await test('private desktop runner rejects fallback and malformed ports without connecting', () => {
  for (const value of [undefined, '', '4445', '0', '1023', '65536', '50000junk', '5e4', '-1'])
    assert.throws(() => privatePort(value));
  assert.equal(privatePort('53063'), 53063);
});

await test('runner fails before service initialization when either endpoint differs', () => {
  const saved = process.env.TAURI_WEBDRIVER_PORT;
  process.env.TAURI_WEBDRIVER_PORT = '53063';
  try {
    const options = { port: 53063 };
    const config = { port: 53063, hostname: '127.0.0.1' };
    assert.doesNotThrow(() => new PrivateEndpointGuard(options, [{}], config));
    for (const override of [
      { port: 53064 },
      { port: 4445 },
      { hostname: 'example.test' },
      { 'tauri:options': { embeddedPort: 53064 } },
    ]) {
      assert.throws(() => new PrivateEndpointGuard(options, [override], config));
      assert.throws(() => new PrivateEndpointGuard(options, {}, { ...config, ...override }));
    }
    process.env.TAURI_WEBDRIVER_PORT = '53064';
    assert.throws(() => new PrivateEndpointGuard(options, {}, config));
    delete process.env.TAURI_WEBDRIVER_PORT;
    assert.throws(() => new PrivateEndpointGuard(options, {}, config));
  } finally {
    if (saved === undefined) delete process.env.TAURI_WEBDRIVER_PORT;
    else process.env.TAURI_WEBDRIVER_PORT = saved;
  }
});

await test('regular runs discard caller state paths; attach requires explicit paths', () => {
  const regular = isolatedPaths('/private/test', false, {
    XDG_CONFIG_HOME: '/caller/config',
    SAIL_WORKTREE_ROOT: '/caller/worktrees',
  });
  assert.equal(regular.XDG_CONFIG_HOME, '/private/test/config');
  assert.equal(regular.SAIL_WORKTREE_ROOT, '/private/test/worktrees');
  const attached = isolatedPaths('/unused', true, regular);
  assert.deepEqual(attached, regular);
  for (const name of Object.keys(regular)) {
    assert.throws(
      () => isolatedPaths('/unused', true, { ...regular, [name]: undefined }),
      /requires an explicit private/,
    );
    assert.throws(
      () => isolatedPaths('/unused', true, { ...regular, [name]: 'relative' }),
      /requires an explicit private/,
    );
  }
});

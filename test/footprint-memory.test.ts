import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

await test(
  'the native memory probe reads kernel counters and rejects invalid process IDs',
  {
    skip: process.platform !== 'darwin',
  },
  async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'sail-footprint-memory-test-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const binary = join(root, 'process-memory');
    const source = fileURLToPath(new URL('../scripts/macos-process-memory.c', import.meta.url));
    const build = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', source, '-o', binary], {
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, build.stderr);

    await context.test('a running process has resident memory and physical footprint', () => {
      const result = spawnSync(binary, [String(process.pid)], { encoding: 'utf8' });

      assert.equal(result.status, 0, result.stderr);
      const memory = JSON.parse(result.stdout);
      assert.ok(Number.isSafeInteger(memory.appRssBytes));
      assert.ok(memory.appRssBytes > 0);
      assert.ok(Number.isSafeInteger(memory.appFootprintBytes));
      assert.ok(memory.appFootprintBytes > 0);
    });

    await Promise.all(
      [
        { name: 'missing', args: [] },
        { name: 'empty', args: [''] },
        { name: 'zero', args: ['0'] },
        { name: 'negative', args: ['-1'] },
        { name: 'non-numeric', args: ['abc'] },
        { name: 'fractional', args: ['1.5'] },
        { name: 'overflow', args: ['9999999999999999999999999'] },
      ].map(({ name, args }) =>
        context.test(`rejects ${name} process ID`, () => {
          const result = spawnSync(binary, args, { encoding: 'utf8' });

          assert.equal(result.status, 2);
          assert.equal(result.stdout, '');
        }),
      ),
    );

    await context.test('a missing process fails instead of reporting zero memory', () => {
      const result = spawnSync(binary, ['2147483647'], { encoding: 'utf8' });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /proc_pid_rusage/);
      assert.equal(result.stdout, '');
    });
  },
);

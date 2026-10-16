import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const detector = workflow
  .match(/ {6}- name: Check Rust paths[\s\S]*? {8}run: \|\n((?: {10}.*\n)+)/)?.[1]
  .replaceAll(/^ {10}/gm, '');
assert.ok(detector);
const depth = workflow.match(/ {2}changes:[\s\S]*?fetch-depth: (\d+)/)?.[1];
assert.ok(depth);

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

await Promise.all(
  ['frontend', 'rust-add', 'rust-edit', 'rust-delete'].map((change) =>
    test(`shallow PR merge ref detects ${change} after base drift`, () => {
      const directory = mkdtempSync(
        join(process.env.SAIL_TEST_SCRATCH_ROOT ?? tmpdir(), 'sail-ci-detection-'),
      );
      const origin = join(directory, 'origin');
      const checkout = join(directory, 'checkout');
      try {
        mkdirSync(origin);
        git(origin, 'init');
        git(origin, 'config', 'user.name', 'CI fixture');
        git(origin, 'config', 'user.email', 'ci@example.test');
        mkdirSync(join(origin, 'src-tauri'));
        writeFileSync(join(origin, 'src-tauri', 'lib.rs'), 'initial\n');
        writeFileSync(join(origin, 'frontend.txt'), 'initial\n');
        function commit(...parents: string[]) {
          git(origin, 'add', '.');
          const tree = git(origin, 'write-tree');
          const revision = git(
            origin,
            'commit-tree',
            tree,
            ...parents.flatMap((parent) => ['-p', parent]),
            '-m',
            'fixture',
          );
          git(origin, 'update-ref', 'HEAD', revision);
          return revision;
        }
        const eventBase = commit();
        git(origin, 'checkout', eventBase);
        writeFileSync(join(origin, 'src-tauri', 'base-only.rs'), 'base drift\n');
        const mergeBase = commit(eventBase);
        git(origin, 'checkout', eventBase);
        if (change === 'rust-add') writeFileSync(join(origin, 'src-tauri', 'added.rs'), 'PR add\n');
        else if (change === 'rust-edit')
          writeFileSync(join(origin, 'src-tauri', 'lib.rs'), 'PR edit\n');
        else if (change === 'rust-delete') rmSync(join(origin, 'src-tauri', 'lib.rs'));
        else writeFileSync(join(origin, 'frontend.txt'), 'PR edit\n');
        const head = commit(eventBase);
        assert.equal(git(origin, 'ls-tree', head, '--', 'src-tauri/base-only.rs'), '');
        assert.ok(git(origin, 'ls-tree', mergeBase, '--', 'src-tauri/base-only.rs'));
        writeFileSync(join(origin, 'src-tauri', 'base-only.rs'), 'base drift\n');
        const merge = commit(mergeBase, head);
        git(origin, 'update-ref', 'refs/pull/1/merge', merge);
        mkdirSync(checkout);
        git(checkout, 'init');
        git(checkout, 'remote', 'add', 'origin', origin);
        git(checkout, 'fetch', '--no-tags', `--depth=${depth}`, 'origin', 'refs/pull/1/merge');
        git(checkout, 'checkout', 'FETCH_HEAD');
        assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), 'true');
        git(checkout, 'fetch', '--no-tags', '--depth=1', 'origin', eventBase);
        const oldDetection = spawnSync(
          'git',
          ['diff', '--quiet', eventBase, 'HEAD', '--', 'src-tauri'],
          { cwd: checkout },
        );
        assert.equal(
          oldDetection.status,
          1,
          'historical event-base comparison selects base-only Rust',
        );
        const output = join(directory, 'output');
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', detector], {
          cwd: checkout,
          env: { ...process.env, GITHUB_OUTPUT: output },
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8').trim(), `rust=${change !== 'frontend'}`);
        git(checkout, 'checkout', head);
        const invalid = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', detector], {
          cwd: checkout,
          env: { ...process.env, GITHUB_OUTPUT: output },
        });
        assert.notEqual(invalid.status, 0, 'non-merge refs fail closed');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
  ),
);

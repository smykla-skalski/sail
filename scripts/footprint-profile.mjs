import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Matches `.sail-scratch-root` in src-tauri/src/scratch_cleanup.rs: the owner is `<pid> <start>`.
export const scratchMarker = '.sail-scratch-root';
const staleAgeMs = 3 * 60 * 60 * 1000;

const fixtureGitConfig = [
  'user.name=Sail Footprint',
  'user.email=footprint@example.invalid',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'core.hooksPath=/dev/null',
].flatMap((setting) => ['-c', setting]);

function git(directory, args) {
  const result = spawnSync('git', [...fixtureGitConfig, ...args], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args[0]}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

const worktreeName = (index) => `footprint-wt-${String(index).padStart(2, '0')}`;

/**
 * A repository with `count` linked worktrees. Each worktree holds enough tracked files that
 * `git status` has real work to do without making the profile heavy.
 */
export function createWorktrees(root, count) {
  const repository = join(root, 'projects', 'footprint-project');
  mkdirSync(repository, { recursive: true });
  git(repository, ['init', '-q', '-b', 'main']);
  for (let directory = 0; directory < 8; directory += 1) {
    const folder = join(repository, 'src', `module-${directory}`);
    mkdirSync(folder, { recursive: true });
    for (let file = 0; file < 12; file += 1)
      writeFileSync(
        join(folder, `file-${file}.txt`),
        `module ${directory} file ${file}\n`.repeat(40),
      );
  }
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '-m', 'fixture']);
  const parent = join(root, 'worktrees');
  mkdirSync(parent, { recursive: true });
  const worktrees = [];
  for (let index = 1; index <= count; index += 1) {
    const name = worktreeName(index);
    const path = join(parent, name);
    git(repository, ['worktree', 'add', '-q', '-b', name, path]);
    worktrees.push({ path: realpathSync(path), branch: name });
  }
  return { repository: realpathSync(repository), worktrees };
}

/** The catalog and project selection a user with these worktrees would have saved. */
export function profileSettings({ repository, worktrees }) {
  return {
    'sai-directory': repository,
    'sai-project-catalog': JSON.stringify({
      repositories: [repository],
      groups: [],
      worktrees: { [repository]: worktrees },
    }),
  };
}

/**
 * Roots a dead agent left behind: marked with an owner that no longer runs, with every entry older
 * than the sweeper's two-hour idle age, so the startup sweep has to inspect and reclaim them.
 * `deadOwner` is the `<pid> <start>` text of an exited process.
 */
export function createStaleScratchRoots(temporary, count, deadOwner, now = Date.now()) {
  const old = new Date(now - staleAgeMs);
  const roots = [];
  for (let index = 1; index <= count; index += 1) {
    const root = join(temporary, `sail-footprint-stale-${String(index).padStart(3, '0')}`);
    mkdirSync(root);
    writeFileSync(join(root, scratchMarker), deadOwner);
    const entries = [join(root, scratchMarker)];
    for (let folder = 0; folder < 6; folder += 1) {
      const directory = join(root, 'build', `unit-${folder}`);
      mkdirSync(directory, { recursive: true });
      entries.push(directory);
      for (let file = 0; file < 20; file += 1) {
        const path = join(directory, `object-${file}.o`);
        writeFileSync(path, 'x'.repeat(2048));
        entries.push(path);
      }
    }
    entries.push(join(root, 'build'), root);
    for (const entry of entries) utimesSync(entry, old, old);
    roots.push(root);
  }
  return roots;
}

/** Unrelated entries a long-lived temporary directory accumulates; the sweep lists them all. */
export function createTemporaryClutter(temporary, count) {
  for (let index = 0; index < count; index += 1) {
    const path = join(temporary, `clutter-${index}`);
    if (index % 2 === 0) mkdirSync(path);
    else writeFileSync(path, 'x');
  }
}

/** An owner string for a process that has exited, so its roots count as abandoned. */
export function deadOwnerIdentity() {
  const finished = spawnSync(process.execPath, ['-e', '']);
  if (finished.error || finished.status !== 0) throw new Error('Could not start a short process');
  const pid = finished.pid;
  return `${pid} ${Math.floor(Date.now() / 1000) - 60}`;
}

export function privateRoot(base) {
  return realpathSync(mkdtempSync(join(base, 'sail-footprint-')));
}

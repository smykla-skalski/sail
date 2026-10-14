import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const directory = process.env.SAIL_E2E_SLOW_GIT_DIR;
const realGit = process.env.SAIL_E2E_REAL_GIT ?? '/usr/bin/git';
if (!isAbsolute(realGit)) throw new Error('SAIL_E2E_REAL_GIT must be an absolute executable path');

function marker(name) {
  if (!directory) return null;
  try {
    return readFileSync(join(directory, name), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

const path = marker('block-path');
const argument = marker('block-argument');
if (
  directory &&
  path &&
  (!argument || args.includes(argument)) &&
  args.some((arg, index) => arg === '-C' && args[index + 1] === path)
) {
  const active = join(directory, `active-${process.pid}`);
  const detail = JSON.stringify({ pid: process.pid, path, args });
  writeFileSync(active, detail);
  try {
    // Recheck after publishing ownership so releasing a gate cannot strand a late arrival.
    if (marker('block-path') === path && marker('block-argument') === argument) {
      writeFileSync(join(directory, 'blocked'), detail);
      const release = join(directory, 'release');
      const tick = new Int32Array(new SharedArrayBuffer(4));
      const deadline = performance.now() + 15_000;
      while (!existsSync(release) && performance.now() < deadline) Atomics.wait(tick, 0, 0, 20);
      if (!existsSync(release)) writeFileSync(join(directory, 'timed-out'), detail);
    }
  } finally {
    rmSync(active, { force: true });
  }
}

const result = spawnSync(realGit, args, { stdio: 'inherit', env: process.env });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);

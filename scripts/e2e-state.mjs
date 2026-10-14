import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const prefix = 'sail-e2e-';
const stateName = /^sail-e2e-[A-Za-z0-9]{6}$/;
const markerName = 'owner.json';
const unmarkedGraceMs = 2 * 60 * 60 * 1000;

/** The start time distinguishes the owner from an unrelated process that reuses its pid. */
export function processStart(pid) {
  if (process.platform === 'win32') return '';
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function processOwns(owner) {
  if (!owner || !Number.isInteger(owner.pid)) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') throw error;
  }
  return processStart(owner.pid) === owner.started;
}

/** Creates a WebdriverIO state folder that records which process owns it. */
export function createStateRoot(base) {
  const root = mkdtempSync(join(base, prefix));
  const marker = join(root, markerName);
  const owner = { pid: process.pid, started: processStart(process.pid) };
  writeFileSync(`${marker}.tmp`, JSON.stringify(owner));
  renameSync(`${marker}.tmp`, marker);
  return root;
}

function ownerOf(root) {
  try {
    return JSON.parse(readFileSync(join(root, markerName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Removes state folders whose owner exited, for example after SIGKILL. A folder without an owner
 * record predates the record or is still being created, so only an idle one is removed. A folder
 * that another sweeper removed first is skipped.
 */
export function sweepStateRoots(base, { now = Date.now(), owns = processOwns } = {}) {
  const removed = [];
  for (const name of readdirSync(base).filter((entry) => stateName.test(entry))) {
    const root = join(base, name);
    try {
      const owner = ownerOf(root);
      const abandoned = owner ? !owns(owner) : now - statSync(root).mtimeMs > unmarkedGraceMs;
      if (!abandoned) continue;
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed.push(root);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

export function removeStateRoot(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

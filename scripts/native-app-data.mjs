import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const identifierPattern = /^dev\.smykla\.sail\.e2e\.([a-f0-9]{32})$/;
const productNamePattern = /Sail E2E ([a-f0-9]{8})\.app\//g;

export function isRunIdentifier(name) {
  return identifierPattern.test(name);
}

/** Directories where macOS and WebKit create one folder per bundle identifier. */
export function runDataRoots({ home, userTemp, userCache }) {
  return [
    join(home, 'Library/Logs'),
    join(home, 'Library/Caches'),
    join(home, 'Library/WebKit'),
    join(home, 'Library/Application Support'),
    userTemp,
    userCache,
  ].filter(Boolean);
}

function darwinDirectory(name) {
  const result = spawnSync('getconf', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function systemRunDataRoots() {
  return runDataRoots({
    home: homedir(),
    userTemp: darwinDirectory('DARWIN_USER_TEMP_DIR'),
    userCache: darwinDirectory('DARWIN_USER_CACHE_DIR'),
  });
}

export function listProcessCommands() {
  const result = spawnSync('/bin/ps', ['-axo', 'command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`ps failed: ${result.error?.message ?? result.status}`);
  return result.stdout;
}

/**
 * A run's app is launched from `Sail E2E <first 8 id characters>.app`, so a process whose command
 * carries that bundle path proves the run is still in progress.
 */
export function liveRunTokens(processCommands) {
  return new Set([...processCommands.matchAll(productNamePattern)].map((match) => match[1]));
}

export function isRunLive(identifier, live) {
  const match = identifierPattern.exec(identifier);
  return Boolean(match) && live.has(match[1].slice(0, 8));
}

function listNames(root) {
  try {
    return readdirSync(root);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function removeFolder(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/** Folders under the given roots that belong to the identifier and still exist. */
export function runFolders(identifier, roots) {
  if (!isRunIdentifier(identifier)) throw new Error(`Not a native run identifier: ${identifier}`);
  return roots.map((root) => join(root, identifier)).filter((path) => existsSync(path));
}

/**
 * Removes one run's folders. WebKit helper processes can recreate data while the app exits, so a
 * second pass follows a short pause. Returns the folders that could not be removed; a failure never
 * stops the removal of the other folders.
 */
export async function removeRunData(identifier, roots, pause = 500) {
  for (const path of runFolders(identifier, roots)) removeFolder(path);
  await delay(pause);
  const leftovers = runFolders(identifier, roots);
  for (const path of leftovers) removeFolder(path);
  return runFolders(identifier, roots);
}

/**
 * Removes folders of every run whose app process no longer exists. Candidates are listed before the
 * process table is read, so a run that starts during the sweep is seen as live. A folder that cannot
 * be removed is reported in `failed` without stopping the sweep.
 */
export function sweepRunData(roots, readProcessCommands, keep = []) {
  const kept = new Set(keep);
  const candidates = roots.flatMap((root) =>
    listNames(root)
      .filter((name) => isRunIdentifier(name) && !kept.has(name))
      .map((name) => ({ name, path: join(root, name) })),
  );
  if (candidates.length === 0) return { removed: [], failed: [] };
  const live = liveRunTokens(readProcessCommands());
  const stale = candidates.filter(({ name }) => !isRunLive(name, live));
  const removed = [];
  const failed = [];
  for (const { path } of stale) (removeFolder(path) ? removed : failed).push(path);
  return { removed, failed };
}

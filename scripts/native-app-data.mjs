import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const identifierPattern = /^dev\.smykla\.sail\.e2e\.([a-f0-9]{32})$/;
const productNamePattern = /Sail E2E ([a-f0-9]{8})\.app\//g;
const appPathPattern = /^(\/.*?Sail E2E [a-f0-9]{8}\.app)\/Contents\/MacOS\//gm;
export const buildIdentifierKey = 'SailE2EBuildIdentifier';

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

/** Identifiers a live app was built or bundled with, read from its Info.plist. */
export function bundleIdentifiers(app) {
  return ['CFBundleIdentifier', buildIdentifierKey].flatMap((key) => {
    const result = spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', `Print :${key}`, join(app, 'Contents/Info.plist')],
      {
        encoding: 'utf8',
      },
    );
    return result.status === 0 ? [result.stdout.trim()] : [];
  });
}

/**
 * Everything a live run protects: its token, its bundle identifier and the build identifier its
 * app resolves log and data folders from. An app without a recorded build identifier (an older
 * runner, or an unreadable plist) leaves `unresolved` set, because any folder could be its own.
 */
export function liveProtection(processCommands, readBundleIdentifiers = bundleIdentifiers) {
  const apps = new Set([...processCommands.matchAll(appPathPattern)].map((match) => match[1]));
  const read = [...apps].map((app) => readBundleIdentifiers(app));
  return {
    tokens: liveRunTokens(processCommands),
    identifiers: new Set(read.flat()),
    unresolved: read.some((identifiers) => identifiers.length < 2),
  };
}

function isProtected(identifier, protection) {
  return isRunLive(identifier, protection.tokens) || protection.identifiers.has(identifier);
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
 * The app resolves its log and data folders from the identifier compiled into the build, which a
 * cached artifact shares between runs. Those folders stay while a live app was built with them or
 * while a live app does not say which build it came from. The process table is read again right
 * before the removal, and there is no second pass, so a run that just started keeps its folders.
 */
export async function removeIdleBuildData(
  identifier,
  roots,
  readProcessCommands,
  readBundleIdentifiers = bundleIdentifiers,
) {
  const idle = () => {
    const protection = liveProtection(readProcessCommands(), readBundleIdentifiers);
    return !protection.unresolved && !isProtected(identifier, protection);
  };
  if (!idle() || !idle()) return [];
  for (const path of runFolders(identifier, roots)) removeFolder(path);
  return runFolders(identifier, roots);
}

/**
 * Removes folders of every run whose app process no longer exists. Candidates are listed before the
 * process table is read, which is read again right before the removal, so a run that starts during
 * the sweep is seen as live. While a live app does not record its build identifier, only folders
 * that also exist in the WebKit folder, which holds data of run identifiers alone, are removed. A
 * folder that cannot be removed is reported in `failed` without stopping the sweep.
 */
export function sweepRunData(
  roots,
  readProcessCommands,
  keep = [],
  readBundleIdentifiers = bundleIdentifiers,
) {
  const kept = new Set(keep);
  const candidates = roots.flatMap((root) =>
    listNames(root)
      .filter((name) => isRunIdentifier(name) && !kept.has(name))
      .map((name) => ({ name, path: join(root, name) })),
  );
  if (candidates.length === 0) return { removed: [], failed: [] };
  const webKit = roots.find((root) => basename(root) === 'WebKit');
  const staleNow = (list) => {
    const protection = liveProtection(readProcessCommands(), readBundleIdentifiers);
    return list.filter(
      ({ name }) =>
        !isProtected(name, protection) &&
        (!protection.unresolved || (webKit !== undefined && existsSync(join(webKit, name)))),
    );
  };
  const stale = staleNow(staleNow(candidates));
  const removed = [];
  const failed = [];
  for (const { path } of stale) (removeFolder(path) ? removed : failed).push(path);
  return { removed, failed };
}

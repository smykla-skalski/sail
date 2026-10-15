import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { processOwns, processStart } from './e2e-state.mjs';
import { userTemporaryDirectory } from './native-app-data.mjs';

const recordName = /^[A-Za-z0-9._-]+\.json$/;
const corruptGraceMs = 2 * 60 * 60 * 1000;

/**
 * Native runs register their runner, app and command groups here so that a later run can stop what
 * a runner killed with SIGKILL left behind. The folder is per user, not per TMPDIR, because
 * isolated runs use private temporary directories but share one machine.
 */
export function runRegistryDirectory(env = process.env) {
  const configured = env.SAIL_NATIVE_RUN_REGISTRY;
  if (configured) {
    if (!isAbsolute(configured))
      throw new Error('SAIL_NATIVE_RUN_REGISTRY must be an absolute directory');
    return configured;
  }
  const userTemporary = userTemporaryDirectory();
  if (!userTemporary)
    throw new Error('The per-user temporary folder is unknown; set SAIL_NATIVE_RUN_REGISTRY');
  return join(userTemporary, 'sail-native-runs');
}

function writeRecord(path, record) {
  writeFileSync(`${path}.tmp`, JSON.stringify(record));
  renameSync(`${path}.tmp`, path);
}

/** Records the current process as the owner of one run and returns the handle that updates it. */
export function registerRun(registry, id) {
  mkdirSync(registry, { recursive: true });
  const path = join(registry, `${id}.json`);
  const record = {
    id,
    runner: { pid: process.pid, started: processStart(process.pid) ?? null },
    binary: null,
    groups: [],
  };
  writeRecord(path, record);
  const save = () => writeRecord(path, record);
  return {
    path,
    record,
    /** The app executable the run launches with `open`, which leaves it outside the runner's tree. */
    setBinary(binary) {
      record.binary = binary;
      save();
    },
    /** Hooks for `runOwnedCommand`, which starts each command as the leader of its own group. */
    groupHooks: () => ({
      onStart(pid) {
        record.groups.push({ pid, started: processStart(pid) ?? null });
        save();
      },
      onExit(pid) {
        record.groups = record.groups.filter((group) => group.pid !== pid);
        save();
      },
    }),
    release() {
      rmSync(path, { force: true });
      rmSync(`${path}.tmp`, { force: true });
    },
  };
}

const unregistered = {
  path: null,
  record: null,
  setBinary() {},
  groupHooks: () => ({}),
  release() {},
};

/**
 * Registration is best effort: a registry that cannot be written costs the next run its cleanup of
 * this run, never this run itself. A failure is reported once and the handle does nothing.
 */
export function registerRunIfPossible(resolveRegistry, id, report) {
  try {
    return registerRun(resolveRegistry(), id);
  } catch (error) {
    report(`Run registry unavailable, a killed runner will leave processes: ${error.message}`);
    return unregistered;
  }
}

function groupMembers() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]) }] : [];
  });
}

// A group id of 0 or 1 turns `kill(-pgid)` into a signal to the caller's own group or, with -1, to
// every process the user owns.
const signalableGroup = (pgid) => Number.isSafeInteger(pgid) && pgid > 1;

export function signalGroup(pgid, signal, kill = (pid, name) => process.kill(pid, name)) {
  if (!signalableGroup(pgid)) throw new RangeError(`Refusing to signal process group ${pgid}`);
  try {
    kill(-pgid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * Stops the members of a command group whose runner died. A group id cannot be reused while a
 * member lives, so a group with a dead leader is still the recorded one; a living leader must also
 * carry the recorded start time, or the recorded group is gone and its pid belongs to a stranger.
 * A living leader without a recorded start time cannot be told from a stranger, so it is left alone.
 * Returns true when no member remains and false when that cannot be established.
 */
async function reapGroup(group, { readStart, readMembers, pause, kill }) {
  const leader = readStart(group.pid);
  if (leader === undefined) return false;
  if (leader !== null && group.started == null) return false;
  if (leader !== null && leader !== group.started) return true;
  const alive = () => {
    const members = readMembers();
    return members === undefined ? undefined : members.some((member) => member.pgid === group.pid);
  };
  const escalate = async (signals) => {
    const running = alive();
    if (running === undefined) return false;
    if (!running) return true;
    if (signals.length === 0) return false;
    signalGroup(group.pid, signals[0], kill);
    await pause();
    return escalate(signals.slice(1));
  };
  return escalate(['SIGTERM', 'SIGKILL']);
}

function readRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!record || !Number.isInteger(record.runner?.pid) || !Array.isArray(record.groups))
      return null;
    if (!record.groups.every((group) => signalableGroup(group?.pid))) return null;
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Stops the app and the command groups of every registered run whose runner no longer exists, then
 * forgets the run. A run whose runner still lives is left alone, and so is any run whose owner
 * cannot be checked. An unreadable record names nothing to stop, so only an old one is cleared.
 * `stopApp` and `appProcesses` come from `nativeApp`.
 */
export async function reapDeadRuns(
  registry,
  {
    stopApp,
    appProcesses,
    owns = processOwns,
    readStart = processStart,
    readMembers = groupMembers,
    pause = () => delay(1000),
    kill,
    now = Date.now(),
  },
) {
  let names;
  try {
    names = readdirSync(registry).filter((name) => recordName.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return { reaped: [], kept: [], failed: [] };
    throw error;
  }
  const reapOne = async (name) => {
    const path = join(registry, name);
    try {
      const record = readRecord(path);
      if (record === undefined) return null;
      if (record === null) {
        if (now - statSync(path).mtimeMs > corruptGraceMs) rmSync(path, { force: true });
        return { outcome: 'failed', id: path };
      }
      if (owns(record.runner)) return { outcome: 'kept', id: record.id };
      const groups = await Promise.all(
        record.groups.map((group) => reapGroup(group, { readStart, readMembers, pause, kill })),
      );
      if (record.binary) await stopApp(record.binary);
      const appGone = !record.binary || appProcesses(record.binary).length === 0;
      if (!groups.every(Boolean) || !appGone) return { outcome: 'failed', id: record.id };
      rmSync(path, { force: true });
      return { outcome: 'reaped', id: record.id };
    } catch (error) {
      return error.code === 'ENOENT' ? null : { outcome: 'failed', id: path };
    }
  };
  const results = (await Promise.all(names.map(reapOne))).filter(Boolean);
  const ids = (outcome) =>
    results.filter((result) => result.outcome === outcome).map(({ id }) => id);
  return { reaped: ids('reaped'), kept: ids('kept'), failed: ids('failed') };
}

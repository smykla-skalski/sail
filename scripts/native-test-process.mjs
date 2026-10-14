import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

export async function runOwnedCommand(program, args, { cwd, env, log, signal }) {
  if (signal.aborted) throw new Error('Native run cancelled');
  const output = [];
  const child = spawn(program, args, { cwd, env, detached: true });
  const signalGroup = (value) => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, value);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return false;
    }
  };
  let killTimer;
  const cancel = () => {
    signalGroup('SIGTERM');
    killTimer ??= setTimeout(() => signalGroup('SIGKILL'), 1000);
  };
  signal.addEventListener('abort', cancel, { once: true });
  child.stdout.on('data', (data) => output.push(data));
  child.stderr.on('data', (data) => output.push(data));
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (signal.aborted) cancel();
    return await exited;
  } finally {
    signal.removeEventListener('abort', cancel);
    // The detached group remains owned after its leader exits.
    if (signalGroup('SIGTERM')) {
      await delay(1000);
      signalGroup('SIGKILL');
    }
    clearTimeout(killTimer);
    await Promise.race([closed, delay(1000)]);
    writeFileSync(log, Buffer.concat(output));
  }
}

// `open -n` leaves the fixture app running with PPID 1 when a run fails before
// it learns the listening pid, so match processes by their executable path.
export async function stopProcessesUnder(directory, { timeout = 5000 } = {}) {
  const roots = new Set([directory]);
  try {
    roots.add(realpathSync(directory));
  } catch {
    /* The bundle is already gone; its launch path still identifies the process. */
  }
  const prefixes = [...roots].map((root) => (root.endsWith('/') ? root : `${root}/`));
  const running = () =>
    execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        const pid = Number(match?.[1]);
        return match &&
          pid !== process.pid &&
          prefixes.some((prefix) => match[2].startsWith(prefix))
          ? [pid]
          : [];
      });
  const waitUntilGone = async (deadline) => {
    if (running().length === 0 || Date.now() >= deadline) return running().length === 0;
    await delay(100);
    return waitUntilGone(deadline);
  };
  const stop = async (signals) => {
    const pids = running();
    if (pids.length === 0 || signals.length === 0) return pids.length === 0;
    for (const pid of pids) {
      try {
        process.kill(pid, signals[0]);
      } catch {
        /* Already exited. */
      }
    }
    return (await waitUntilGone(Date.now() + timeout)) || stop(signals.slice(1));
  };
  return stop(['SIGTERM', 'SIGKILL']);
}

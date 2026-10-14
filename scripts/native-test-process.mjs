import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

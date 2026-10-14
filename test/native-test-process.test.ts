import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand } from '../scripts/native-test-process.mjs';

await test(
  'cancellation reaps an owned descendant after its command leader exits',
  { skip: process.platform === 'win32' },
  async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'sail-owned-command-'));
    const pidFile = join(root, 'descendant.pid');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    context.after(() => unrelated.kill());
    const controller = new AbortController();
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
    const result = runOwnedCommand(process.execPath, ['-e', parent], {
      cwd: root,
      env: process.env,
      log: join(root, 'command.log'),
      signal: controller.signal,
    });
    const waitForPid = async (deadline: number): Promise<void> => {
      if (existsSync(pidFile)) return;
      if (Date.now() >= deadline) throw new Error('Owned descendant did not start');
      await delay(20);
      return waitForPid(deadline);
    };
    context.after(async () => {
      controller.abort();
      await result;
    });
    await waitForPid(Date.now() + 5000);
    const ownedPid = Number(readFileSync(pidFile, 'utf8'));
    context.after(() => {
      try {
        process.kill(ownedPid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    });
    controller.abort();
    assert.equal(await result, 0);
    await delay(200);
    assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.ok(existsSync(join(root, 'command.log')));
  },
);

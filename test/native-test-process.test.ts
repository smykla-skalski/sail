import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand, stopProcessesUnder } from '../scripts/native-test-process.mjs';

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

await test(
  'a leftover fixture app is stopped by its bundle path and others are kept',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'sail-fixture-stop-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const binary = join(root, 'run/Sail Native Fixture.app/Contents/MacOS/sail');
    mkdirSync(join(root, 'run/Sail Native Fixture.app/Contents/MacOS'), { recursive: true });
    copyFileSync('/bin/sleep', binary);
    // A copied system binary fails signature validation at exec.
    execFileSync('codesign', ['-f', '-s', '-', binary]);
    const launch = (program: string) => {
      const pid = Number(
        execFileSync('/bin/sh', ['-c', '"$0" 300 >/dev/null 2>&1 & echo $!', program], {
          encoding: 'utf8',
        }),
      );
      context.after(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      });
      return pid;
    };
    const leftover = launch(binary);
    const unrelated = launch('/bin/sleep');
    assert.doesNotThrow(() => process.kill(leftover, 0));
    assert.equal(await stopProcessesUnder(join(root, 'run/Sail Native Fixture.app')), true);
    assert.throws(() => process.kill(leftover, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(unrelated, 0));
  },
);

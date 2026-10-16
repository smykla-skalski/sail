import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nativeApp } from '../scripts/native-app.mjs';

await test('aliased executables match only the same file and cleanup retains identity checks', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'sail-native-alias-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'real'));
  const binary = join(root, 'real', 'sail');
  writeFileSync(binary, 'private executable');
  symlinkSync(join(root, 'real'), join(root, 'alias'));
  const alias = join(root, 'alias', 'sail');
  const signals: Array<[number, string]> = [];
  let identityReads = 0;
  const app = nativeApp({
    checkout: root,
    listing: (columns: string) =>
      columns === 'pid=,command='
        ? `900 ${realpathSync(binary)}\n901 ${realpathSync(binary)} --unrelated\n902 /another/sail`
        : '900 1\n910 900\n901 1\n902 1',
    identity: (pid: number) => (pid === 910 ? `changed-${identityReads++}` : 'stable'),
    kill: (pid: number, signal: string) => signals.push([pid, signal]),
  });
  assert.deepEqual(app.appProcesses(alias), [900]);
  assert.deepEqual(app.appProcesses(binary), [900]);
  unlinkSync(join(root, 'alias'));
  mkdirSync(join(root, 'other'));
  writeFileSync(join(root, 'other', 'sail'), 'unrelated executable');
  symlinkSync(join(root, 'other'), join(root, 'alias'));
  assert.deepEqual(app.appProcesses(alias), [900]);
  await app.stopApp(alias);
  assert.deepEqual(signals, [
    [900, 'SIGTERM'],
    [900, 'SIGKILL'],
  ]);
});

await test(
  'retargeting a launch alias cannot claim an unrelated running executable',
  {
    skip: process.platform !== 'darwin',
  },
  async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'sail-native-retarget-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const alias = join(root, 'launch');
    symlinkSync('/bin/cat', alias);
    const child = spawn(alias, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    context.after(() => child.kill());
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const signals: Array<[number, string]> = [];
    const app = nativeApp({
      checkout: root,
      kill: (pid: number, signal: string) => signals.push([pid, signal]),
    });
    assert.deepEqual(app.appProcesses(alias), []);
    unlinkSync(alias);
    symlinkSync('/bin/sleep', alias);
    assert.equal(app.appProcesses('/bin/sleep').includes(child.pid), false);
    await app.stopApp('/bin/sleep');
    assert.deepEqual(signals, []);
  },
);

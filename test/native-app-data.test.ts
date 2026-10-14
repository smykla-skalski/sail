import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  isRunIdentifier,
  isRunLive,
  listProcessCommands,
  liveRunTokens,
  removeRunData,
  runDataRoots,
  sweepRunData,
} from '../scripts/native-app-data.mjs';

const identifier = (prefix: string) =>
  `dev.smykla.sail.e2e.${prefix}${'0'.repeat(32 - prefix.length)}`;
const appPath = (id: string) => `/tmp/run/Sail E2E ${id.slice(-32, -24)}.app/Contents/MacOS/sail`;

function fixture(context: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'sail-app-data-test-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  const roots = ['Logs', 'Caches', 'WebKit', 'Application Support', 'temp', 'cache'].map((name) =>
    join(base, name),
  );
  for (const root of roots) mkdirSync(root);
  const populate = (name: string) => {
    for (const root of roots) mkdirSync(join(root, name, 'nested'), { recursive: true });
  };
  return {
    roots,
    populate,
    remaining: (name: string) => roots.filter((r) => existsSync(join(r, name))),
  };
}

await test('run data lives in the Library, temporary and cache folders of the user', () => {
  const roots = runDataRoots({ home: '/home/u', userTemp: '/var/T', userCache: '/var/C' });
  assert.deepEqual(roots, [
    '/home/u/Library/Logs',
    '/home/u/Library/Caches',
    '/home/u/Library/WebKit',
    '/home/u/Library/Application Support',
    '/var/T',
    '/var/C',
  ]);
});

await test('only generated run identifiers are recognised', () => {
  assert.equal(isRunIdentifier(identifier('a')), true);
  for (const other of [
    'dev.smykla.sail.e2e.fiximages9e79940',
    'dev.smykla.sail',
    `dev.smykla.sail.e2e.${'A'.repeat(32)}`,
    `dev.smykla.sail.e2e.${'a'.repeat(32)}.context-supervisor`,
    `${identifier('a')}x`,
  ])
    assert.equal(isRunIdentifier(other), false, other);
});

await test('a process started from the run app marks that run live', () => {
  const live = identifier('abcdef01');
  const processes = [
    '/usr/bin/some-tool --flag',
    appPath(live),
    '/Applications/Sail.app/Contents/MacOS/sail',
  ].join('\n');
  assert.deepEqual([...liveRunTokens(processes)], ['abcdef01']);
  assert.equal(isRunLive(live, liveRunTokens(processes)), true);
  assert.equal(isRunLive(identifier('abcdef02'), liveRunTokens(processes)), false);
});

await test('a sweep removes dead runs, keeps live runs and ignores other folders', (context) => {
  const { roots, populate, remaining } = fixture(context);
  const dead = identifier('d1');
  const live = identifier('a1');
  const current = identifier('c1');
  const unrelated = ['dev.smykla.sail.e2e.fiximages9e79940', 'com.apple.WebKit', 'sail-keep'];
  for (const name of [dead, live, current, ...unrelated]) populate(name);

  const removed = sweepRunData(roots, () => appPath(live), [current]);

  assert.equal(removed.length, roots.length);
  assert.deepEqual(remaining(dead), []);
  assert.deepEqual(remaining(live), roots);
  assert.deepEqual(remaining(current), roots);
  for (const name of unrelated) assert.deepEqual(remaining(name), roots);
});

await test('a sweep reads the process table after listing folders', (context) => {
  const { roots, populate } = fixture(context);
  const events: string[] = [];
  populate(identifier('a2'));
  const removed = sweepRunData(roots, () => {
    events.push('processes');
    return '';
  });
  assert.deepEqual(events, ['processes']);
  assert.equal(removed.length, roots.length);
  assert.deepEqual(
    sweepRunData(roots, () => assert.fail('nothing to check')),
    [],
  );
});

await test('a sweep follows a real process until it exits', async (context) => {
  const { roots, populate, remaining } = fixture(context);
  const run = identifier('b2');
  populate(run);
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', appPath(run)], {
    stdio: 'ignore',
  });
  context.after(() => holder.kill('SIGKILL'));
  await delay(200);

  assert.deepEqual(sweepRunData(roots, listProcessCommands), []);
  assert.deepEqual(remaining(run), roots);

  const exited = new Promise((resolve) => holder.once('exit', resolve));
  holder.kill('SIGKILL');
  await exited;
  assert.equal(sweepRunData(roots, listProcessCommands).length, roots.length);
  assert.deepEqual(remaining(run), []);
});

await test('finishing a run removes only its own folders', async (context) => {
  const { roots, populate, remaining } = fixture(context);
  const finished = identifier('e3');
  const sibling = identifier('f3');
  populate(finished);
  populate(sibling);

  assert.deepEqual(await removeRunData(finished, roots, 0), []);

  assert.deepEqual(remaining(finished), []);
  assert.deepEqual(remaining(sibling), roots);
  await assert.rejects(() => removeRunData('dev.smykla.sail', roots, 0), /Not a native run/);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createStateRoot,
  processOwns,
  processStart,
  sweepStateRoots,
} from '../scripts/e2e-state.mjs';

const stateModule = new URL('../scripts/e2e-state.mjs', import.meta.url).href;

function privateBase(context: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'sail-state-test-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

async function startRunner(base: string, context: test.TestContext, env = process.env) {
  const script = `import { createStateRoot } from ${JSON.stringify(stateModule)};
    console.log(createStateRoot(${JSON.stringify(base)}));
    setInterval(() => {}, 1000);`;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env,
  });
  context.after(() => runner.kill('SIGKILL'));
  const root = await new Promise<string>((resolve, reject) => {
    runner.once('error', reject);
    runner.stdout.once('data', (data) => resolve(String(data).trim()));
  });
  const exited = () => new Promise((resolve) => runner.once('exit', resolve));
  return { root, runner, exited };
}

await test('a killed runner leaves its state until the next sweep removes it', async (context) => {
  const base = privateBase(context);
  const killed = await startRunner(base, context);
  const running = await startRunner(base, context);
  const own = createStateRoot(base);

  const waiting = killed.exited();
  killed.runner.kill('SIGKILL');
  await waiting;
  assert.ok(existsSync(killed.root));

  assert.deepEqual(sweepStateRoots(base), { removed: [killed.root], failed: [] });

  assert.equal(existsSync(killed.root), false);
  assert.ok(existsSync(running.root));
  assert.ok(existsSync(own));
});

await test('a state folder without an owner record is removed only when idle', (context) => {
  const base = privateBase(context);
  const fresh = join(base, 'sail-e2e-fresh1');
  const idle = join(base, 'sail-e2e-idle02');
  mkdirSync(fresh);
  mkdirSync(idle);
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(idle, longAgo, longAgo);

  assert.deepEqual(sweepStateRoots(base), { removed: [idle], failed: [] });
  assert.ok(existsSync(fresh));
});

await test('a sweep leaves other sail folders alone', (context) => {
  const base = privateBase(context);
  const others = ['sail-e2e-limit-test-abc123', 'sail-e2e-context-xyz789', 'sail-native-abc123'];
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const name of others) {
    mkdirSync(join(base, name));
    utimesSync(join(base, name), longAgo, longAgo);
  }

  assert.deepEqual(sweepStateRoots(base), { removed: [], failed: [] });
  for (const name of others) assert.ok(existsSync(join(base, name)));
});

await test(
  'an owner in another time zone is still recognised as running',
  { skip: process.platform === 'win32' },
  async (context) => {
    const base = privateBase(context);
    const owner = await startRunner(base, context, {
      ...process.env,
      TZ: 'Pacific/Auckland',
      LC_ALL: 'de_DE.UTF-8',
    });

    assert.deepEqual(sweepStateRoots(base), { removed: [], failed: [] });
    assert.ok(existsSync(owner.root));
    assert.equal(typeof processStart(owner.runner.pid), 'string');
  },
);

await test('an owner whose process cannot be checked counts as running', () => {
  const owner = { pid: process.pid, started: 'Mon Jan  1 00:00:00 2024' };
  assert.equal(
    processOwns(owner, () => undefined),
    true,
  );
  assert.equal(
    processOwns({ pid: process.pid, started: null }, () => 'anything'),
    true,
  );
  assert.equal(
    processOwns(owner, () => 'Tue Jan  2 00:00:00 2024'),
    false,
  );
  assert.equal(
    processOwns({ pid: 2 ** 22 + 1, started: 'x' }, () => undefined),
    false,
  );
});

await test('only folders holding WebdriverIO state are removed without an owner record', (context) => {
  const base = privateBase(context);
  const state = join(base, 'sail-e2e-state1');
  const user = join(base, 'sail-e2e-config');
  for (const root of [state, user]) mkdirSync(join(root, 'worktrees'), { recursive: true });
  writeFileSync(join(user, 'notes.txt'), '');
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const root of [state, user]) utimesSync(root, longAgo, longAgo);

  assert.deepEqual(sweepStateRoots(base), { removed: [state], failed: [] });
  assert.ok(existsSync(user));
});

await test(
  'a state folder that cannot be removed does not stop the sweep',
  { skip: process.platform === 'win32' },
  (context) => {
    const base = privateBase(context);
    const roots = ['sail-e2e-aaaaaa', 'sail-e2e-bbbbbb'].map((name) => join(base, name));
    for (const root of roots) {
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 1, started: 'x' }));
    }
    writeFileSync(join(roots[0], 'sub', 'file'), '');
    chmodSync(join(roots[0], 'sub'), 0o500);
    try {
      assert.deepEqual(sweepStateRoots(base), { removed: [roots[1]], failed: [roots[0]] });
    } finally {
      chmodSync(join(roots[0], 'sub'), 0o700);
    }
  },
);

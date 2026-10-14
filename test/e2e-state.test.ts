import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStateRoot, sweepStateRoots } from '../scripts/e2e-state.mjs';

const stateModule = new URL('../scripts/e2e-state.mjs', import.meta.url).href;

function privateBase(context: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'sail-state-test-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

async function startRunner(base: string, context: test.TestContext) {
  const script = `import { createStateRoot } from ${JSON.stringify(stateModule)};
    console.log(createStateRoot(${JSON.stringify(base)}));
    setInterval(() => {}, 1000);`;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
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

  assert.deepEqual(sweepStateRoots(base), [killed.root]);

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

  assert.deepEqual(sweepStateRoots(base), [idle]);
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

  assert.deepEqual(sweepStateRoots(base), []);
  for (const name of others) assert.ok(existsSync(join(base, name)));
});

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { processStart } from '../scripts/e2e-state.mjs';
import { nativeApp } from '../scripts/native-app.mjs';
import {
  reapDeadRuns,
  registerRun,
  registerRunIfPossible,
  runRegistryDirectory,
  signalGroup,
} from '../scripts/native-run-registry.mjs';
import { runOwnedCommand } from '../scripts/native-test-process.mjs';

const registryModule = new URL('../scripts/native-run-registry.mjs', import.meta.url).href;
const processModule = new URL('../scripts/native-test-process.mjs', import.meta.url).href;
const checkout = new URL('..', import.meta.url).pathname;
const darwin = process.platform === 'darwin';

function scratch(context: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sail-run-registry-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function stopAtEnd(context: test.TestContext, ...pids: number[]) {
  context.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        return;
      }
    }
  });
}

function recordsIn(registry: string) {
  return readdirSync(registry)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(registry, name), 'utf8')));
}

type Started = { runner: ReturnType<typeof spawn>; descendant: number; app: number; id: string };

/**
 * A runner process that registers itself, launches an app that `open` would leave outside its
 * tree, and starts a command group with one descendant, like the native runner does.
 */
async function startRunner(
  context: test.TestContext,
  root: string,
  registry: string,
  name: string,
): Promise<Started> {
  const binary = join(root, name, 'Sail E2E.app/Contents/MacOS/sail');
  mkdirSync(join(root, name, 'Sail E2E.app/Contents/MacOS'), { recursive: true });
  copyFileSync('/bin/cat', binary);
  execFileSync('codesign', ['-f', '-s', '-', binary]);
  const pidFile = join(root, `${name}.descendant`);
  const script = `import { spawnSync } from 'node:child_process';
    import { existsSync, readFileSync } from 'node:fs';
    import { registerRun } from ${JSON.stringify(registryModule)};
    import { runOwnedCommand } from ${JSON.stringify(processModule)};
    const handle = registerRun(${JSON.stringify(registry)}, ${JSON.stringify(name)});
    handle.setBinary(${JSON.stringify(binary)});
    const app = Number(spawnSync('/bin/sh', ['-c', 'sleep 60 2>/dev/null | "$0" >/dev/null 2>&1 & echo $!', ${JSON.stringify(binary)}], { encoding: 'utf8' }).stdout);
    runOwnedCommand('/bin/sh', ['-c', 'sleep 300 & echo $! > "$0"; wait', ${JSON.stringify(pidFile)}], {
      cwd: ${JSON.stringify(root)},
      env: process.env,
      log: ${JSON.stringify(join(root, `${name}.log`))},
      signal: new AbortController().signal,
      ...handle.groupHooks(),
    });
    const wait = () => existsSync(${JSON.stringify(pidFile)}) && readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim()
      ? console.log(JSON.stringify({ app, descendant: Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8')) }))
      : setTimeout(wait, 20);
    wait();
    setInterval(() => {}, 1000);`;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  context.after(() => runner.kill('SIGKILL'));
  const started = await new Promise<{ app: number; descendant: number }>((resolve, reject) => {
    runner.once('error', reject);
    runner.stdout.once('data', (data) => resolve(JSON.parse(String(data))));
  });
  stopAtEnd(context, started.app, started.descendant);
  return { runner, ...started, id: name };
}

await test(
  'a runner killed with SIGKILL leaves its processes, and the next run stops them and no others',
  { skip: !darwin },
  async (context) => {
    const root = scratch(context);
    const registry = join(root, 'registry');
    const killed = await startRunner(context, root, registry, 'killed');
    const running = await startRunner(context, root, registry, 'running');
    const killedRecord = recordsIn(registry).find((record) => record.id === 'killed');
    const leader = killedRecord.groups[0].pid;
    stopAtEnd(context, leader);

    const exited = new Promise((resolve) => killed.runner.once('exit', resolve));
    killed.runner.kill('SIGKILL');
    await exited;
    assert.ok(alive(killed.app) && alive(killed.descendant), 'the dead run leaves its processes');

    const { stopApp, appProcesses } = nativeApp({ checkout });
    const result = await reapDeadRuns(registry, { stopApp, appProcesses });

    assert.deepEqual(result, { reaped: ['killed'], kept: ['running'], failed: [] });
    await delay(200);
    assert.equal(alive(killed.app), false);
    assert.equal(alive(killed.descendant), false);
    assert.equal(alive(leader), false);
    assert.ok(alive(running.app) && alive(running.descendant), 'the live run is untouched');
    assert.deepEqual(
      recordsIn(registry).map((record) => record.id),
      ['running'],
    );
  },
);

await test(
  'a recorded group whose leader pid now belongs to another process is left alone',
  { skip: !darwin },
  async (context) => {
    const root = scratch(context);
    const registry = join(root, 'registry');
    mkdirSync(registry);
    const stranger = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    const pid = stranger.pid ?? 0;
    stopAtEnd(context, pid);
    writeFileSync(
      join(registry, 'old.json'),
      JSON.stringify({
        id: 'old',
        runner: { pid: 2 ** 22 - 1, started: null },
        binary: null,
        groups: [{ pid, started: 'Mon Jan  1 00:00:00 2001' }],
      }),
    );
    const result = await reapDeadRuns(registry, {
      stopApp: async () => undefined,
      appProcesses: () => [],
      owns: () => false,
    });
    assert.deepEqual(result, { reaped: ['old'], kept: [], failed: [] });
    assert.ok(alive(pid));
    assert.equal(existsSync(join(registry, 'old.json')), false);
  },
);

// These tests pass `kill`, `readStart` and `readMembers` so that a regression cannot signal for
// real: `kill(-1)` reaches every process the user owns.
const noSignals = (sent: Array<[number, string]>) => (pid: number, signal: string) => {
  sent.push([pid, signal]);
};

await test('a record naming group 0, 1, -1 or a non-integer is never signalled', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  mkdirSync(registry);
  writeFileSync(
    join(registry, 'evil.json'),
    JSON.stringify({
      id: 'evil',
      runner: { pid: 2 ** 22 - 1 },
      binary: null,
      groups: [{ pid: -1 }, { pid: 0 }, { pid: 1, started: null }, { pid: '5' }],
    }),
  );
  const sent: Array<[number, string]> = [];
  const result = await reapDeadRuns(registry, {
    stopApp: async () => undefined,
    appProcesses: () => [],
    owns: () => false,
    readStart: () => 'Mon Jan  1 00:00:00 2001',
    readMembers: () => [{ pid: 1, pgid: 1 }],
    pause: async () => undefined,
    kill: noSignals(sent),
  });
  assert.deepEqual(sent, []);
  assert.equal(result.failed.length, 1);
  assert.ok(existsSync(join(registry, 'evil.json')));
});

await test('a group id that would signal everything is refused', () => {
  const sent: Array<[number, string]> = [];
  for (const pgid of [-1, 0, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => signalGroup(pgid, 'SIGTERM', noSignals(sent)), RangeError);
  assert.deepEqual(sent, []);
  signalGroup(2, 'SIGTERM', noSignals(sent));
  assert.deepEqual(sent, [[-2, 'SIGTERM']]);
});

await test('a living leader without a recorded start time is left alone', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  mkdirSync(registry);
  writeFileSync(
    join(registry, 'unverified.json'),
    JSON.stringify({
      id: 'unverified',
      runner: { pid: 2 ** 22 - 1 },
      binary: null,
      groups: [{ pid: 4242, started: null }],
    }),
  );
  const sent: Array<[number, string]> = [];
  const result = await reapDeadRuns(registry, {
    stopApp: async () => undefined,
    appProcesses: () => [],
    owns: () => false,
    readStart: () => 'Mon Jan  1 00:00:00 2001',
    readMembers: () => [{ pid: 4242, pgid: 4242 }],
    pause: async () => undefined,
    kill: noSignals(sent),
  });
  assert.deepEqual(sent, []);
  assert.deepEqual(result, { reaped: [], kept: [], failed: ['unverified'] });
  assert.ok(existsSync(join(registry, 'unverified.json')));
});

await test('a group whose leader died is stopped with SIGTERM, then SIGKILL if needed', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  mkdirSync(registry);
  writeFileSync(
    join(registry, 'orphaned.json'),
    JSON.stringify({
      id: 'orphaned',
      runner: { pid: 2 ** 22 - 1 },
      binary: null,
      groups: [{ pid: 4242, started: null }],
    }),
  );
  const sent: Array<[number, string]> = [];
  const result = await reapDeadRuns(registry, {
    stopApp: async () => undefined,
    appProcesses: () => [],
    owns: () => false,
    readStart: () => null,
    readMembers: () => (sent.length < 2 ? [{ pid: 4243, pgid: 4242 }] : []),
    pause: async () => undefined,
    kill: noSignals(sent),
  });
  assert.deepEqual(sent, [
    [-4242, 'SIGTERM'],
    [-4242, 'SIGKILL'],
  ]);
  assert.deepEqual(result, { reaped: ['orphaned'], kept: [], failed: [] });
});

await test('a run whose process table cannot be read stays registered', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const handle = registerRun(registry, 'unreadable');
  handle.groupHooks().onStart(99_999_999);
  const stops: string[] = [];
  const result = await reapDeadRuns(registry, {
    stopApp: async (binary: string) => void stops.push(binary),
    appProcesses: () => [],
    owns: () => false,
    readStart: () => undefined,
  });
  assert.deepEqual(result, { reaped: [], kept: [], failed: ['unreadable'] });
  assert.ok(existsSync(handle.path));
});

await test('a run whose runner is alive is kept and its app is not stopped', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const handle = registerRun(registry, 'mine');
  handle.setBinary('/nowhere/Sail E2E.app/Contents/MacOS/sail');
  const stops: string[] = [];
  const result = await reapDeadRuns(registry, {
    stopApp: async (binary: string) => void stops.push(binary),
    appProcesses: () => [],
  });
  assert.deepEqual(result, { reaped: [], kept: ['mine'], failed: [] });
  assert.deepEqual(stops, []);
});

await test('an app that survives its stop request keeps the record', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const handle = registerRun(registry, 'stubborn');
  handle.setBinary('/nowhere/Sail E2E.app/Contents/MacOS/sail');
  const result = await reapDeadRuns(registry, {
    stopApp: async () => undefined,
    appProcesses: () => [4242],
    owns: () => false,
  });
  assert.deepEqual(result, { reaped: [], kept: [], failed: ['stubborn'] });
  assert.ok(existsSync(handle.path));
});

await test('an unreadable record is reported and cleared only when old', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  mkdirSync(registry);
  const fresh = join(registry, 'fresh.json');
  const old = join(registry, 'old.json');
  writeFileSync(fresh, '{"id":');
  writeFileSync(old, '{"id":');
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(old, longAgo, longAgo);
  const result = await reapDeadRuns(registry, {
    stopApp: async () => undefined,
    appProcesses: () => [],
    owns: () => false,
  });
  assert.equal(result.failed.length, 2);
  assert.ok(existsSync(fresh));
  assert.equal(existsSync(old), false);
});

await test('a missing registry has nothing to stop', async (context) => {
  const root = scratch(context);
  assert.deepEqual(
    await reapDeadRuns(join(root, 'absent'), {
      stopApp: async () => undefined,
      appProcesses: () => [],
    }),
    { reaped: [], kept: [], failed: [] },
  );
});

await test('a registration follows its command groups and ends with release', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const handle = registerRun(registry, 'tracked');
  assert.deepEqual(recordsIn(registry)[0].runner.pid, process.pid);
  assert.equal(recordsIn(registry)[0].runner.started, processStart(process.pid));
  handle.setBinary('/x/Sail E2E.app/Contents/MacOS/sail');
  const hooks = handle.groupHooks();
  const seen: number[] = [];
  const code = await runOwnedCommand(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], {
    cwd: root,
    env: process.env,
    log: join(root, 'command.log'),
    signal: new AbortController().signal,
    onStart(pid: number) {
      hooks.onStart(pid);
      seen.push(recordsIn(registry)[0].groups[0].pid);
      assert.equal(recordsIn(registry)[0].groups[0].started, processStart(pid));
    },
    onExit: (pid: number) => hooks.onExit(pid),
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(recordsIn(registry)[0].groups, []);
  assert.equal(recordsIn(registry)[0].binary, '/x/Sail E2E.app/Contents/MacOS/sail');
  handle.release();
  assert.deepEqual(readdirSync(registry), []);
});

await test('an unwritable registry costs only the cleanup, not the run', (context) => {
  const root = scratch(context);
  writeFileSync(join(root, 'file'), '');
  const reports: string[] = [];
  const handle = registerRunIfPossible(
    () => join(root, 'file', 'registry'),
    'x',
    (message: string) => reports.push(message),
  );
  assert.equal(reports.length, 1);
  assert.doesNotThrow(() => {
    handle.setBinary('/x');
    handle.groupHooks();
    handle.release();
  });
  const unknown = registerRunIfPossible(
    () => {
      throw new Error('unknown');
    },
    'y',
    (message: string) => reports.push(message),
  );
  assert.equal(unknown.path, null);
  assert.equal(reports.length, 2);
});

await test('a failing registry update does not orphan the command it follows', async (context) => {
  const root = scratch(context);
  const pidFile = join(root, 'descendant.pid');
  const controller = new AbortController();
  const running = runOwnedCommand('/bin/sh', ['-c', 'sleep 30 & echo $! > "$0"; wait', pidFile], {
    cwd: root,
    env: process.env,
    log: join(root, 'command.log'),
    signal: controller.signal,
    onStart() {
      throw new Error('registry write failed');
    },
    onExit() {
      throw new Error('registry write failed');
    },
  });
  const waitForPid = async (deadline: number): Promise<number> => {
    if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim())
      return Number(readFileSync(pidFile, 'utf8'));
    if (Date.now() >= deadline) throw new Error('descendant did not start');
    await delay(20);
    return waitForPid(deadline);
  };
  const descendant = await waitForPid(Date.now() + 5000);
  stopAtEnd(context, descendant);
  controller.abort();
  await running;
  await delay(200);
  assert.equal(alive(descendant), false);
  assert.ok(existsSync(join(root, 'command.log')));
});

await test('the registry folder can be chosen and must be absolute', () => {
  assert.equal(runRegistryDirectory({ SAIL_NATIVE_RUN_REGISTRY: '/tmp/x' }), '/tmp/x');
  assert.throws(() => runRegistryDirectory({ SAIL_NATIVE_RUN_REGISTRY: 'relative' }), /absolute/);
  if (darwin) assert.match(runRegistryDirectory({}), /sail-native-runs$/);
  else assert.throws(() => runRegistryDirectory({}), /SAIL_NATIVE_RUN_REGISTRY/);
});

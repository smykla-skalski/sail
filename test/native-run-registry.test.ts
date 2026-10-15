import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
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
import { isOwnProcess, signalablePid } from '../scripts/native-signal-guard.mjs';
import {
  reapDeadRuns,
  registerRun,
  registerRunIfPossible,
  runRegistryDirectory,
  signalGroup,
} from '../scripts/native-run-registry.mjs';
import { runOwnedCommand, stopProcessesUnder } from '../scripts/native-test-process.mjs';

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
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        continue;
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
  const binary = join(root, name, 'Sail E2E 0123abcd.app/Contents/MacOS/sail');
  mkdirSync(join(root, name, 'Sail E2E 0123abcd.app/Contents/MacOS'), { recursive: true });
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

const noSignals = (sent: Array<[number, string]>) => (pid: number, signal: string) => {
  sent.push([pid, signal]);
};

const reap = (registry: string, options: Parameters<typeof reapDeadRuns>[1]) =>
  reapDeadRuns(registry, { kill: noSignals([]), ...options });

await test(
  'a runner killed with SIGKILL leaves its processes, and the next run asks to stop them and no others',
  { skip: !darwin },
  async (context) => {
    const root = scratch(context);
    const registry = join(root, 'registry');
    const killed = await startRunner(context, root, registry, 'killed');
    const running = await startRunner(context, root, registry, 'running');
    const record = (id: string) => recordsIn(registry).find((candidate) => candidate.id === id);
    const killedGroup = record('killed').groups[0].pid;
    const runningGroup = record('running').groups[0].pid;

    const exited = new Promise((resolve) => killed.runner.once('exit', resolve));
    killed.runner.kill('SIGKILL');
    await exited;
    assert.ok(alive(killed.app) && alive(killed.descendant), 'the dead run leaves its processes');

    const sent: Array<[number, string]> = [];
    const stopped: string[] = [];
    const result = await reap(registry, {
      stopApp: async (binary: string) => void stopped.push(binary),
      appProcesses: () => [],
      kill: noSignals(sent),
      readMembers: () => (sent.length === 0 ? [{ pid: killedGroup, pgid: killedGroup }] : []),
      pause: async () => undefined,
    });

    assert.deepEqual(result, { reaped: ['killed'], kept: ['running'], failed: [] });
    assert.deepEqual(sent, [[-killedGroup, 'SIGTERM']]);
    assert.equal(stopped.length, 1);
    assert.match(stopped[0], /killed\/Sail E2E 0123abcd\.app\/Contents\/MacOS\/sail$/);
    assert.ok(!sent.some(([pid]) => pid === -runningGroup), 'the live run is not signalled');
    assert.ok(alive(running.app) && alive(running.descendant), 'the live run is untouched');
    assert.deepEqual(
      recordsIn(registry).map((candidate) => candidate.id),
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
    const sent: Array<[number, string]> = [];
    const result = await reap(registry, {
      stopApp: async () => undefined,
      appProcesses: () => [],
      owns: () => false,
      kill: noSignals(sent),
    });
    assert.deepEqual(result, { reaped: ['old'], kept: [], failed: [] });
    assert.deepEqual(sent, []);
    assert.ok(alive(pid));
    assert.equal(existsSync(join(registry, 'old.json')), false);
  },
);

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
  const result = await reap(registry, {
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
  const result = await reap(registry, {
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
  const result = await reap(registry, {
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
  const result = await reap(registry, {
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
  handle.setBinary('/nowhere/Sail E2E 0123abcd.app/Contents/MacOS/sail');
  const stops: string[] = [];
  const result = await reap(registry, {
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
  handle.setBinary('/nowhere/Sail E2E 0123abcd.app/Contents/MacOS/sail');
  const result = await reap(registry, {
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
  const result = await reap(registry, {
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
    await reap(join(root, 'absent'), {
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
  handle.setBinary('/x/Sail E2E 0123abcd.app/Contents/MacOS/sail');
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
  assert.equal(recordsIn(registry)[0].binary, '/x/Sail E2E 0123abcd.app/Contents/MacOS/sail');
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

const recordWith = (registry: string, name: string, changes: Record<string, unknown>) => {
  mkdirSync(registry, { recursive: true });
  writeFileSync(
    join(registry, `${name}.json`),
    JSON.stringify({
      id: name,
      runner: { pid: 2 ** 22 - 1, started: null },
      binary: null,
      groups: [],
      ...changes,
    }),
  );
};

await test('records with an unusable shape are never acted on', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const fixture = '/x/Sail E2E 0123abcd.app/Contents/MacOS/sail';
  const bad: Array<[string, Record<string, unknown>]> = [
    ['runner-zero', { runner: { pid: 0 } }],
    ['runner-one', { runner: { pid: 1 } }],
    ['runner-negative', { runner: { pid: -1 } }],
    ['runner-fraction', { runner: { pid: 7.5 } }],
    ['runner-text', { runner: { pid: '7' } }],
    ['runner-start-number', { runner: { pid: 4242, started: 5 } }],
    ['binary-launchd', { binary: '/sbin/launchd' }],
    ['binary-wrong-app', { binary: '/x/Other.app/Contents/MacOS/sail' }],
    ['binary-relative', { binary: 'Sail E2E 0123abcd.app/Contents/MacOS/sail' }],
    ['binary-number', { binary: 1 }],
    ['group-nan', { binary: fixture, groups: [{ pid: null, started: null }] }],
    ['group-null', { groups: [null] }],
    ['group-big', { groups: [{ pid: 2 ** 60, started: null }] }],
    ['group-own', { groups: [{ pid: process.pid, started: null }] }],
    ['group-parent', { groups: [{ pid: process.ppid, started: null }] }],
    ['group-start-object', { groups: [{ pid: 4242, started: {} }] }],
    ['groups-text', { groups: 'all' }],
    ['no-id', { id: undefined }],
  ];
  for (const [name, changes] of bad) recordWith(registry, name, changes);
  const sent: Array<[number, string]> = [];
  const stopped: string[] = [];
  const result = await reap(registry, {
    stopApp: async (binary: string) => void stopped.push(binary),
    appProcesses: () => [],
    owns: () => false,
    readStart: () => null,
    readMembers: () => [{ pid: 4242, pgid: 4242 }],
    pause: async () => undefined,
    kill: noSignals(sent),
  });
  assert.deepEqual(sent, []);
  assert.deepEqual(stopped, []);
  assert.deepEqual(result.reaped, []);
  assert.equal(result.failed.length, bad.length);
});

await test('a well-formed record is acted on, so the guards above are not blanket refusals', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const binary = '/x/Sail E2E 0123abcd.app/Contents/MacOS/sail';
  recordWith(registry, 'fine', { binary, groups: [{ pid: 4242, started: null }] });
  const sent: Array<[number, string]> = [];
  const stopped: string[] = [];
  const result = await reap(registry, {
    stopApp: async (name: string) => void stopped.push(name),
    appProcesses: () => [],
    owns: () => false,
    readStart: () => null,
    readMembers: () => (sent.length === 0 ? [{ pid: 4243, pgid: 4242 }] : []),
    pause: async () => undefined,
    kill: noSignals(sent),
  });
  assert.deepEqual(result, { reaped: ['fine'], kept: [], failed: [] });
  assert.deepEqual(sent, [[-4242, 'SIGTERM']]);
  assert.deepEqual(stopped, [binary]);
});

await test('the signal guard accepts only ordinary process ids', () => {
  for (const pid of [
    0,
    1,
    -1,
    -2,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 31,
    2 ** 33,
    2 ** 60,
    '5',
    null,
  ])
    assert.equal(signalablePid(pid), false, String(pid));
  for (const pid of [2, 4242, 2 ** 22, 2 ** 31 - 1])
    assert.equal(signalablePid(pid), true, String(pid));
  assert.equal(isOwnProcess(process.pid), true);
  assert.equal(isOwnProcess(process.ppid), true);
  assert.equal(isOwnProcess(process.pid + 100_000), false);
});

await test('a group id of the runner or its shell is refused by the signal helper', () => {
  const sent: Array<[number, string]> = [];
  for (const pgid of [process.pid, process.ppid])
    assert.throws(() => signalGroup(pgid, 'SIGKILL', noSignals(sent)), RangeError);
  assert.deepEqual(sent, []);
});

const table = (rows: Array<[number, number | string]>) =>
  rows.map(([first, second]) => `${first} ${second}`).join('\n');

await test('stopping an app signals only ordinary, unchanged processes of that app', async () => {
  const binary = '/x/Sail E2E 0123abcd.app/Contents/MacOS/sail';
  const sent: Array<[number, string]> = [];
  const commands = table([
    [900, binary],
    [901, '/usr/bin/other'],
  ]);
  const tree = table([
    [0, 0],
    [1, 0],
    [900, 1],
    [910, 900],
    [911, 910],
    [1, 900],
    [0, 900],
    [-1, 900],
    [920, 1],
  ]);
  const identities = new Map<number, string>([
    [900, 'app'],
    [910, 'child'],
    [911, 'grandchild'],
    [1, 'init'],
    [0, 'kernel'],
    [-1, 'all'],
    [920, 'stranger'],
  ]);
  const { stopApp } = nativeApp({
    checkout,
    kill: noSignals(sent),
    identity: (pid: number) => identities.get(pid) ?? null,
    listing: (columns: string) => (columns === 'pid=,command=' ? commands : tree),
  });
  await stopApp(binary);
  const signalled = new Set(sent.map(([pid]) => pid));
  assert.deepEqual(
    [...signalled].toSorted((a, b) => a - b),
    [900, 910, 911],
  );
  assert.deepEqual(
    sent.map(([, signal]) => signal),
    ['SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL', 'SIGKILL'],
  );
});

await test('an app whose identity changes before the signal is not signalled', async () => {
  const binary = '/x/Sail E2E 0123abcd.app/Contents/MacOS/sail';
  const sent: Array<[number, string]> = [];
  let reads = 0;
  const { stopApp } = nativeApp({
    checkout,
    kill: noSignals(sent),
    identity: () => `identity-${reads++ === 0 ? 'before' : 'after'}`,
    listing: (columns: string) => (columns === 'pid=,command=' ? `900 ${binary}` : '900 1'),
  });
  await stopApp(binary);
  assert.deepEqual(sent, []);
});

await test('a registry that vanishes after registration does not fail the run', (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const handle = registerRun(registry, 'vanishing');
  rmSync(registry, { recursive: true, force: true });
  assert.doesNotThrow(() => {
    handle.setBinary('/x/Sail E2E 0123abcd.app/Contents/MacOS/sail');
    handle.groupHooks().onStart(4242);
    handle.release();
  });
});

await test('a record with a pid beyond 32 bits is reported, not treated as a runner', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  recordWith(registry, 'huge', { runner: { pid: 2 ** 33, started: null } });
  const sent: Array<[number, string]> = [];
  const result = await reap(registry, {
    stopApp: async () => undefined,
    appProcesses: () => [],
    kill: noSignals(sent),
  });
  assert.deepEqual(sent, []);
  assert.equal(result.failed.length, 1);
});

await test('fixture process stops skip pids 0, 1 and negative ones from the listing', async () => {
  const sent: Array<[number, string]> = [];
  const directory = '/x/run/Sail E2E 0123abcd.app';
  const path = `${directory}/Contents/MacOS/sail`;
  let stopped = false;
  const done = await stopProcessesUnder(directory, {
    timeout: 50,
    list: () =>
      stopped
        ? ''
        : [
            `0 ${path}`,
            `1 ${path}`,
            `-1 ${path}`,
            `${process.pid} ${path}`,
            `4242 ${path}`,
            `4243 /other/bin`,
          ].join('\n'),
    kill: (pid: number, signal: string) => {
      sent.push([pid, signal]);
      stopped = true;
    },
  });
  assert.equal(done, true);
  assert.deepEqual(sent, [[4242, 'SIGTERM']]);
});

await test('releasing a run in a registry that became read-only does not throw', (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  const handle = registerRun(registry, 'locked');
  chmodSync(registry, 0o555);
  try {
    assert.doesNotThrow(() => {
      handle.setBinary('/x/Sail E2E 0123abcd.app/Contents/MacOS/sail');
      handle.release();
    });
  } finally {
    chmodSync(registry, 0o755);
  }
});

const failingKill = (code: string) => () => {
  throw Object.assign(new Error(`kill ${code}`), { code });
};

await test('a permission error on a group that only has zombies left is not fatal', () => {
  assert.doesNotThrow(() => signalGroup(4242, 'SIGTERM', failingKill('EPERM')));
  assert.throws(() => signalGroup(4242, 'SIGTERM', failingKill('EINVAL')), /EINVAL/);
});

await test('stopping an app never signals the runner or its shell', async () => {
  const binary = '/x/Sail E2E 0123abcd.app/Contents/MacOS/sail';
  const sent: Array<[number, string]> = [];
  const { stopApp } = nativeApp({
    checkout,
    kill: noSignals(sent),
    identity: () => 'same',
    listing: (columns: string) =>
      columns === 'pid=,command='
        ? `100 ${binary}`
        : `${process.pid} 100\n${process.ppid} 100\n200 100`,
  });
  await stopApp(binary);
  assert.deepEqual(
    sent.map(([pid]) => pid),
    [200, 100, 200, 100],
  );
});

await test('a partial record write is removed with its run and when it is old', async (context) => {
  const root = scratch(context);
  const registry = join(root, 'registry');
  recordWith(registry, 'dead', {});
  writeFileSync(join(registry, 'dead.json.tmp'), '{"id":"dead"');
  writeFileSync(join(registry, 'fresh.json.tmp'), '{"id":');
  writeFileSync(join(registry, 'stale.json.tmp'), '{"id":');
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(join(registry, 'stale.json.tmp'), longAgo, longAgo);
  await reap(registry, {
    stopApp: async () => undefined,
    appProcesses: () => [],
    owns: () => false,
  });
  assert.deepEqual(readdirSync(registry).toSorted(), ['fresh.json.tmp']);
});

await test('the registry folder can be chosen and must be absolute', () => {
  assert.equal(runRegistryDirectory({ SAIL_NATIVE_RUN_REGISTRY: '/tmp/x' }), '/tmp/x');
  assert.throws(() => runRegistryDirectory({ SAIL_NATIVE_RUN_REGISTRY: 'relative' }), /absolute/);
  if (darwin) assert.match(runRegistryDirectory({}), /sail-native-runs$/);
  else assert.throws(() => runRegistryDirectory({}), /SAIL_NATIVE_RUN_REGISTRY/);
});

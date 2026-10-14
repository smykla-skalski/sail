import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  realpathSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { stopProcessesUnder, stopProcessesUnderOnSignal } from '../scripts/native-test-process.mjs';

const app = process.env.SAIL_E2E_APP;
const config = process.env.SAIL_E2E_CONFIG_DIR;
const scratch = process.env.SAIL_TEST_SCRATCH;
const temporary = process.env.TMPDIR;
if (!app || !config || !scratch) {
  throw new Error('Set SAIL_E2E_APP, SAIL_E2E_CONFIG_DIR, and SAIL_TEST_SCRATCH');
}
if (
  !temporary ||
  !isAbsolute(temporary) ||
  !existsSync(temporary) ||
  !statSync(temporary).isDirectory()
) {
  throw new Error('Set TMPDIR to an existing absolute private directory');
}
const binary = join(app, 'Contents', 'MacOS', 'sail');
stopProcessesUnderOnSignal(app);
const env = { ...process.env, SAIL_E2E_CONFIG_DIR: config };
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
])
  delete env[key];
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
const expectFailure = (executable, args, pattern) => {
  assert.throws(
    () => run(executable, args),
    (error) => pattern.test(String(error.stderr)),
  );
};
for (const root of [run('getconf', ['DARWIN_USER_TEMP_DIR']), '/tmp']) {
  const path = relative(realpathSync(root), realpathSync(app));
  assert.ok(
    path === '..' || path.startsWith('../') || isAbsolute(path),
    'Install SAIL_E2E_APP outside macOS temporary directories, under a task-owned ~/Applications root; see docs/context-auth-native.md',
  );
}
const signing = (bundle) => {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  return {
    team: result.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1],
    hash: result.stderr.match(/^CDHash=(.+)$/m)?.[1],
  };
};
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const bundleId = run('plutil', [
  '-extract',
  'CFBundleIdentifier',
  'raw',
  '-o',
  '-',
  join(app, 'Contents', 'Info.plist'),
]);
const label = `${bundleId}.context-supervisor`;
assert.match(bundleId, /^dev\.smykla\.sail\.e2e\.[a-f0-9]{32}$/);
run('codesign', ['--verify', '--deep', '--strict', app]);
run('codesign', ['--verify', '-v', '-R', '=anchor apple generic', app]);
const servicePlist = join(app, 'Contents/Library/LaunchAgents', `${label}.plist`);
assert.equal(
  run('plutil', [
    '-extract',
    'EnvironmentVariables.SAIL_E2E_CONFIG_DIR',
    'raw',
    '-o',
    '-',
    servicePlist,
  ]),
  config,
);
assert.equal(
  run('plutil', ['-extract', 'EnvironmentVariables.TMPDIR', 'raw', '-o', '-', servicePlist]),
  temporary,
);
const project = join(scratch, 'project');
const other = join(scratch, 'other-project');
const provider = join(scratch, 'fixture-provider');
let appPid;
let appLaunched = false;
const probes = [];

function replaceBundle(replacement, backupName) {
  const staged = join(scratch, 'replacement.app');
  run('ditto', [replacement, staged]);
  run('codesign', ['--verify', '--deep', '--strict', staged]);
  const previous = join(scratch, backupName);
  renameSync(app, previous);
  try {
    renameSync(staged, app);
  } catch (error) {
    renameSync(previous, app);
    throw error;
  }
  return previous;
}

function makeProject(path) {
  mkdirSync(join(path, '.sail'), { recursive: true });
  writeFileSync(
    join(path, '.sail', 'worktree.json'),
    '{"context":{"manifest":".sail/context.json"}}',
  );
  writeFileSync(
    join(path, '.sail', 'context.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'project-files',
          type: 'stdio',
          command: 'fixture-provider',
          capabilities: ['search', 'get'],
        },
      ],
    }),
  );
  run('git', ['init', '-q', path]);
  assert.equal(run('git', ['-C', path, 'rev-parse', '--show-toplevel']), realpathSync(path));
  run('git', ['-C', path, 'add', '.sail']);
  run('git', [
    '-C',
    path,
    '-c',
    'user.name=Sail Test',
    '-c',
    'user.email=sail-test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
}

function openProbe(path) {
  const child = spawn(binary, ['--context-auth-probe', path], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  probes.push(child);
  const lines = [];
  const waiters = [];
  let output = '';
  let stderr = '';
  let exitCode;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    let index;
    while ((index = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, index).trim();
      output = output.slice(index + 1);
      if (waiters.length) waiters.shift().resolve(line);
      else lines.push(line);
    }
  });
  child.on('exit', (code) => {
    exitCode = code;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(`Probe exited ${code}: ${stderr.trim()}`));
    }
  });
  const line = () =>
    Promise.race([
      new Promise((resolve, reject) => {
        if (lines.length) resolve(lines.shift());
        else if (exitCode !== undefined)
          reject(new Error(`Probe exited ${exitCode}: ${stderr.trim()}`));
        else waiters.push({ resolve, reject });
      }),
      delay(30_000).then(() => {
        throw new Error('Probe response timed out');
      }),
    ]);
  return {
    child,
    line,
    check: async () => {
      child.stdin.write('check\n');
      return line();
    },
    close: () => child.stdin.end('close\n'),
  };
}

async function waitForReady(attempts) {
  if (attempts === 0) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    if (response.ok) return true;
  } catch {
    /* Wait for the private app. */
  }
  await delay(1000);
  return waitForReady(attempts - 1);
}

try {
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(scratch, 'home'), { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(provider, '#!/bin/sh\nexit 0\n');
  chmodSync(provider, 0o700);
  makeProject(project);
  makeProject(other);

  const openArgs = [
    '-n',
    '-g',
    '--env',
    `HOME=${join(scratch, 'home')}`,
    '--env',
    `SAIL_E2E_CONFIG_DIR=${config}`,
    '--env',
    `TMPDIR=${temporary}`,
    '--env',
    `TAURI_WEBDRIVER_PORT=${port}`,
    '--env',
    `SAIL_WORKTREE_ROOT=${join(scratch, 'worktrees')}`,
    '--env',
    `SAIL_E2E_BINARY=${binary}`,
    '--env',
    `SAIL_ACP_TEST_AGENT=${join(process.cwd(), 'test', 'e2e', 'acp-agent.mjs')}`,
    '--env',
    `XDG_CONFIG_HOME=${join(scratch, 'xdg-config')}`,
    '--env',
    `XDG_DATA_HOME=${join(scratch, 'xdg-data')}`,
    '--env',
    `XDG_CACHE_HOME=${join(scratch, 'xdg-cache')}`,
    '--env',
    `XDG_STATE_HOME=${join(scratch, 'xdg-state')}`,
    '--env',
    `OPENCODE_CONFIG_DIR=${join(scratch, 'opencode-config')}`,
    app,
  ];
  try {
    run('open', openArgs);
    appLaunched = true;
  } catch (error) {
    console.error('Private app launch failed:', String(error.stderr ?? error));
    for (const args of [
      ['-dv', '--verbose=4', app],
      ['-d', '--entitlements', ':-', app],
    ]) {
      const diagnostic = spawnSync('codesign', args, {
        encoding: 'utf8',
        timeout: 10_000,
      });
      console.error('codesign diagnostic:', diagnostic.stdout, diagnostic.stderr);
      if (diagnostic.error) console.error(diagnostic.error);
    }
    try {
      const logs = run(
        'log',
        [
          'show',
          '--last',
          '2m',
          '--style',
          'compact',
          '--predicate',
          'process == "amfid" OR process == "taskgated" OR process == "runningboardd"',
        ],
        { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      );
      console.error(logs.split('\n').slice(-120).join('\n'));
    } catch (diagnosticError) {
      console.error(
        'launch log diagnostic failed:',
        String(diagnosticError.stderr ?? diagnosticError),
      );
    }
    throw error;
  }
  assert.ok(
    await waitForReady(60),
    'Private Sail app did not expose its WebDriver status endpoint',
  );
  appPid = run('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN']);
  assert.ok(
    run('osascript', [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); function run(args) { const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(args[0]); return ObjC.unwrap(url.path) || ""; }',
      bundleId,
    ]),
    'LaunchServices cannot resolve the private bundle identifier; install the app outside macOS temporary directories before registering its service',
  );

  assert.equal(
    run(binary, ['--context-auth-approve-probe', project, 'fixture-provider', provider]),
    'approved',
  );
  let first = openProbe(project);
  assert.equal(await first.line(), 'opened');
  let second = openProbe(project);
  assert.equal(await second.line(), 'opened');
  assert.equal(await first.check(), 'authorized');
  assert.equal(await second.check(), 'authorized');
  console.log('PASS: two signed sessions in one per-user service');

  assert.equal(run(binary, ['--context-auth-replay-probe', project]), 'replay-rejected');
  console.log('PASS: capability cannot be replayed on a separate XPC connection');

  expectFailure(binary, ['--context-auth-probe', other], /Context approval unavailable/);
  const copied = join(scratch, 'copied.app');
  run('ditto', [app, copied]);
  expectFailure(
    join(copied, 'Contents', 'MacOS', 'sail'),
    ['--context-auth-probe', project],
    /(?:Sail client|Context service) signature or path rejected/,
  );
  console.log('PASS: unapproved project and copied-app client rejected');

  run('codesign', ['--force', '--deep', '--sign', '-', copied]);
  run('codesign', ['--verify', '--deep', '--strict', copied]);
  const signedOriginal = replaceBundle(copied, 'signed-original.app');
  try {
    expectFailure(
      binary,
      ['--context-auth-probe', project],
      /Context service signature or path rejected/,
    );
  } finally {
    rmSync(app, { recursive: true });
    renameSync(signedOriginal, app);
  }
  console.log('PASS: differently signed client rejected');

  writeFileSync(provider, '#!/bin/sh\nexit 1\n');
  assert.match(await first.check(), /^rejected:/);
  assert.match(await second.check(), /^rejected:/);
  first.close();
  second.close();
  expectFailure(binary, ['--context-auth-probe', project], /Context approval unavailable/);
  assert.equal(
    run(binary, ['--context-auth-approve-probe', project, 'fixture-provider', provider]),
    'approved',
  );
  first = openProbe(project);
  second = openProbe(project);
  assert.equal(await first.line(), 'opened');
  assert.equal(await second.line(), 'opened');
  console.log('PASS: changed provider invalidates existing sessions and requires new approval');

  assert.equal(run(binary, ['--context-auth-revoke-probe', project]), 'revoked');
  assert.match(await first.check(), /^rejected:/);
  assert.match(await second.check(), /^rejected:/);
  first.close();
  second.close();
  expectFailure(binary, ['--context-auth-probe', project], /Context approval unavailable/);
  console.log('PASS: revocation invalidates both sessions');

  assert.equal(
    run(binary, ['--context-auth-approve-probe', project, 'fixture-provider', provider]),
    'approved',
  );
  const third = openProbe(project);
  assert.equal(await third.line(), 'opened');
  run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]);
  assert.match(await third.check(), /^rejected:/);
  third.close();
  const fourth = openProbe(project);
  assert.equal(await fourth.line(), 'opened');
  assert.equal(await fourth.check(), 'authorized');
  console.log('PASS: service restart invalidates old capability and admits new session');

  const upgrade = process.env.SAIL_CONTEXT_AUTH_UPGRADE_APP;
  if (upgrade) {
    run('codesign', ['--verify', '--deep', '--strict', upgrade]);
    run('codesign', ['--verify', '-v', '-R', '=anchor apple generic', upgrade]);
    assert.equal(
      run('plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        join(upgrade, 'Contents/Info.plist'),
      ]),
      bundleId,
    );
    const before = signing(app);
    const after = signing(upgrade);
    assert.ok(before.team && before.team !== 'not set');
    assert.equal(after.team, before.team);
    assert.ok(before.hash && after.hash);
    assert.notEqual(after.hash, before.hash);
    replaceBundle(upgrade, 'previous.app');
  } else {
    assert.ok(
      process.env.APPLE_SIGNING_IDENTITY,
      'Signed upgrade requires a signing identity or pre-signed upgrade',
    );
    run('plutil', [
      '-replace',
      'CFBundleVersion',
      '-string',
      '514.2',
      join(app, 'Contents', 'Info.plist'),
    ]);
    run('codesign', [
      '--force',
      '--deep',
      '--options',
      'runtime',
      '--sign',
      process.env.APPLE_SIGNING_IDENTITY,
      app,
    ]);
  }
  run('codesign', ['--verify', '--deep', '--strict', app]);
  assert.match(await fourth.check(), /^rejected:/);
  fourth.close();
  expectFailure(
    binary,
    ['--context-auth-probe', project],
    /Context service (signature or path rejected|unavailable or stale after upgrade)/,
  );
  console.log(
    'PASS: signed upgrade invalidates the existing session and rejects the stale service',
  );
} finally {
  for (const probe of probes) if (!probe.killed) probe.kill('SIGTERM');
  let cleanupError;
  if (appLaunched) {
    try {
      run(binary, ['--context-auth-unregister-probe']);
    } catch (error) {
      console.error('Fixture service unregister failed:', String(error.stderr ?? error));
      cleanupError = error;
    }
  }
  if (appPid) {
    for (const pid of appPid.split(/\s+/))
      if (/^\d+$/.test(pid)) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          /* Already exited. */
        }
      }
  }
  if (!(await stopProcessesUnder(app))) {
    console.error('Fixture app processes did not exit');
    process.exitCode = 1;
  }
  rmSync(scratch, { recursive: true, force: true });
  if (cleanupError) process.exitCode = 1;
}

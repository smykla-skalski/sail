import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

const app = process.env.SAIL_E2E_APP;
const config = process.env.SAIL_E2E_CONFIG_DIR;
const scratch = process.env.SAIL_TEST_SCRATCH;
if (!app || !config || !scratch) {
  throw new Error('Set SAIL_E2E_APP, SAIL_E2E_CONFIG_DIR, and SAIL_TEST_SCRATCH');
}
const binary = join(app, 'Contents', 'MacOS', 'sail');
const env = { ...process.env, SAIL_E2E_CONFIG_DIR: config };
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
const project = join(scratch, 'project');
const other = join(scratch, 'other-project');
const provider = join(scratch, 'fixture-provider');
let appPid;
const probes = [];

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
  mkdirSync(config, { recursive: true });
  writeFileSync(provider, '#!/bin/sh\nexit 0\n');
  chmodSync(provider, 0o700);
  makeProject(project);
  makeProject(other);

  run('open', [
    '-n',
    '-g',
    '--env',
    `SAIL_E2E_CONFIG_DIR=${config}`,
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
    app,
  ]);
  assert.ok(
    await waitForReady(60),
    'Private Sail app did not expose its WebDriver status endpoint',
  );
  appPid = run('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN']);

  assert.equal(
    run(binary, ['--context-auth-approve-probe', project, 'fixture-provider', provider]),
    'approved',
  );
  const first = openProbe(project);
  assert.equal(await first.line(), 'opened');
  const second = openProbe(project);
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
    /Sail client signature or path rejected/,
  );
  console.log('PASS: unapproved project and copied-app client rejected');

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
  fourth.close();
  console.log('PASS: service restart invalidates old capability and admits new session');

  assert.ok(process.env.APPLE_SIGNING_IDENTITY, 'Signed upgrade requires a signing identity');
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
  run('codesign', ['--verify', '--deep', '--strict', app]);
  expectFailure(
    binary,
    ['--context-auth-probe', project],
    /Context service (signature or path rejected|unavailable or stale after upgrade)/,
  );
  console.log('PASS: upgraded app rejects the stale signed service');
} finally {
  for (const probe of probes) if (!probe.killed) probe.kill('SIGTERM');
  try {
    run(binary, ['--context-auth-unregister-probe']);
  } catch (error) {
    console.error('Fixture service unregister failed:', String(error.stderr ?? error));
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
  rmSync(scratch, { recursive: true, force: true });
}

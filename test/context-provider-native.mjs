import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

const app = process.env.SAIL_E2E_APP;
const config = process.env.SAIL_E2E_CONFIG_DIR;
const scratch = process.env.SAIL_TEST_SCRATCH;
assert.ok(
  app && config && scratch && process.env.APPLE_SIGNING_IDENTITY,
  'Set private SAIL_E2E_APP, SAIL_E2E_CONFIG_DIR, SAIL_TEST_SCRATCH, and APPLE_SIGNING_IDENTITY',
);
const binary = join(app, 'Contents', 'MacOS', 'sail');
const env = { ...process.env, SAIL_E2E_CONFIG_DIR: config };
const run = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const signature = spawnSync('codesign', ['-dv', '--verbose=4', app], {
  encoding: 'utf8',
});
assert.equal(signature.status, 0, signature.stderr);
assert.doesNotMatch(signature.stderr, /^Signature=adhoc$/m);
run('codesign', ['--verify', '--deep', '--strict', app]);

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const root = mkdtempSync(join(scratch, 'sail-553-native-'));
const project = join(root, 'project');
const broken = join(root, 'broken');
const empty = join(root, 'empty');
const provider = join(root, 'provider');
const clients = [];
let appPid;

function makeProject(directory, command) {
  mkdirSync(join(directory, '.sail'), { recursive: true });
  writeFileSync(
    join(directory, '.sail', 'worktree.json'),
    '{"context":{"manifest":".sail/context.json"}}',
  );
  writeFileSync(
    join(directory, '.sail', 'context.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'project-files',
          type: 'stdio',
          command,
          capabilities: ['search', 'get'],
        },
      ],
    }),
  );
  run('git', ['init', '-q', directory]);
  run('git', ['-C', directory, 'add', '.sail']);
  run('git', [
    '-C',
    directory,
    '-c',
    'user.name=Sail Test',
    '-c',
    'user.email=sail-test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
}

function startClient(directory) {
  const child = spawn(binary, ['--context-mcp', directory], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  clients.push(child);
  const lines = [];
  const waiters = [];
  let buffer = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (waiters.length) waiters.shift().resolve(line);
      else lines.push(line);
    }
  });
  child.on('exit', () => {
    exited = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(stderr.trim()));
  });
  return {
    child,
    stderr: () => stderr,
    request: async (id, method = 'tools/list') => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method }) + '\n');
      const line = await Promise.race([
        new Promise((resolve, reject) => {
          if (lines.length) resolve(lines.shift());
          else if (exited) reject(new Error(stderr.trim()));
          else waiters.push({ resolve, reject });
        }),
        delay(30_000).then(() => {
          throw new Error('Provider response timed out');
        }),
      ]);
      return JSON.parse(line);
    },
    waitForExit: () =>
      Promise.race([
        exited
          ? Promise.resolve(child.exitCode)
          : new Promise((resolve) => child.once('exit', resolve)),
        delay(30_000).then(() => {
          throw new Error('Context bridge did not exit');
        }),
      ]),
  };
}

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/status`)).ok) return;
    } catch {
      /* Private app is starting. */
    }
    await delay(1000);
  }
  throw new Error('Private Sail app did not expose its WebDriver status endpoint');
}

try {
  makeProject(project, 'fixture-provider');
  makeProject(broken, 'broken-provider');
  mkdirSync(empty);
  run('git', ['init', '-q', empty]);
  run('cc', [
    '-Wall',
    '-Wextra',
    '-Werror',
    '-o',
    provider,
    join(process.cwd(), 'test', 'fixtures', 'context-provider.c'),
  ]);
  run('codesign', ['--force', '--sign', '-', provider]);
  run('open', [
    '-n',
    '-g',
    '--env',
    `SAIL_E2E_CONFIG_DIR=${config}`,
    '--env',
    `TAURI_WEBDRIVER_PORT=${port}`,
    '--env',
    `SAIL_WORKTREE_ROOT=${join(root, 'worktrees')}`,
    '--env',
    `XDG_CONFIG_HOME=${join(root, 'xdg-config')}`,
    '--env',
    `XDG_DATA_HOME=${join(root, 'xdg-data')}`,
    '--env',
    `XDG_CACHE_HOME=${join(root, 'xdg-cache')}`,
    '--env',
    `XDG_STATE_HOME=${join(root, 'xdg-state')}`,
    app,
  ]);
  await waitForReady();
  appPid = run('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']);

  assert.equal(
    run(binary, ['--context-auth-approve-probe', project, 'fixture-provider', provider]),
    'approved',
  );
  const first = startClient(project);
  const second = startClient(project);
  const a = await first.request(1, 'initialize');
  const b = await second.request(2, 'initialize');
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.ok(a.result.pid > 0);
  assert.equal(a.result.pid, b.result.pid, 'one provider process serves both agents');
  assert.equal(a.result.initializeCount, 1);
  assert.equal(b.result.initializeCount, 1, 'second agent reuses the provider handshake');

  writeFileSync(
    join(project, '.sail', 'context.json'),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'project-files',
          type: 'stdio',
          command: 'fixture-provider',
          capabilities: ['search'],
        },
      ],
    }),
  );
  assert.equal(
    (await first.request(3)).result.pid,
    a.result.pid,
    'uncommitted context stays inactive',
  );
  run('git', ['-C', project, 'add', '.sail/context.json']);
  run('git', [
    '-C',
    project,
    '-c',
    'user.name=Sail Test',
    '-c',
    'user.email=sail-test@example.invalid',
    'commit',
    '-qm',
    'changed context',
  ]);
  await assert.rejects(first.request(4));
  await first.waitForExit();
  await assert.rejects(second.request(5));
  await second.waitForExit();
  assert.match(first.stderr(), /revoked|approval changed/i);

  assert.equal(
    run(binary, ['--context-auth-approve-probe', project, 'fixture-provider', provider]),
    'approved',
  );
  const third = startClient(project);
  assert.equal((await third.request(6)).id, 6);
  copyFileSync('/usr/bin/false', join(root, 'replacement'));
  renameSync(join(root, 'replacement'), provider);
  await assert.rejects(third.request(7));
  await third.waitForExit();
  assert.match(third.stderr(), /revoked|approval changed/i);

  assert.equal(
    run(binary, ['--context-auth-approve-probe', broken, 'broken-provider', '/usr/bin/false']),
    'approved',
  );
  const failed = startClient(broken);
  await assert.rejects(failed.request(8));
  await failed.waitForExit();
  assert.match(failed.stderr(), /Provider|MCP/i);
  const noContext = startClient(empty);
  await noContext.waitForExit();
  assert.match(noContext.stderr(), /approval unavailable/i);
  console.log(
    'PASS: native MCP forwarding, one provider across agents, revocation, failure isolation, no-context',
  );
} finally {
  for (const client of clients) if (!client.killed) client.kill('SIGTERM');
  try {
    run(binary, ['--context-auth-unregister-probe']);
  } catch {
    /* Fixture may not have registered. */
  }
  if (appPid)
    for (const pid of appPid.split(/\s+/)) {
      if (/^\d+$/.test(pid)) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          /* Already exited. */
        }
      }
    }
  rmSync(root, { recursive: true, force: true });
}

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { e2eContextService, e2eIdentity } from './e2e-identity.mjs';
import { sweepStateRoots } from './e2e-state.mjs';
import {
  listProcessCommands,
  removeRunData,
  sweepRunData,
  systemRunDataRoots,
} from './native-app-data.mjs';
import { runOwnedCommand } from './native-test-process.mjs';
import {
  artifactKey,
  artifactMatches,
  nativeEnvironment,
  nativeVerdict,
  setupAttemptLimit,
} from './native-test-policy.mjs';

const checkout = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
let cancelled = false;
const cancellation = new AbortController();
const cancel = () => {
  cancelled = true;
  cancellation.abort();
};
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
process.on('SIGHUP', cancel);

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: checkout, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${program}: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout.trim();
}

async function loggedCommand(program, args, env, log) {
  return runOwnedCommand(program, args, { cwd: checkout, env, log, signal: cancellation.signal });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  if (port === 4445) return availablePort();
  return port;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceRequirements() {
  const revision = command('git', ['rev-parse', 'HEAD']);
  const files = command('git', ['ls-files', '-co', '--exclude-standard', '-z']).split('\0');
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].filter(Boolean).toSorted((a, b) => a.localeCompare(b))) {
    hash.update(file).update('\0');
    if (existsSync(join(checkout, file))) hash.update(readFileSync(join(checkout, file)));
    hash.update('\0');
  }
  return {
    revision,
    sourceHash: hash.digest('hex'),
    rust: command('rustc', ['-Vv']),
    cargo: command('cargo', ['-V']),
    node: process.version,
    appleToolchain: {
      sdkPath: command('xcrun', ['--sdk', 'macosx', '--show-sdk-path']),
      sdkVersion: command('xcrun', ['--sdk', 'macosx', '--show-sdk-version']),
      compiler: command('xcrun', ['--sdk', 'macosx', 'clang', '--version']),
    },
    architecture: process.arch,
    signing: 'ad-hoc',
    entitlementsHash: hashFile(join(checkout, 'src-tauri/Entitlements.e2e.plist')),
  };
}

function identifier(app) {
  return command('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    join(app, 'Contents/Info.plist'),
  ]);
}

function verifySignature(app) {
  if (spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status !== 0) return false;
  const details = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' });
  const entitlements = spawnSync('codesign', ['-d', '--entitlements', ':-', app], {
    encoding: 'utf8',
  });
  return (
    details.status === 0 &&
    details.stderr.includes('Signature=adhoc') &&
    entitlements.status === 0 &&
    /<dict\s*\/>|<dict>\s*<\/dict>/.test(entitlements.stdout) &&
    !entitlements.stdout.includes('<key>')
  );
}

function sign(app) {
  command('codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--entitlements',
    join(checkout, 'src-tauri/Entitlements.e2e.plist'),
    app,
  ]);
  if (!verifySignature(app)) throw new Error('Private app signature verification failed');
}

async function artifact(root, requirements, attempt) {
  const cache = join(root, 'artifacts', artifactKey(requirements));
  mkdirSync(cache, { recursive: true });
  for (const candidate of readdirSync(cache).toSorted((a, b) => b.localeCompare(a))) {
    const directory = join(cache, candidate);
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
      const app = join(directory, 'target/debug/bundle/macos', manifest.appName);
      if (
        artifactMatches(
          manifest,
          requirements,
          hashFile(join(app, 'Contents/MacOS/sail')),
          identifier(app),
          verifySignature(app),
        )
      )
        return { app, reused: true };
    } catch {
      // A partial or invalid artifact remains available for diagnosis.
    }
  }
  const free = Number(command('df', ['-Pk', root]).split('\n').at(-1).trim().split(/\s+/)[3]);
  if (!Number.isFinite(free) || free < 20 * 1024 * 1024)
    throw new Error(
      'Native build requires at least 20 GiB free; preserve diagnostics and free owned output',
    );
  const directory = realpathSync(mkdtempSync(join(cache, 'build-')));
  const env = nativeEnvironment(directory, checkout, process.env, await availablePort());
  Object.assign(env, {
    CARGO_TARGET_DIR: join(directory, 'target'),
    npm_config_cache: join(root, 'npm-cache'),
    UV_CACHE_DIR: join(root, 'uv-cache'),
  });
  const code = await loggedCommand('npm', ['run', 'build:e2e'], env, join(attempt, 'build.log'));
  if (code !== 0) throw new Error(`Native build failed (${code}); see build.log`);
  const bundle = join(directory, 'target/debug/bundle/macos');
  const apps = readdirSync(bundle).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) throw new Error('Native build did not produce exactly one private app');
  const app = join(bundle, apps[0]);
  sign(app);
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      key: artifactKey(requirements),
      requirements,
      appName: apps[0],
      binaryHash: hashFile(join(app, 'Contents/MacOS/sail')),
      identifier: identifier(app),
    }),
  );
  return { app, reused: false };
}

function prepareApp(source, attempt, env) {
  const identity = e2eIdentity();
  const app = join(attempt, `${identity.productName}.app`);
  cpSync(source, app, { recursive: true });
  const plist = join(app, 'Contents/Info.plist');
  command('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleIdentifier ${identity.identifier}`,
    plist,
  ]);
  command('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleName ${identity.productName}`, plist]);
  const template = readFileSync(
    join(checkout, 'src-tauri/macos/dev.smykla.sai-harness.context-supervisor.plist'),
    'utf8',
  );
  const service = e2eContextService(identity, template, env.SAIL_E2E_CONFIG_DIR, env.TMPDIR);
  writeFileSync(join(app, 'Contents', service.destination), service.plist, { flag: 'wx' });
  sign(app);
  env.SAIL_E2E_BINARY = join(app, 'Contents/MacOS/sail');
  env.SAIL_NATIVE_RUN_ID = identity.identifier;
  const shim = join(env.SAIL_E2E_FAKE_GH_BIN, 'gh');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(checkout, 'test/e2e/fake-gh.mjs'))} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  env.PATH = `${env.SAIL_E2E_FAKE_GH_BIN}${delimiter}${env.PATH ?? ''}`;
  return { app, identity };
}

function processIdentity(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function appProcesses(binary) {
  const processes = command('/bin/ps', ['-axo', 'pid=,command=']);
  return processes
    .split('\n')
    .filter((line) => line.trim().replace(/^\d+\s+/, '') === binary)
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

async function stopApp(binary) {
  const appPids = new Set(appProcesses(binary));
  const tree = command('/bin/ps', ['-axo', 'pid=,ppid='])
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = (parents) => {
    const next = tree.filter(([, parent]) => parents.has(parent)).map(([pid]) => pid);
    if (next.length === 0) return [];
    return [...descendants(new Set(next)), ...next];
  };
  const owned = [...descendants(appPids), ...appPids].map((pid) => ({
    pid,
    identity: processIdentity(pid),
  }));
  const signalOwned = (signal) => {
    for (const { pid, identity } of owned) {
      if (identity && processIdentity(pid) === identity) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
  };
  signalOwned('SIGTERM');
  await delay(1000);
  signalOwned('SIGKILL');
}

async function readiness(
  env,
  deadline = Date.now() + 30_000,
  reason = 'Private app did not start',
) {
  if (Date.now() < deadline && !cancelled) {
    const pids = appProcesses(env.SAIL_E2E_BINARY);
    if (pids.length === 1) {
      const listening = spawnSync('lsof', [
        '-a',
        '-p',
        String(pids[0]),
        `-iTCP:${env.TAURI_WEBDRIVER_PORT}`,
        '-sTCP:LISTEN',
        '-t',
      ]);
      if (listening.status === 0) {
        try {
          const response = await fetch(`http://127.0.0.1:${env.TAURI_WEBDRIVER_PORT}/status`, {
            signal: AbortSignal.timeout(1000),
          });
          const status = await response.json();
          if (response.ok && status.value?.ready === true) return;
          reason = 'Owned endpoint is not ready';
        } catch (error) {
          reason = `Owned endpoint probe failed: ${error.message}`;
        }
      } else reason = 'Private app does not own the requested WebDriver port';
    }
    await delay(200);
    return readiness(env, deadline, reason);
  }
  throw new Error(cancelled ? 'Native run cancelled' : reason);
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('test:native currently supports macOS only');
  const limit = setupAttemptLimit(process.env.SAIL_NATIVE_SETUP_ATTEMPTS);
  if (process.env.SAIL_NATIVE_ROOT && !isAbsolute(process.env.SAIL_NATIVE_ROOT))
    throw new Error('SAIL_NATIVE_ROOT must be an absolute task-owned directory');
  const root = process.env.SAIL_NATIVE_ROOT ?? mkdtempSync(join(tmpdir(), 'sail-native-'));
  mkdirSync(root, { recursive: true });
  const canonical = realpathSync(root);
  const run = realpathSync(mkdtempSync(join(canonical, 'run-')));
  process.stdout.write(`Native diagnostics: ${run}\n`);
  let requirements;
  try {
    requirements = sourceRequirements();
  } catch (error) {
    const failed = {
      verdict: 'SETUP_FAILED',
      phase: 'source/toolchain preflight',
      error: error.stack ?? String(error),
    };
    writeFileSync(join(run, 'result.json'), JSON.stringify(failed, null, 2));
    process.stderr.write(`Native precondition failed: ${failed.error}\n`);
    process.stdout.write(`SETUP_FAILED: ${run}\n`);
    process.exitCode = 1;
    return;
  }
  const dataRoots = systemRunDataRoots();
  try {
    const data = sweepRunData(dataRoots, listProcessCommands);
    const state = sweepStateRoots(tmpdir());
    const removed = [...data.removed, ...state.removed];
    process.stdout.write(`Removed ${removed.length} folders left by earlier native runs\n`);
    const failed = [...data.failed, ...state.failed];
    if (failed.length > 0)
      process.stderr.write(`Could not remove folders left by earlier runs: ${failed.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`Could not remove folders left by earlier runs: ${error.message}\n`);
  }
  let result = { verdict: 'SETUP_FAILED' };
  const runAttempt = async (index) => {
    if (cancelled || index > limit) return;
    const attempt = join(run, `attempt-${index}`);
    mkdirSync(attempt);
    const env = nativeEnvironment(attempt, checkout, process.env, await availablePort());
    let phase = 'artifact';
    let runIdentifier;
    try {
      const built = await artifact(canonical, requirements, attempt);
      phase = 'signing and identity';
      const { app, identity } = prepareApp(built.app, attempt, env);
      runIdentifier = identity.identifier;
      const fixtureNames = [
        'TMPDIR',
        'SAIL_E2E_CONFIG_DIR',
        'SAIL_E2E_BINARY',
        'SAIL_WORKTREE_ROOT',
        'CLAUDE_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
        'TAURI_WEBDRIVER_PORT',
        'SAIL_NATIVE_RUN_ID',
      ];
      writeFileSync(
        join(attempt, 'environment.json'),
        JSON.stringify(
          {
            requirements,
            identity,
            env: Object.fromEntries(fixtureNames.map((name) => [name, env[name]])),
            artifactReused: built.reused,
          },
          null,
          2,
        ),
      );
      phase = 'launch';
      const environmentArgs = Object.entries(env).flatMap(([name, value]) => [
        '--env',
        `${name}=${value}`,
      ]);
      command('open', ['-n', '-g', ...environmentArgs, app]);
      phase = 'readiness';
      await readiness(env);
      phase = 'webview preconditions';
      const code = await loggedCommand(
        'npm',
        ['run', 'test:e2e', '--', ...process.argv.slice(2)],
        env,
        join(attempt, 'wdio.log'),
      );
      const setup = existsSync(env.SAIL_E2E_SETUP_REPORT)
        ? JSON.parse(readFileSync(env.SAIL_E2E_SETUP_REPORT, 'utf8'))
        : null;
      result = {
        verdict: nativeVerdict(code, setup, cancelled),
        attempt: index,
        setup,
        exitCode: code,
      };
      if (result.verdict === 'SETUP_FAILED')
        writeFileSync(join(attempt, 'failure.json'), JSON.stringify(result, null, 2));
    } catch (error) {
      result = {
        verdict: cancelled ? 'CANCELLED' : 'SETUP_FAILED',
        attempt: index,
        phase,
        error: error.stack ?? String(error),
      };
      writeFileSync(join(attempt, 'failure.json'), JSON.stringify(result, null, 2));
    } finally {
      try {
        if (env.SAIL_E2E_BINARY) await stopApp(env.SAIL_E2E_BINARY);
      } finally {
        sweepStateRoots(env.TMPDIR);
        if (runIdentifier) {
          const leftovers = await removeRunData(runIdentifier, dataRoots);
          result.leftovers = leftovers;
          if (leftovers.length > 0)
            process.stderr.write(`Run folders remain after cleanup: ${leftovers.join(', ')}\n`);
        }
      }
    }
    if (result.verdict === 'SETUP_FAILED') return runAttempt(index + 1);
  };
  await runAttempt(1);
  if (cancelled) result.verdict = 'CANCELLED';
  writeFileSync(join(run, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${result.verdict}: ${run}\n`);
  process.exitCode = result.verdict === 'PASS' ? 0 : cancelled ? 130 : 1;
}

main().catch((error) => {
  process.stderr.write(`Native precondition failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});

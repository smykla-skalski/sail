import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sweepStateRoots } from './e2e-state.mjs';
import {
  listProcessCommands,
  removeIdleBuildData,
  removeRunData,
  sweepRunData,
  systemRunDataRoots,
} from './native-app-data.mjs';
import { availablePort, nativeApp, verifySignature } from './native-app.mjs';
import {
  reapDeadRuns,
  registerRunIfPossible,
  runRegistryDirectory,
} from './native-run-registry.mjs';
import { runOwnedCommand } from './native-test-process.mjs';
import {
  artifactKey,
  artifactMatches,
  nativeEnvironment,
  nativeFailurePhase,
  nativeVerdict,
  setupAttemptLimit,
} from './native-test-policy.mjs';

const checkout = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
let cancelled = false;
const cancellation = new AbortController();
const cancel = () => {
  cancelled = true;
  cancellation.abort();
};
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
process.on('SIGHUP', cancel);
const { appProcesses, command, identifier, prepareApp, readiness, sign, stopApp } = nativeApp({
  checkout,
  isCancelled: () => cancelled,
});

function reportRegistry(message) {
  process.stderr.write(`${message}\n`);
}

async function loggedCommand(program, args, env, log, groupHooks) {
  return runOwnedCommand(program, args, {
    cwd: checkout,
    env,
    log,
    signal: cancellation.signal,
    ...groupHooks,
  });
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

async function artifact(root, requirements, attempt, groupHooks) {
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
  const code = await loggedCommand(
    'npm',
    ['run', 'build:e2e'],
    env,
    join(attempt, 'build.log'),
    groupHooks,
  );
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
    const dead = await reapDeadRuns(runRegistryDirectory(), { stopApp, appProcesses });
    process.stdout.write(`Stopped ${dead.reaped.length} runs left by killed runners\n`);
    if (dead.failed.length > 0)
      process.stderr.write(`Could not stop leftovers of runs: ${dead.failed.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`Could not stop runs left by killed runners: ${error.message}\n`);
  }
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
    let buildIdentifier;
    const registration = registerRunIfPossible(
      runRegistryDirectory,
      `${process.pid}-${Date.now()}-${index}`,
      reportRegistry,
    );
    const groupHooks = registration.groupHooks();
    try {
      const built = await artifact(canonical, requirements, attempt, groupHooks);
      buildIdentifier = identifier(built.app);
      phase = 'signing and identity';
      const { app, identity } = prepareApp(built.app, attempt, env);
      runIdentifier = identity.identifier;
      registration.setBinary(env.SAIL_E2E_BINARY);
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
        groupHooks,
      );
      const setup = existsSync(env.SAIL_E2E_SETUP_REPORT)
        ? JSON.parse(readFileSync(env.SAIL_E2E_SETUP_REPORT, 'utf8'))
        : null;
      result = {
        verdict: nativeVerdict(code, setup, cancelled),
        attempt: index,
        setup,
        exitCode: code,
        ...(nativeFailurePhase(setup) ? { phase: nativeFailurePhase(setup) } : {}),
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
        const leftovers = runIdentifier ? await removeRunData(runIdentifier, dataRoots) : [];
        if (buildIdentifier) {
          try {
            leftovers.push(
              ...(await removeIdleBuildData(buildIdentifier, dataRoots, listProcessCommands)),
            );
          } catch (error) {
            leftovers.push(buildIdentifier);
            process.stderr.write(`Could not remove build identity data: ${error.message}\n`);
          }
        }
        result.leftovers = leftovers;
        if (leftovers.length > 0)
          process.stderr.write(`Run folders remain after cleanup: ${leftovers.join(', ')}\n`);
        registration.release();
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

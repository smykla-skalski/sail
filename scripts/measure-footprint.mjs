import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createStaleScratchRoots,
  createTemporaryClutter,
  createWorktrees,
  deadOwnerIdentity,
  privateRoot,
  removePrivateRoot,
  profileSettings,
  scratchMarker,
} from './footprint-profile.mjs';
import {
  WriteCounter,
  evaluate,
  formatReport,
  measureTree,
  parseOptions,
  parseProcessTable,
  snapshot,
  startupMaintenance,
  usage,
} from './footprint-measure.mjs';
import { availablePort, nativeApp } from './native-app.mjs';
import {
  isRunIdentifier,
  listProcessCommands,
  removeIdleBuildData,
  removeRunData,
  systemRunDataRoots,
} from './native-app-data.mjs';
import { nativeEnvironment } from './native-test-policy.mjs';
import { runOwnedCommand } from './native-test-process.mjs';

const checkout = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, cancel);
const { appProcesses, command, identifier, prepareApp, readiness, stopApp } = nativeApp({
  checkout,
  isCancelled: () => cancellation.signal.aborted,
});

const minutes = (value) => value * 60_000;
const writePollMs = 250;
const minimumBuildSpaceKb = 20 * 1024 * 1024;

async function sleep(ms) {
  try {
    await delay(ms, undefined, { signal: cancellation.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Footprint run cancelled', { cause: error });
    throw error;
  }
}

async function webdriver(port, method, path, body) {
  const request = {
    method,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, request);
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(result.value ?? result)}`);
  return result.value;
}

async function until(check, deadline, message) {
  if (await check()) return;
  if (Date.now() > deadline) throw new Error(message);
  await sleep(500);
  return until(check, deadline, message);
}

/** Saved settings live on disk only when the webview opts in, so the run turns that on and reloads. */
async function loadProfileInWebview(port, binary, branch) {
  const session = await webdriver(port, 'POST', '/session', {
    capabilities: {
      alwaysMatch: { browserName: 'tauri', 'tauri:options': { application: binary } },
    },
  });
  const base = `/session/${session.sessionId}`;
  try {
    await until(
      () =>
        webdriver(port, 'POST', `${base}/execute/sync`, {
          script: `sessionStorage.setItem('sail-e2e-settings', 'enabled');
            localStorage.setItem('sai-settings-migrated-v1', '1');
            return true;`,
          args: [],
        }).catch(() => false),
      Date.now() + 30_000,
      'The webview never accepted its storage settings',
    );
    await webdriver(port, 'POST', `${base}/refresh`, {});
    await until(
      () =>
        webdriver(port, 'POST', `${base}/execute/sync`, {
          script: 'return document.body.innerText.includes(arguments[0]);',
          args: [branch],
        }).catch(() => false),
      Date.now() + 60_000,
      `The sidebar never listed ${branch}`,
    );
  } finally {
    await webdriver(port, 'DELETE', base).catch(() => undefined);
  }
}

function settingsSignatures(configDirectory) {
  const files = new Map();
  const add = (path) => {
    try {
      const stat = statSync(path, { bigint: true });
      files.set(path, `${stat.ino}:${stat.mtimeNs}:${stat.size}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  add(join(configDirectory, 'settings.json'));
  const records = join(configDirectory, 'records');
  if (existsSync(records)) for (const name of readdirSync(records)) add(join(records, name));
  return files;
}

function readTimes(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const time = Number(line.trim());
      return Number.isFinite(time) && time > 0 ? [time] : [];
    });
}

function readMaintenance(home, launchedAt) {
  const logs = join(home, 'Library/Logs');
  if (!existsSync(logs)) return { maintenance: null, log: '' };
  const files = readdirSync(logs).flatMap((folder) =>
    readdirSync(join(logs, folder))
      .filter((name) => /^sail\.log(\.\d+)?$/.test(name))
      .map((name) => join(logs, folder, name)),
  );
  const log = files.map((path) => readFileSync(path, 'utf8')).join('\n');
  return { maintenance: startupMaintenance(log, launchedAt), log };
}

function checkFreeSpace(directory) {
  const free = Number(command('df', ['-Pk', directory]).split('\n').at(-1).trim().split(/\s+/)[3]);
  if (!Number.isFinite(free) || free < minimumBuildSpaceKb)
    throw new Error('Building the private app needs at least 20 GiB free; pass --app instead');
}

async function buildApp(root, run) {
  checkFreeSpace(root);
  const env = nativeEnvironment(join(root, 'build'), checkout, process.env, await availablePort());
  env.CARGO_TARGET_DIR = join(root, 'target-app');
  const code = await runOwnedCommand('npm', ['run', 'build:e2e'], {
    cwd: checkout,
    env,
    log: join(run, 'build.log'),
    signal: cancellation.signal,
  });
  if (code !== 0) throw new Error(`The private app build failed (${code}); see ${run}/build.log`);
  const bundle = join(env.CARGO_TARGET_DIR, 'debug/bundle/macos');
  const apps = readdirSync(bundle).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) throw new Error('The build did not produce exactly one private app');
  return join(bundle, apps[0]);
}

async function removeAppData(runIdentifier, buildIdentifier, dataRoots) {
  const leftovers = [];
  const attempt = async (name, remove) => {
    try {
      leftovers.push(...(await remove()));
    } catch (error) {
      leftovers.push(name);
      process.stderr.write(`Could not remove data of ${name}: ${error.message}\n`);
    }
  };
  if (runIdentifier) await attempt(runIdentifier, () => removeRunData(runIdentifier, dataRoots));
  if (buildIdentifier)
    await attempt(buildIdentifier, () =>
      removeIdleBuildData(buildIdentifier, dataRoots, listProcessCommands),
    );
  return leftovers;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (process.platform !== 'darwin') throw new Error('measure:footprint supports macOS only');
  const root = privateRoot(tmpdir());
  if (process.env.SAIL_SCRATCH_OWNER_IDENTITY)
    writeFileSync(join(root, scratchMarker), `${process.env.SAIL_SCRATCH_OWNER_IDENTITY}\n`);
  process.stdout.write(`Footprint scratch: ${root}\n`);
  const dataRoots = systemRunDataRoots();
  const timers = [];
  let binary;
  let runIdentifier;
  let buildIdentifier;
  let result;
  try {
    const run = join(root, 'run');
    mkdirSync(run);
    const source = options.app
      ? resolve(options.app)
      : (process.stdout.write('Building the private app\n'), await buildApp(root, run));
    if (!existsSync(join(source, 'Contents/Info.plist')))
      throw new Error(`${source} is not an application bundle`);
    const sourceIdentifier = identifier(source);
    if (!isRunIdentifier(sourceIdentifier))
      throw new Error(`${source} is not a build:e2e bundle (identifier ${sourceIdentifier})`);
    buildIdentifier = sourceIdentifier;

    const env = nativeEnvironment(run, checkout, process.env, await availablePort());
    delete env.SAIL_SCRATCH_OWNER_IDENTITY;
    const home = join(run, 'home');
    mkdirSync(home);
    env.HOME = realpathSync(home);
    env.SAIL_E2E_ACP_LIST_LOG = join(run, 'acp-list.log');

    const profile = createWorktrees(root, options.worktrees);
    const configDirectory = env.SAIL_E2E_CONFIG_DIR;
    writeFileSync(
      join(configDirectory, 'settings.json'),
      JSON.stringify(profileSettings(profile)),
      { mode: 0o600 },
    );
    createStaleScratchRoots(env.TMPDIR, options.staleRoots, deadOwnerIdentity());
    createTemporaryClutter(env.TMPDIR, options.clutter);

    const { app, identity } = prepareApp(source, run, env);
    runIdentifier = identity.identifier;
    binary = env.SAIL_E2E_BINARY;
    if (appProcesses(binary).length > 0) throw new Error('A process already runs this private app');
    const environmentArgs = Object.entries(env).flatMap(([name, value]) => [
      '--env',
      `${name}=${value}`,
    ]);
    const launchedAt = Date.now();
    command('open', ['-n', '-g', ...environmentArgs, app]);
    await readiness(env);
    const [appPid] = appProcesses(binary);
    process.stdout.write(
      `Launched private Sail (pid ${appPid}) with ${options.worktrees} worktrees\n`,
    );

    const samples = [];
    const writes = new WriteCounter();
    let exited = false;
    let pollFailure;
    const guarded = (poll) => {
      try {
        poll();
      } catch (error) {
        pollFailure ??= error;
      }
    };
    writes.observe(settingsSignatures(configDirectory), Date.now());
    timers.push(
      setInterval(
        () => guarded(() => writes.observe(settingsSignatures(configDirectory), Date.now())),
        writePollMs,
      ),
      setInterval(
        () =>
          guarded(() => {
            const table = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
              encoding: 'utf8',
              maxBuffer: 64 * 1024 * 1024,
            });
            const tree =
              table.status === 0 ? measureTree(parseProcessTable(table.stdout), appPid) : null;
            if (tree) samples.push({ time: Date.now(), ...tree });
            else exited = true;
          }),
        options.intervalSeconds * 1000,
      ),
    );
    await loadProfileInWebview(env.TAURI_WEBDRIVER_PORT, binary, profile.worktrees[0].branch);

    const windowMs = minutes(options.windowMinutes);
    const take = (offset) =>
      snapshot({
        samples,
        listings: readTimes(env.SAIL_E2E_ACP_LIST_LOG),
        writes: writes.times,
        at: launchedAt + offset,
        windowMs,
      });
    const waitUntil = async (offset) => {
      if (pollFailure) throw pollFailure;
      if (exited) throw new Error('The private app exited during the run');
      const remaining = launchedAt + offset - Date.now();
      if (remaining <= 0) return;
      await sleep(Math.min(5000, remaining));
      return waitUntil(offset);
    };
    await waitUntil(minutes(options.firstMinutes));
    const first = take(minutes(options.firstMinutes));
    process.stdout.write(
      `First sample: ${first.children} children, ${(first.rssBytes / 1048576).toFixed(1)} MB RSS\n`,
    );
    await waitUntil(minutes(options.secondMinutes));
    const second = take(minutes(options.secondMinutes));

    const { maintenance, log } = readMaintenance(home, launchedAt);
    const staleLeft = readdirSync(env.TMPDIR).filter((name) =>
      name.startsWith('sail-footprint-stale-'),
    ).length;
    const verdict = evaluate({ first, second, maintenance, options });
    const totals = {
      listings: readTimes(env.SAIL_E2E_ACP_LIST_LOG).length,
      settingsWrites: writes.times.length,
    };
    result = {
      launchedAt,
      options,
      first,
      second,
      maintenance,
      staleRootsLeft: staleLeft,
      totals,
      samples,
      verdict,
    };
    process.stdout.write(
      `\n${formatReport({ first, second, verdict, maintenance, options, launchedAt })}\n`,
    );
    process.stdout.write(
      `Stale scratch roots: ${options.staleRoots - staleLeft} of ${options.staleRoots} removed by the startup sweep\n` +
        `Since launch: ${totals.listings} ACP session listings, ${totals.settingsWrites} settings file writes\n`,
    );
    if (!maintenance) process.stdout.write(`Log tail:\n${log.split('\n').slice(-20).join('\n')}\n`);
    if (options.json) writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
    return verdict.pass ? 0 : 1;
  } finally {
    for (const timer of timers) clearInterval(timer);
    try {
      if (binary) await stopApp(binary);
    } finally {
      const leftovers = await removeAppData(runIdentifier, buildIdentifier, dataRoots);
      removePrivateRoot(root, realpathSync(tmpdir()));
      if (leftovers.length > 0)
        process.stderr.write(`Run folders remain after cleanup: ${leftovers.join(', ')}\n`);
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
}

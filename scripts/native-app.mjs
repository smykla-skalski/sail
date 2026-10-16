import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { e2eContextService, e2eIdentity } from './e2e-identity.mjs';
import { buildIdentifierKey } from './native-app-data.mjs';
import { isOwnProcess, signalablePid } from './native-signal-guard.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function availablePort() {
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

export function verifySignature(app) {
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

export function processIdentity(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Signing, identity, launch and stop steps shared by the native runners. `checkout` is the
 * repository whose entitlements and fixtures the private app uses; `isCancelled` lets a caller end
 * the readiness wait.
 */
export function nativeApp({
  checkout,
  isCancelled = () => false,
  kill = (pid, signal) => process.kill(pid, signal),
  identity: readIdentity = processIdentity,
  listing,
}) {
  function command(program, args, options = {}) {
    const result = spawnSync(program, args, { cwd: checkout, encoding: 'utf8', ...options });
    if (result.error || result.status !== 0)
      throw new Error(`${program}: ${result.error?.message ?? result.stderr ?? result.status}`);
    return result.stdout.trim();
  }

  function identifier(app) {
    return command('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleIdentifier',
      join(app, 'Contents/Info.plist'),
    ]);
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
    command('/usr/libexec/PlistBuddy', [
      '-c',
      `Add :${buildIdentifierKey} string ${identifier(source)}`,
      plist,
    ]);
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

  function processTable(columns) {
    return listing ? listing(columns) : command('/bin/ps', ['-axo', columns]);
  }

  function appProcesses(binary) {
    const executable = canonicalPath(binary);
    const processes = processTable('pid=,command=');
    return processes
      .split('\n')
      .filter((line) => canonicalPath(line.trim().replace(/^\d+\s+/, '')) === executable)
      .map((line) => Number(line.trim().split(/\s+/)[0]));
  }

  async function stopApp(binary) {
    const appPids = new Set(appProcesses(binary));
    const tree = processTable('pid=,ppid=')
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const descendants = (parents, seen = new Set(parents)) => {
      const next = tree
        .filter(
          ([pid, parent]) =>
            signalablePid(pid) && !isOwnProcess(pid) && parents.has(parent) && !seen.has(pid),
        )
        .map(([pid]) => pid);
      if (next.length === 0) return [];
      for (const pid of next) seen.add(pid);
      return [...descendants(new Set(next), seen), ...next];
    };
    const owned = [...descendants(appPids), ...appPids].map((pid) => ({
      pid,
      identity: readIdentity(pid),
    }));
    const signalOwned = (signal) => {
      for (const { pid, identity } of owned) {
        if (
          signalablePid(pid) &&
          !isOwnProcess(pid) &&
          identity &&
          readIdentity(pid) === identity
        ) {
          try {
            kill(pid, signal);
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
    if (Date.now() < deadline && !isCancelled()) {
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
    throw new Error(isCancelled() ? 'Native run cancelled' : reason);
  }

  return {
    appProcesses,
    command,
    identifier,
    prepareApp,
    readiness,
    sign,
    stopApp,
  };
}

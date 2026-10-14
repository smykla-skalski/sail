import { browser } from '@wdio/globals';
import { chmodSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  assertPrivateE2eConfigRoot,
  isolatedPaths,
  privatePort,
  PrivateEndpointGuard,
} from './test/e2e-isolation.ts';
import { createStateRoot, removeStateRoot, sweepStateRoots } from './scripts/e2e-state.mjs';
import { E2eJobQueue, e2eJobLimit } from './test/e2e-concurrency.ts';
import { resetAgentFixture } from './test/e2e/fixture-lifecycle.ts';
import { assertNativeWebviews } from './test/e2e/native-preconditions.ts';

const limitEnvironment = { ...process.env };
const jobs = new E2eJobQueue(undefined, () => e2eJobLimit(limitEnvironment));
const cancelQueuedJob = (signal: number) => {
  jobs.release();
  process.exit(128 + signal);
};
const cancelOnInterrupt = () => cancelQueuedJob(2);
const cancelOnTerminate = () => cancelQueuedJob(15);

const port = privatePort(process.env.TAURI_WEBDRIVER_PORT);
process.env.TAURI_WEBDRIVER_PORT = String(port);
const serviceModule = '@wdio/tauri-service';
const { default: TauriService } = await import(serviceModule);
sweepStateRoots(tmpdir());
const state = createStateRoot(tmpdir());
process.once('exit', () => {
  jobs.release();
  removeStateRoot(state);
});
const attach = process.env.SAIL_E2E_ATTACH === '1';
if (!attach) process.env.SAIL_HOOK_CONNECTION_FILE = join(state, 'hook-connection.json');
Object.assign(process.env, isolatedPaths(state, attach, process.env));
if (attach) assertPrivateE2eConfigRoot(process.env.SAIL_E2E_CONFIG_DIR, tmpdir());
if (attach && process.env.SAIL_E2E_MACHINE_READING !== 'healthy')
  throw new Error('Attach mode requires SAIL_E2E_MACHINE_READING=healthy in the app and runner.');
if (!attach) process.env.SAIL_E2E_MACHINE_READING = 'healthy';
process.env.SAIL_E2E_OPEN_URL_LOG = attach
  ? (process.env.SAIL_E2E_OPEN_URL_LOG ?? join(state, 'external-link.log'))
  : join(state, 'external-link.log');
process.env.SAIL_ACP_TEST_AGENT = resolve('test/e2e/acp-agent.mjs');
process.env.SAIL_E2E_ACP_CLOSE_LOG = attach
  ? (process.env.SAIL_E2E_ACP_CLOSE_LOG ?? join(state, 'acp-close.log'))
  : join(state, 'acp-close.log');

const fakeGhDirectory = join(state, 'fake-gh');
if (!attach && process.platform !== 'win32' && !process.env.SAIL_E2E_FAKE_GH_DIR) {
  mkdirSync(join(state, 'bin'), { recursive: true });
  mkdirSync(fakeGhDirectory, { recursive: true });
  const shim = join(state, 'bin', 'gh');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${resolve('test/e2e/fake-gh.mjs')}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  process.env.SAIL_E2E_FAKE_GH_DIR = fakeGhDirectory;
  process.env.SAIL_E2E_FAKE_GH_BIN = join(state, 'bin');
  process.env.PATH = `${join(state, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
}

const e2eAppearance = process.env.SAIL_E2E_APPEARANCE === 'dark' ? 'dark' : 'light';

/** WDIO logs ordinary config-hook errors and continues, so fixture failures must stop the worker. */
function failClosedPrecondition(
  precondition: string,
  setup: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    try {
      await setup();
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      if (process.env.SAIL_E2E_SETUP_REPORT)
        writeFileSync(
          process.env.SAIL_E2E_SETUP_REPORT,
          JSON.stringify({ status: 'failed', precondition, detail }),
        );
      writeSync(2, `Fatal E2E fixture reset: ${detail}\n`);
      process.exit(1);
    }
  };
}

const resetNativeAgentFixture = () =>
  resetAgentFixture((command, args) =>
    browser.tauri.execute(async ({ core }, request) => core.invoke(request.command, request.args), {
      command,
      args: args ?? {},
    }),
  );

const binary = resolve(
  process.env.SAIL_E2E_BINARY ??
    `src-tauri/target/debug/sail${process.platform === 'win32' ? '.exe' : ''}`,
);

export const config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port,
  specs: ['./test/e2e/*.spec.ts'],
  maxInstances: 1,
  services: [
    [PrivateEndpointGuard, { port }],
    [
      attach ? TauriService : 'tauri',
      { appBinaryPath: binary, driverProvider: 'embedded', embeddedPort: port },
    ],
  ],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'error',
  mochaOpts: { timeout: 240_000 },
  waitforTimeout: 20_000,
  connectionRetryTimeout: 90_000,
  async onPrepare() {
    let lastWaitingLimit: number | null = null;
    process.once('SIGINT', cancelOnInterrupt);
    process.once('SIGTERM', cancelOnTerminate);
    try {
      await jobs.acquire((limit) => {
        if (limit === lastWaitingLimit) return;
        lastWaitingLimit = limit;
        process.stdout.write(`Waiting for E2E slot (limit ${limit})\n`);
      });
    } finally {
      process.off('SIGINT', cancelOnInterrupt);
      process.off('SIGTERM', cancelOnTerminate);
    }
  },
  /** Specs share one app process. Clear state left by earlier specs before pinning appearance. */
  before: failClosedPrecondition('fixture/webview setup', async () => {
    await browser.switchToWindow('main');
    await browser.setWindowSize(1280, 850);
    if (process.env.SAIL_NATIVE_RUN_ID)
      await browser.execute(async (runId) => {
        const stored = localStorage.getItem('sail-native-run-sentinel');
        if (stored && stored !== runId)
          throw new Error('Native precondition: webview state leaked from an earlier run');
      }, process.env.SAIL_NATIVE_RUN_ID);
    await browser.execute(async () => {
      const tauri: unknown = Reflect.get(window, '__TAURI__');
      const core: unknown = tauri && typeof tauri === 'object' ? Reflect.get(tauri, 'core') : null;
      const invoke: unknown = core && typeof core === 'object' ? Reflect.get(core, 'invoke') : null;
      if (typeof invoke !== 'function')
        throw new Error('Tauri API missing; cannot reset E2E state');
      const windows: unknown = await invoke('plugin:wdio|list_windows');
      if (!Array.isArray(windows) || !windows.every((label) => typeof label === 'string'))
        throw new Error('Invalid Tauri window list');
      if (windows.includes('settings')) await invoke('plugin:window|close', { label: 'settings' });
      const quiesce: unknown = Reflect.get(window, '__SAIL_E2E_QUIESCE_SETTINGS__');
      if (typeof quiesce === 'function') await quiesce();
      else if (document.querySelector('.app-shell'))
        throw new Error('E2E app has no settings write barrier');
      localStorage.clear();
      sessionStorage.clear();
      if (location.search) history.replaceState(null, '', location.pathname);
    });
    await resetNativeAgentFixture();
    await browser.refresh();

    await browser.execute(async () => {
      const tauri: unknown = Reflect.get(window, '__TAURI__');
      const core: unknown = tauri && typeof tauri === 'object' ? Reflect.get(tauri, 'core') : null;
      const invoke: unknown = core && typeof core === 'object' ? Reflect.get(core, 'invoke') : null;
      if (typeof invoke !== 'function') throw new Error('Tauri API missing; cannot reset settings');
      const quiesce: unknown = Reflect.get(window, '__SAIL_E2E_QUIESCE_SETTINGS__');
      if (typeof quiesce === 'function') await quiesce();
      else if (document.querySelector('.app-shell'))
        throw new Error('E2E app has no settings write barrier');
      localStorage.clear();
      sessionStorage.clear();
      await invoke('reset_test_settings');
      const persisted: unknown = await invoke('load_settings');
      if (!persisted || typeof persisted !== 'object' || Object.keys(persisted).length !== 0)
        throw new Error('E2E settings were repopulated after reset');
    });
    await browser.refresh();

    await browser.execute(async (value) => {
      const tauri: unknown = Reflect.get(window, '__TAURI__');
      const core: unknown = tauri && typeof tauri === 'object' ? Reflect.get(tauri, 'core') : null;
      const invoke: unknown = core && typeof core === 'object' ? Reflect.get(core, 'invoke') : null;
      if (typeof invoke !== 'function') throw new Error('Tauri API missing; cannot pin appearance');
      await invoke('plugin:window|set_theme', { label: 'main', value });
    }, e2eAppearance);
    if (process.env.SAIL_E2E_SETUP_REPORT) {
      await assertNativeWebviews();
      writeFileSync(process.env.SAIL_E2E_SETUP_REPORT, JSON.stringify({ status: 'ready' }));
    }
  }),
  beforeTest: failClosedPrecondition('pre-test agent request cleanup', async () => {
    await resetNativeAgentFixture();
  }),
  afterTest: failClosedPrecondition('post-test agent request cleanup', async () => {
    await resetNativeAgentFixture();
  }),
  onComplete() {
    jobs.release();
    removeStateRoot(state);
  },
};

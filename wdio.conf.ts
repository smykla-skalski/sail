import { browser } from '@wdio/globals';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { isolatedPaths, privatePort, PrivateEndpointGuard } from './test/e2e-isolation.ts';

const port = privatePort(process.env.TAURI_WEBDRIVER_PORT);
process.env.TAURI_WEBDRIVER_PORT = String(port);
const serviceModule = '@wdio/tauri-service';
const { default: TauriService } = await import(serviceModule);
const state = mkdtempSync(join(tmpdir(), 'sail-e2e-'));
const attach = process.env.SAIL_E2E_ATTACH === '1';
Object.assign(process.env, isolatedPaths(state, attach, process.env));
if (!attach) process.env.CLAUDE_CONFIG_DIR = join(state, 'claude');
process.env.SAIL_E2E_OPEN_URL_LOG = attach
  ? (process.env.SAIL_E2E_OPEN_URL_LOG ?? join(state, 'external-link.log'))
  : join(state, 'external-link.log');
process.env.SAIL_ACP_TEST_AGENT = resolve('test/e2e/acp-agent.mjs');

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
  /** Specs share one app process. Clear state left by earlier specs before pinning appearance. */
  async before() {
    await browser.setWindowSize(1280, 850);
    const needsReload = await browser.execute(async () => {
      const tauri: unknown = Reflect.get(window, '__TAURI__');
      const core: unknown = tauri && typeof tauri === 'object' ? Reflect.get(tauri, 'core') : null;
      const invoke: unknown = core && typeof core === 'object' ? Reflect.get(core, 'invoke') : null;
      if (typeof invoke !== 'function')
        throw new Error('Tauri API missing; cannot reset E2E state');
      const response: unknown = await invoke('acp_pending_inbox');
      if (!Array.isArray(response)) throw new Error('Invalid pending inbox response');
      const pending: unknown[] = response;
      const resolutions = pending.map((item) => {
        if (!item || typeof item !== 'object') throw new Error('Invalid pending inbox item');
        const agent: unknown = Reflect.get(item, 'agent');
        const message: unknown = Reflect.get(item, 'message');
        if (typeof agent !== 'string' || !message || typeof message !== 'object')
          throw new Error('Invalid pending inbox request');
        const method: unknown = Reflect.get(message, 'method');
        const params: unknown = Reflect.get(message, 'params');
        const sessionId: unknown =
          params && typeof params === 'object' ? Reflect.get(params, 'sessionId') : null;
        if (typeof sessionId !== 'string') throw new Error('Pending request has no session');
        if (method === 'elicitation/create') {
          const requestId: unknown = Reflect.get(message, 'id');
          if (typeof requestId !== 'string' && typeof requestId !== 'number')
            throw new Error('Pending elicitation has no request ID');
          return invoke('acp_elicitation', {
            params: { agent, requestId, action: 'cancel', content: null },
          });
        }
        if (method === 'session/request_permission') {
          return invoke('acp_cancel', { agent, sessionId, turnId: null });
        }
        throw new Error(`Unexpected pending request: ${String(method)}`);
      });
      await Promise.all(resolutions);
      const remaining: unknown = await invoke('acp_pending_inbox');
      if (!Array.isArray(remaining) || remaining.length > 0)
        throw new Error('E2E setup left pending agent requests');
      sessionStorage.removeItem('sail-e2e-settings');
      const hadQuery = !!location.search;
      if (hadQuery) history.replaceState(null, '', location.pathname);
      return hadQuery || pending.length > 0;
    });
    if (needsReload) await browser.refresh();

    await browser.execute(async (value) => {
      const tauri: unknown = Reflect.get(window, '__TAURI__');
      const core: unknown = tauri && typeof tauri === 'object' ? Reflect.get(tauri, 'core') : null;
      const invoke: unknown = core && typeof core === 'object' ? Reflect.get(core, 'invoke') : null;
      if (typeof invoke !== 'function') throw new Error('Tauri API missing; cannot pin appearance');
      await invoke('plugin:window|set_theme', { label: 'main', value });
    }, e2eAppearance);
  },
  onComplete() {
    rmSync(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  },
};

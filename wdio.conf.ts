import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { privatePort, PrivateEndpointGuard } from './test/e2e-isolation.ts';

const port = privatePort(process.env.TAURI_WEBDRIVER_PORT);
process.env.TAURI_WEBDRIVER_PORT = String(port);
const serviceModule = '@wdio/tauri-service';
const { default: TauriService } = await import(serviceModule);
const state = mkdtempSync(join(tmpdir(), 'sail-e2e-'));
process.env.SAIL_WORKTREE_ROOT ??= join(state, 'worktrees');
process.env.SAIL_E2E_CONFIG_DIR ??= join(state, 'config');
process.env.SAIL_E2E_OPEN_URL_LOG ??= join(state, 'external-link.log');
process.env.SAIL_ACP_TEST_AGENT = resolve('test/e2e/acp-agent.mjs');
for (const [name, directory] of Object.entries({
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state',
})) {
  process.env[name] ??= join(state, directory);
}

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
      process.env.SAIL_E2E_ATTACH === '1' ? TauriService : 'tauri',
      { appBinaryPath: binary, driverProvider: 'embedded', embeddedPort: port },
    ],
  ],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'error',
  mochaOpts: { timeout: 90_000 },
  waitforTimeout: 20_000,
  connectionRetryTimeout: 90_000,
  onComplete() {
    rmSync(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  },
};

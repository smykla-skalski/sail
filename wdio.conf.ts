import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedPaths, privatePort, PrivateEndpointGuard } from './test/e2e-isolation.ts';

const port = privatePort(process.env.TAURI_WEBDRIVER_PORT);
process.env.TAURI_WEBDRIVER_PORT = String(port);
const serviceModule = '@wdio/tauri-service';
const { default: TauriService } = await import(serviceModule);
const state = mkdtempSync(join(tmpdir(), 'sail-e2e-'));
const attach = process.env.SAIL_E2E_ATTACH === '1';
Object.assign(process.env, isolatedPaths(state, attach, process.env));
process.env.SAIL_E2E_OPEN_URL_LOG = attach
  ? (process.env.SAIL_E2E_OPEN_URL_LOG ?? join(state, 'external-link.log'))
  : join(state, 'external-link.log');
process.env.SAIL_ACP_TEST_AGENT = resolve('test/e2e/acp-agent.mjs');

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
  onComplete() {
    rmSync(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  },
};

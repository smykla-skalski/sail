import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { e2eIdentity } from './e2e-identity.mjs';

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const bundleArgs = process.platform === 'darwin' ? ['--bundles', 'app'] : ['--no-bundle'];
const result = spawnSync(
  command,
  [
    'run',
    'tauri',
    '--',
    'build',
    '--debug',
    '--features',
    'e2e',
    '--config',
    'src-tauri/tauri.e2e.conf.json',
    ...process.argv.slice(2),
    ...bundleArgs,
    '--config',
    JSON.stringify(e2eIdentity()),
  ],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

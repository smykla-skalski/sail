import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { e2eContextService, e2eIdentity } from './e2e-identity.mjs';

const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const bundleArgs = process.platform === 'darwin' ? ['--bundles', 'app'] : ['--no-bundle'];
const identity = e2eIdentity();
let contextDir;
let result;
try {
  if (process.platform === 'darwin') {
    const templatePath = new URL(
      '../src-tauri/macos/dev.smykla.sai-harness.context-supervisor.plist',
      import.meta.url,
    );
    const template = readFileSync(templatePath, 'utf8');
    const service = e2eContextService(identity, template, process.env.SAIL_E2E_CONFIG_DIR);
    contextDir = mkdtempSync(join(tmpdir(), 'sail-e2e-context-'));
    const source = join(contextDir, `${service.label}.plist`);
    writeFileSync(source, service.plist);
    identity.bundle = {
      macOS: { files: { [service.destination]: relative(resolve('src-tauri'), source) } },
    };
  }

  result = spawnSync(
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
      JSON.stringify(identity),
    ],
    { stdio: 'inherit' },
  );
} finally {
  if (contextDir?.startsWith(join(tmpdir(), 'sail-e2e-context-'))) {
    rmSync(contextDir, { recursive: true, force: true });
  }
}

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

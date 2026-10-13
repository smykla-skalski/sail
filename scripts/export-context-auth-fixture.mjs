import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

const app = process.env.SAIL_E2E_APP;
const root = process.env.SAIL_CONTEXT_AUTH_ROOT;
const config = process.env.SAIL_CONTEXT_AUTH_EXPORT_CONFIG;
const temporary = process.env.SAIL_CONTEXT_AUTH_EXPORT_TMPDIR;
const identity = process.env.APPLE_SIGNING_IDENTITY;
assert.equal(process.platform, 'darwin');
assert.ok(app && root && identity && identity !== '-');
assert.ok(config && isAbsolute(config), 'Set the private test host config path');
assert.ok(temporary && isAbsolute(temporary), 'Set the private test host TMPDIR');
const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const bundleId = run('plutil', [
  '-extract',
  'CFBundleIdentifier',
  'raw',
  '-o',
  '-',
  join(app, 'Contents/Info.plist'),
]);
assert.match(bundleId, /^dev\.smykla\.sail\.e2e\.[a-f0-9]{32}$/);
const output = join(root, 'artifact');
mkdirSync(output, { recursive: true });
for (const variant of ['original', 'upgrade']) {
  const bundle = join(root, variant, 'Sail Native Fixture.app');
  run('ditto', [app, bundle]);
  const plist = join(
    bundle,
    'Contents/Library/LaunchAgents',
    `${bundleId}.context-supervisor.plist`,
  );
  run('plutil', ['-replace', 'EnvironmentVariables.SAIL_E2E_CONFIG_DIR', '-string', config, plist]);
  run('plutil', ['-replace', 'EnvironmentVariables.TMPDIR', '-string', temporary, plist]);
  if (variant === 'upgrade') {
    run('plutil', [
      '-replace',
      'CFBundleVersion',
      '-string',
      '557.2',
      join(bundle, 'Contents/Info.plist'),
    ]);
  }
  run('codesign', [
    '--force',
    '--deep',
    '--options',
    'runtime',
    '--entitlements',
    'src-tauri/Entitlements.e2e.plist',
    '--sign',
    identity,
    bundle,
  ]);
  run('codesign', ['--verify', '--deep', '--strict', bundle]);
  run('codesign', ['--verify', '-v', '-R', '=anchor apple generic', bundle]);
  run('ditto', ['-c', '-k', '--keepParent', bundle, join(output, `${variant}.app.zip`)]);
}
console.log(
  'Exported Apple-signed private original and upgrade bundles; signing keys remain in CI',
);

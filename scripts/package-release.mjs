import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

const targets = {
  'macos-arm64': { os: 'darwin', arch: 'arm64', bundles: { dmg: '.dmg' } },
  'macos-x64': { os: 'darwin', arch: 'x64', bundles: { dmg: '.dmg' } },
  'linux-x64': {
    os: 'linux',
    arch: 'x64',
    bundles: { deb: '.deb', appimage: '.AppImage' },
  },
  'windows-x64': { os: 'win32', arch: 'x64', bundles: { nsis: '.exe' } },
};

const appVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tauriVersion = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
const cargoPackage = readFileSync('src-tauri/Cargo.toml', 'utf8')
  .split('[package]')[1]
  .split('[')[0];
const cargoVersion = cargoPackage.match(/^version = "([^"]+)"/m)?.[1];
assert.equal(appVersion, tauriVersion, 'Package and Tauri versions differ');
assert.equal(appVersion, cargoVersion, 'Package and Cargo versions differ');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${appVersion}`, 'Tag and app versions differ');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesIn(directory, suffix) {
  assert(existsSync(directory), `Missing bundle directory: ${directory}`);
  return readdirSync(directory, { recursive: true })
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile() && path.endsWith(suffix));
}

function stage(targetName) {
  const target = targets[targetName];
  assert(target, `Unknown release target: ${targetName}`);
  assert.equal(process.platform, target.os, `Wrong operating system for ${targetName}`);
  assert.equal(process.arch, target.arch, `Wrong architecture for ${targetName}`);
  mkdirSync('release-output', { recursive: true });
  const files = Object.entries(target.bundles).map(([directory, suffix]) => {
    const matches = filesIn(join('src-tauri', 'target', 'release', 'bundle', directory), suffix);
    assert.equal(matches.length, 1, `Expected one ${suffix} bundle for ${targetName}`);
    const name = `Sail-v${appVersion}-${targetName}${suffix}`;
    const destination = join('release-output', name);
    copyFileSync(matches[0], destination);
    return { name, bytes: statSync(destination).size, sha256: sha256(destination) };
  });
  const metadata = {
    version: appVersion,
    target: targetName,
    sourceRevision: process.env.GITHUB_SHA ?? 'local',
    signing: process.env.SAIL_SIGNING_MODE ?? process.env.SAI_SIGNING_MODE ?? 'unsigned',
    opencode: '2.0.24 (external prerequisite)',
    files,
  };
  writeFileSync(join('release-output', 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(
    join('release-output', 'SHA256SUMS'),
    files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n',
  );
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

function verify(root) {
  const output = 'release-assets';
  mkdirSync(output, { recursive: true });
  const manifests = Object.keys(targets).map((targetName) => {
    const directory = join(root, targetName);
    const manifest = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
    assert.equal(manifest.target, targetName);
    assert.equal(manifest.version, appVersion);
    const expectedNames = Object.values(targets[targetName].bundles).map(
      (suffix) => `Sail-v${appVersion}-${targetName}${suffix}`,
    );
    assert.deepEqual(manifest.files.map((file) => file.name).toSorted(), expectedNames.toSorted());
    for (const file of manifest.files) {
      assert.equal(basename(file.name), file.name);
      const source = join(directory, file.name);
      assert.equal(statSync(source).size, file.bytes);
      assert.equal(sha256(source), file.sha256);
      copyFileSync(source, join(output, file.name));
    }
    return manifest;
  });
  const revisions = new Set(manifests.map((manifest) => manifest.sourceRevision));
  assert.equal(revisions.size, 1, 'Artifacts came from different commits');
  if (process.env.GITHUB_SHA) assert(revisions.has(process.env.GITHUB_SHA));
  const files = manifests.flatMap((manifest) => manifest.files);
  assert.equal(new Set(files.map((file) => file.name)).size, files.length);
  writeFileSync(join(output, 'release-manifest.json'), `${JSON.stringify(manifests, null, 2)}\n`);
  writeFileSync(
    join(output, 'SHA256SUMS'),
    files.map((file) => `${file.sha256}  ${file.name}`).join('\n') + '\n',
  );
  process.stdout.write(`Verified ${files.length} packages from ${[...revisions][0]}\n`);
}

if (process.argv[2] === 'stage') stage(process.argv[3]);
else if (process.argv[2] === 'verify') verify(process.argv[3] || 'downloaded');
else throw new Error('Usage: node scripts/package-release.mjs <stage TARGET|verify [DIRECTORY]>');

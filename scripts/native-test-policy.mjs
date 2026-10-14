import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function setupAttemptLimit(value = '2') {
  if (!/^[1-5]$/.test(value)) throw new Error('SAIL_NATIVE_SETUP_ATTEMPTS must be 1–5');
  return Number(value);
}

export function artifactKey(requirements) {
  return createHash('sha256').update(JSON.stringify(requirements)).digest('hex');
}

export function artifactMatches(manifest, requirements, binaryHash, identifier, signed) {
  return (
    manifest?.key === artifactKey(requirements) &&
    manifest.binaryHash === binaryHash &&
    manifest.identifier === identifier &&
    /^dev\.smykla\.sail\.e2e\.[a-f0-9]{32}$/.test(identifier) &&
    signed
  );
}

export function nativeEnvironment(root, checkout, inherited, port) {
  mkdirSync(root, { recursive: true });
  const canonicalRoot = realpathSync(root);
  const paths = {
    TMPDIR: 'tmp',
    SAIL_E2E_CONFIG_DIR: 'tmp/config',
    SAIL_WORKTREE_ROOT: 'worktrees',
    CLAUDE_CONFIG_DIR: 'claude',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    SAIL_E2E_FAKE_GH_DIR: 'fake-gh',
    SAIL_E2E_FAKE_GH_BIN: 'bin',
    SAIL_E2E_LIMIT_DIR: 'queue',
  };
  const env = { ...inherited };
  for (const [name, directory] of Object.entries(paths)) {
    mkdirSync(join(canonicalRoot, directory), { recursive: true });
    env[name] = realpathSync(join(canonicalRoot, directory));
  }
  Object.assign(env, {
    TAURI_WEBDRIVER_PORT: String(port),
    SAIL_ACP_TEST_AGENT: realpathSync(join(checkout, 'test/e2e/acp-agent.mjs')),
    SAIL_E2E_ATTACH: '1',
    SAIL_E2E_MACHINE_READING: 'healthy',
    SAIL_E2E_ACP_CLOSE_LOG: join(canonicalRoot, 'acp-close.log'),
    SAIL_E2E_OPEN_URL_LOG: join(canonicalRoot, 'external-link.log'),
    SAIL_E2E_SETUP_REPORT: join(canonicalRoot, 'setup.json'),
    SAIL_HOOK_CONNECTION_FILE: join(canonicalRoot, 'hook-connection.json'),
  });
  return env;
}

export function nativeVerdict(exitCode, setup, cancelled = false) {
  if (cancelled) return 'CANCELLED';
  if (setup?.status !== 'ready') return 'SETUP_FAILED';
  return exitCode === 0 ? 'PASS' : 'FAIL';
}

export function nativeFailurePhase(setup) {
  if (setup?.status === 'failed' && typeof setup.precondition === 'string')
    return setup.precondition;
  return null;
}

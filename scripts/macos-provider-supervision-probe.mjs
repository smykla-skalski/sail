#!/usr/bin/env node

// Private macOS research fixture. Never use its socket protocol for real providers.
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const fixture = join(source, 'fixtures/macos-provider-supervision');
const providedRoot = process.argv.indexOf('--scratch-root');
if (providedRoot < 0 || !process.argv[providedRoot + 1])
  throw new Error('pass --scratch-root from mktemp -d sail-497-spike.XXXXXX');
const root = realpathSync(resolve(process.argv[providedRoot + 1]));
const sdkFlag = process.argv.indexOf('--sdk');
const sdk = sdkFlag >= 0 ? resolve(process.argv[sdkFlag + 1] ?? '') : null;
if (!basename(root).startsWith('sail-497-spike.'))
  throw new Error('scratch root must be a sail-497-spike.* directory');
if (!existsSync(root)) throw new Error('scratch root does not exist');
const runId = randomUUID().replaceAll('-', '').slice(0, 16);
const runRoot = join(root, `probe-${runId}`);
mkdirSync(runRoot, { recursive: true, mode: 0o700 });
const bundleId = `dev.sail.contextprobe.${runId}`;
const label = `${bundleId}.agent`;
const plistName = `${label}.plist`;
const bundle = join(runRoot, `SailContextProbe-${runId}.app`);
const executable = join(bundle, 'Contents/MacOS/SailContextProbe');
const helper = join(bundle, 'Contents/Library/Helpers/ContextProbeAgent');
const provider = join(bundle, 'Contents/Library/Helpers/ContextProbeProvider');
const socketPath = 'agent.sock';
const stateRoot = join(runRoot, 'state');
const profile = join(runRoot, 'provider.sb');
const findings = [];
const started = Date.now();
const deadline = started + 90 * 60_000;
let registered = false;
let cleanup = 'not-started';
let preserve = false;
let inCleanup = false;
const activeHeartbeats = new Set();
const observedProviderPids = new Set();

function run(command, args, options = {}) {
  if (Date.now() > deadline && !inCleanup) throw new Error('90-minute timebox exceeded');
  const result = spawnSync(command, args, {
    cwd: runRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    env: {
      ...process.env,
      SWIFT_MODULECACHE_PATH: join(runRoot, 'module-cache'),
      CLANG_MODULE_CACHE_PATH: join(runRoot, 'clang-cache'),
      ...options.env,
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    pid: result.pid,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
}

function finding(id, pass, detail, extra = {}) {
  findings.push({ id, ...extra, status: pass ? 'PASS' : 'NO-GO', detail });
  return pass;
}

function requirePass(id, result, detail) {
  const pass = result.status === 0;
  finding(id, pass, detail, result);
  if (!pass) throw new Error(`${id}: ${detail}`);
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function key(directory) {
  const canonical = realpathSync(directory);
  const result = run('git', ['-C', directory, 'rev-parse', '--git-common-dir']);
  if (result.status !== 0) throw new Error(`git common dir: ${result.stderr}`);
  const common = realpathSync(resolve(canonical, result.stdout.trim()));
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(common), Buffer.from([0]), Buffer.from(canonical)]))
    .digest('hex');
}

function request(op, scope = '', extra = {}) {
  const result = run(executable, ['request', socketPath, JSON.stringify({ op, scope, ...extra })], {
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error(`request ${op}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

async function waitFor(check, timeoutMs = 10_000, until = Date.now() + timeoutMs) {
  if (Date.now() >= until) return null;
  try {
    const value = await check();
    if (value) return value;
  } catch {
    // A launch agent can reject a connection while launchd restarts it.
  }
  await new Promise((done) => setTimeout(done, 200));
  return waitFor(check, timeoutMs, until);
}

async function liveProvider(value) {
  if (!value?.provider || !value.heartbeat || !existsSync(value.heartbeat)) return null;
  const before = readFileSync(value.heartbeat, 'utf8');
  await new Promise((done) => setTimeout(done, 350));
  if (!existsSync(value.heartbeat) || readFileSync(value.heartbeat, 'utf8') === before) return null;
  activeHeartbeats.add(value.heartbeat);
  observedProviderPids.add(value.providerPid);
  return value;
}

function build() {
  for (const path of [
    dirname(executable),
    dirname(helper),
    join(bundle, 'Contents/Library/LaunchAgents'),
    stateRoot,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const flags = ['-parse-as-library', '-O', ...(sdk ? ['-sdk', sdk] : [])];
  requirePass(
    'build-app',
    run('swiftc', [...flags, '-o', executable, join(fixture, 'App.swift')], { timeout: 120_000 }),
    'compile private app',
  );
  requirePass(
    'build-agent',
    run('swiftc', [...flags, '-o', helper, join(fixture, 'Agent.swift')], { timeout: 120_000 }),
    'compile private launch agent',
  );
  requirePass(
    'build-provider',
    run('swiftc', [...flags, '-o', provider, join(fixture, 'Provider.swift')], {
      timeout: 120_000,
    }),
    'compile provider fixture',
  );
  writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>Sail Context Probe ${runId}</string><key>CFBundleExecutable</key><string>SailContextProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><false/></dict></plist>`,
  );
  writeFileSync(
    join(bundle, `Contents/Library/LaunchAgents/${plistName}`),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(helper)}</string><string>${xml(socketPath)}</string><string>${xml(provider)}</string><string>${xml(profile)}</string><string>${xml(stateRoot)}</string></array><key>WorkingDirectory</key><string>${xml(runRoot)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><false/><key>StandardOutPath</key><string>${xml(join(runRoot, 'agent.stdout'))}</string><key>StandardErrorPath</key><string>${xml(join(runRoot, 'agent.stderr'))}</string></dict></plist>`,
  );
  requirePass(
    'plist-valid',
    run('plutil', ['-lint', join(bundle, `Contents/Library/LaunchAgents/${plistName}`)]),
    'validate launch agent plist',
  );
  requirePass(
    'sign',
    run('codesign', ['--force', '--deep', '--sign', '-', bundle]),
    'ad-hoc sign unique private app bundle',
  );
  requirePass(
    'signature-valid',
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]),
    'verify private signature',
  );
}

function projectMatrix() {
  const repo = join(runRoot, 'repo');
  const sibling = join(runRoot, 'sibling');
  mkdirSync(repo);
  requirePass(
    'git-init',
    run('git', ['init', '-q', repo]),
    'initialize scratch fixture repository',
  );
  writeFileSync(join(repo, 'context.txt'), 'project read control');
  requirePass('git-add', run('git', ['-C', repo, 'add', 'context.txt']), 'stage scratch fixture');
  requirePass(
    'git-commit',
    run('git', [
      '-C',
      repo,
      '-c',
      'user.name=Probe',
      '-c',
      'user.email=probe@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ]),
    'commit scratch fixture',
  );
  requirePass(
    'git-worktree',
    run('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'sibling', sibling]),
    'create sibling scratch worktree',
  );
  mkdirSync(join(repo, 'subdir'));
  const exact = key(repo);
  const symlink = join(runRoot, 'repo-link');
  requirePass('symlink', run('ln', ['-s', repo, symlink]), 'create exact-path alias');
  finding(
    'scope-matrix',
    exact === key(symlink) && exact !== key(join(repo, 'subdir')) && exact !== key(sibling),
    'canonical exact path and symlink share; subdirectory and sibling worktree differ',
    { exact, alias: key(symlink), subdirectory: key(join(repo, 'subdir')), sibling: key(sibling) },
  );
  return { repo, sibling, exact, other: key(sibling) };
}

function seatbeltProfile(project) {
  const privateDir = stateRoot;
  writeFileSync(
    profile,
    `(version 1)\n(deny default)\n(allow file-read-data (literal "/"))\n(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (literal "${provider}") (subpath "${project.repo}") (subpath "${privateDir}"))\n(allow file-write* (subpath "${privateDir}"))\n(allow process-exec (literal "${provider}"))\n(allow sysctl-read (sysctl-name "kern.bootargs") (sysctl-name "security.mac.lockdown_mode_state"))\n`,
  );
}

async function sandboxTrials(project) {
  const outside = join(runRoot, 'outside.txt');
  const siblingFile = join(project.sibling, 'context.txt');
  const allowedFile = join(project.repo, 'context.txt');
  const privateFile = join(stateRoot, 'private-control.txt');
  writeFileSync(outside, 'outside');
  const server = createServer((stream) => stream.end());
  await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
  const port = String(server.address().port);
  const cases = [
    ['project-read', 'read', allowedFile, true],
    ['private-write', 'write', privateFile, true],
    ['sibling-read', 'read', siblingFile, false],
    ['outside-write', 'write', outside, false],
    ['outbound-tcp', 'connect', port, false],
    ['fork', 'fork', '-', false],
    ['posix-spawn', 'spawn', '-', false],
    ['exec', 'exec', '-', false],
  ];
  try {
    const trial = async ([id, operation, target, allowed]) => {
      const control = run(provider, ['probe', operation, target], { timeout: 5_000 });
      finding(`${id}-control`, control.status === 0, 'unconfined positive control', control);
      const confined = run(
        '/usr/bin/sandbox-exec',
        ['-f', profile, provider, 'probe', operation, target],
        { timeout: 5_000 },
      );
      await new Promise((done) => setTimeout(done, 300));
      const denialLog = run(
        '/usr/bin/log',
        [
          'show',
          '--style',
          'compact',
          '--last',
          '10s',
          '--predicate',
          'process == "kernel" AND eventMessage CONTAINS[c] "ContextProbeProvider" AND eventMessage CONTAINS[c] "deny"',
        ],
        { timeout: 15_000 },
      );
      const expectedObject =
        operation === 'fork' || operation === 'spawn'
          ? 'process-fork'
          : operation === 'exec'
            ? 'process-exec'
            : operation === 'connect'
              ? 'network'
              : target;
      const attributed = denialLog.stdout
        .split('\n')
        .some(
          (line) =>
            line.includes(`ContextProbeProvider(${confined.pid})`) && line.includes(expectedObject),
        );
      finding(
        id,
        control.status === 0 &&
          (allowed
            ? confined.status === 0
            : Number.isInteger(confined.status) &&
              confined.status !== 0 &&
              !confined.signal &&
              !confined.error &&
              attributed),
        allowed
          ? 'confined operation succeeds'
          : 'confined operation fails with operation-specific Seatbelt denial',
        { confined, denialLog: denialLog.stdout.slice(-4000), expectedObject, attributed },
      );
    };
    await cases.reduce((chain, test) => chain.then(() => trial(test)), Promise.resolve());
  } finally {
    server.close();
  }
}

async function serviceTrials(project) {
  const registration = run(executable, ['register', plistName]);
  const registeredStatus =
    registration.status === 0 ? JSON.parse(registration.stdout.trim()).status : null;
  finding(
    'registration',
    registration.status === 0 && registeredStatus === 'enabled',
    'SMAppService.agent(plistName:).register() yields enabled status through signed private app',
    registration,
  );
  if (registration.status !== 0) throw new Error('ordinary approval or registration unavailable');
  registered = true;
  const status = run(executable, ['status', plistName]);
  finding(
    'discovery',
    status.status === 0 && JSON.parse(status.stdout.trim()).status === 'enabled',
    'registered service discoverable and enabled',
    status,
  );
  if (registeredStatus !== 'enabled')
    throw new Error(`ordinary approval required: ${registeredStatus}`);
  const first = await waitFor(() => liveProvider(request('ensure', project.exact)), 15_000);
  if (!first?.provider) throw new Error('provider did not launch');
  const second = request('ensure', project.exact);
  finding(
    'two-window-reuse',
    first.service === second.service && first.provider === second.provider,
    'two independent signed app invocations see one service and provider',
    { first, second },
  );
  const crashedWindow = run(executable, ['crash', '-']);
  const afterWindowCrash = request('ensure', project.exact);
  finding(
    'window-crash',
    crashedWindow.signal === 'SIGKILL' &&
      afterWindowCrash.service === first.service &&
      afterWindowCrash.provider === first.provider,
    'one private app instance self-SIGKILL leaves service and surviving app provider unchanged',
    { crashedWindow, afterWindowCrash },
  );
  const other = await waitFor(() => liveProvider(request('ensure', project.other)), 8_000);
  finding(
    'project-isolation',
    Boolean(other?.provider && other.provider !== first.provider),
    'different project uses a live fixture provider',
    { first, other },
  );
  if (!other) throw new Error('other project provider did not run');

  request('kill-provider', project.exact);
  const restarted = await waitFor(async () => {
    const value = request('ensure', project.exact);
    return value.provider !== first.provider ? liveProvider(value) : null;
  }, 8_000);
  finding(
    'provider-restart',
    Boolean(restarted),
    'fixture provider self-SIGKILL is reaped and restarted with new generation',
    { before: first, after: restarted },
  );

  const cancelled = request('cancel', project.other);
  const stale = request('check-generation', project.other, { generation: other.provider });
  const replacement = await waitFor(async () => {
    const value = request('ensure', project.other);
    return value.provider !== other.provider ? liveProvider(value) : null;
  }, 8_000);
  const fresh = replacement
    ? request('check-generation', project.other, { generation: replacement.provider })
    : null;
  finding(
    'cancellation',
    Boolean(
      cancelled.cancelled === other.provider &&
      cancelled.reaped &&
      stale.current === false &&
      fresh?.current &&
      replacement,
    ),
    'fixture-only cancellation reaps child, rejects stale queued generation, and permits a live replacement',
    { cancelled, stale, replacement, fresh },
  );

  const beforeKill = request('ping');
  const active = restarted ?? first;
  request('kill-service');
  const afterKill = await waitFor(() => {
    const value = request('ping');
    return value.service !== beforeKill.service ? value : null;
  }, 15_000);
  const firstHeartbeat = existsSync(active.heartbeat)
    ? readFileSync(active.heartbeat, 'utf8')
    : null;
  await new Promise((done) => setTimeout(done, 1000));
  const secondHeartbeat = existsSync(active.heartbeat)
    ? readFileSync(active.heartbeat, 'utf8')
    : null;
  const oldProcess = run('ps', ['-p', String(active.providerPid), '-o', 'command=']);
  const oldProcessAbsent = !oldProcess.stdout.includes(provider);
  const stopped = Boolean(
    afterKill && firstHeartbeat && firstHeartbeat === secondHeartbeat && oldProcessAbsent,
  );
  finding(
    'service-restart-cleanup',
    stopped,
    'launchd restarts service and previously live provider heartbeat and owned executable disappear before new admission',
    { beforeKill, afterKill, firstHeartbeat, secondHeartbeat, oldProcess, oldProcessAbsent },
  );
  if (!stopped) preserve = true;
  if (afterKill) {
    const resumed = await waitFor(async () => {
      const value = request('ensure', project.exact);
      return value.provider !== active.provider ? liveProvider(value) : null;
    }, 8_000);
    finding(
      'survivor-resumes',
      Boolean(resumed),
      'surviving app invocation resumes with a live new provider',
      { resumed },
    );
  }
}

async function main() {
  const host = {
    swVers: run('sw_vers', []),
    architecture: run('uname', ['-m']),
    signingIdentities: run('security', ['find-identity', '-v', '-p', 'codesigning']),
    sourceRevision: run('git', ['-C', source, 'rev-parse', 'HEAD']),
    sdk,
  };
  let failure = null;
  try {
    if (process.platform !== 'darwin') throw new Error('macOS only');
    build();
    const project = projectMatrix();
    seatbeltProfile(project);
    await sandboxTrials(project);
    await serviceTrials(project);
  } catch (error) {
    failure = String(error);
  } finally {
    inCleanup = true;
    if (registered) {
      const result = run(executable, ['unregister', plistName]);
      cleanup = result.status === 0 ? 'unregistered' : 'unregister-failed';
      finding(
        'unregister',
        result.status === 0,
        'SMAppService.unregister() removes only this private service',
        result,
      );
      if (result.status !== 0) preserve = true;
      const heartbeatBefore = [...activeHeartbeats]
        .filter(existsSync)
        .map((path) => [path, readFileSync(path, 'utf8')]);
      await new Promise((done) => setTimeout(done, 1000));
      const stable = heartbeatBefore.every(
        ([path, value]) => !existsSync(path) || readFileSync(path, 'utf8') === value,
      );
      const remaining = [...observedProviderPids]
        .map((pid) => ({ pid, observation: run('ps', ['-p', String(pid), '-o', 'command=']) }))
        .filter(({ observation }) => observation.stdout.includes(provider));
      const uid = run('id', ['-u']).stdout.trim();
      const unloaded = await waitFor(() => {
        const observed = run('launchctl', ['print', `gui/${uid}/${label}`]);
        return observed.status !== 0 ? observed : null;
      }, 5_000);
      finding(
        'cleanup-absent',
        stable && Boolean(unloaded) && remaining.length === 0,
        'unregister unloads this launch agent and all observed provider heartbeats and executables stop',
        { heartbeatCount: heartbeatBefore.length, stable, remaining, launchd: unloaded },
      );
      if (!stable || !unloaded || remaining.length) preserve = true;
    } else {
      cleanup = 'not-registered';
    }
    const mandatory = [
      'build-app',
      'build-agent',
      'build-provider',
      'plist-valid',
      'sign',
      'signature-valid',
      'scope-matrix',
      'registration',
      'discovery',
      'two-window-reuse',
      'window-crash',
      'project-isolation',
      'provider-restart',
      'cancellation',
      'service-restart-cleanup',
      'survivor-resumes',
      'unregister',
      'cleanup-absent',
      'project-read',
      'private-write',
      'sibling-read',
      'outside-write',
      'outbound-tcp',
      'fork',
      'posix-spawn',
      'exec',
    ];
    const verdict =
      !failure &&
      Date.now() <= deadline &&
      mandatory.every((id) => findings.some((item) => item.id === id && item.status === 'PASS')) &&
      !preserve
        ? 'GO'
        : 'NO-GO';
    const report = {
      schemaVersion: 1,
      issue: 497,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date().toISOString(),
      timeboxMinutes: 90,
      host,
      runRoot,
      bundleId,
      launchdLabel: label,
      cleanup,
      preserve,
      failure,
      verdict,
      findings,
      limits: [
        'fixture-only service and cancellation semantics',
        'no peer pairing or production call authorization proof',
        'no Linux or Windows proof',
      ],
    };
    writeFileSync(join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = verdict === 'GO' ? 0 : 1;
  }
}

await main();

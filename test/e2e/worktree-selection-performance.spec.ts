import { browser, $, expect } from '@wdio/globals';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertPrivateE2eConfigRoot } from '../e2e-isolation.ts';

const nativeResponseBudget = 1000;
const missingSession = 'selection-performance-missing-session';
const slowGitDirectory = process.env.SAIL_E2E_SLOW_GIT_DIR ?? '';
const agentStartLog = process.env.SAIL_E2E_ACP_START_LOG;

type PendingResult = {
  settled: boolean;
  value?: unknown;
  error?: string;
};

async function startNativeRequest(
  command: string,
  args: Record<string, unknown>,
  key = '__selectionPerformanceRequest',
) {
  await browser.tauri.execute(
    ({ core }, request) => {
      Reflect.set(window, request.key, { settled: false });
      void core.invoke(request.command, request.args).then(
        (value) => Reflect.set(window, request.key, { settled: true, value }),
        (error: unknown) =>
          Reflect.set(window, request.key, {
            settled: true,
            error: String(error),
          }),
      );
    },
    { command, args, key },
  );
}

async function nativeRequestResult(key = '__selectionPerformanceRequest'): Promise<PendingResult> {
  // The embedded driver treats a top-level error field as a transport failure.
  const result = await browser.execute((name) => ({ request: Reflect.get(window, name) }), key);
  return result.request;
}

async function assertNativeWindowResponds() {
  const started = performance.now();
  const visible = await browser.tauri.execute(({ core }) =>
    core.invoke('plugin:window|is_visible', { label: 'main' }),
  );
  const elapsed = performance.now() - started;
  console.log('Native window response while worktree lookup is blocked', { elapsed });
  expect(visible).toBe(true);
  expect(elapsed).toBeLessThan(nativeResponseBudget);
}

async function waitForMarker(path: string) {
  await browser.waitUntil(() => existsSync(path), {
    timeout: 5000,
    interval: 20,
    timeoutMsg: `Blocking fixture did not enter: ${path}`,
  });
}

function startedAgentCount(agent: string, directory: string): number | null {
  if (!agentStartLog) return null;
  if (!existsSync(agentStartLog)) return 0;
  const starts: { agent: string; directory: string; pid: number }[] = readFileSync(
    agentStartLog,
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return starts.filter((start) => start.agent === agent && start.directory === directory).length;
}

function assertOneNewAgent(agent: string, directory: string, previous: number | null) {
  const current = startedAgentCount(agent, directory);
  if (current === null || previous === null) {
    console.log(
      'Skipping startup process count: SAIL_E2E_ACP_START_LOG telemetry is not configured.',
    );
    return;
  }
  expect(current - previous).toBe(1);
}

function gitGate(directory: string, path: string, argument?: string) {
  const markers = ['block-path', 'block-argument', 'blocked', 'release', 'timed-out'];
  const clear = () => markers.forEach((marker) => rmSync(join(directory, marker), { force: true }));
  clear();
  if (argument) writeFileSync(join(directory, 'block-argument'), argument);
  writeFileSync(join(directory, 'block-path'), path);
  return {
    entered: () => waitForMarker(join(directory, 'blocked')),
    release: async () => {
      rmSync(join(directory, 'block-path'), { force: true });
      writeFileSync(join(directory, 'release'), '');
      await browser.waitUntil(
        () => !readdirSync(directory).some((name) => name.startsWith('active-')),
        {
          timeout: 5000,
          interval: 20,
          timeoutMsg: 'Delayed Git processes did not leave the gate after release',
        },
      );
      clear();
    },
    timedOut: () => existsSync(join(directory, 'timed-out')),
  };
}

async function holdSettingsLock(configDirectory: string, fixtureDirectory: string) {
  const ready = join(fixtureDirectory, 'settings-lock-ready');
  const release = join(fixtureDirectory, 'settings-lock-release');
  const timedOut = join(fixtureDirectory, 'settings-lock-timed-out');
  const holder = spawn(
    'python3',
    [
      '-c',
      `
import fcntl, pathlib, sys, time
lock_path, ready, release, timed_out = map(pathlib.Path, sys.argv[1:])
with lock_path.open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    ready.touch()
    deadline = time.monotonic() + 15
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    if not release.exists():
        timed_out.touch()
`,
      join(configDirectory, 'settings.lock'),
      ready,
      release,
      timedOut,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  holder.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Settings lock fixture exited ${code}: ${stderr}`));
    });
  });
  const releaseLock = async () => {
    writeFileSync(release, '');
    await exited;
  };
  try {
    await Promise.race([
      waitForMarker(ready),
      exited.then(() => {
        throw new Error('Settings lock exited before becoming ready');
      }),
    ]);
  } catch (error) {
    await releaseLock();
    throw error;
  }
  return { release: releaseLock, timedOut: () => existsSync(timedOut) };
}

describe('worktree selection performance', () => {
  let fixtureDirectory = '';
  let repository: string;
  let first: string;
  let second: string;
  let configDirectory: string;

  before(function () {
    if (process.platform === 'win32') {
      console.log(
        'Skipping worktree selection performance: fixtures require POSIX Git and fcntl locks.',
      );
      this.skip();
    }
    configDirectory = process.env.SAIL_E2E_CONFIG_DIR ?? '';
    assertPrivateE2eConfigRoot(configDirectory, tmpdir());
    fixtureDirectory = realpathSync(
      mkdtempSync(join(dirname(configDirectory), 'selection-performance-')),
    );
    repository = join(fixtureDirectory, 'repository');
    first = join(fixtureDirectory, 'first');
    second = join(fixtureDirectory, 'second');
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repository]);
    execFileSync('/usr/bin/git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'baseline',
    ]);
    execFileSync('/usr/bin/git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'first', first]);
    execFileSync('/usr/bin/git', [
      '-C',
      repository,
      'worktree',
      'add',
      '-q',
      '-b',
      'second',
      second,
    ]);
  });

  beforeEach(async () => {
    await browser.execute(
      (paths) => {
        localStorage.setItem('sai-directory', paths.repository);
        localStorage.setItem(`sai-main-pane-empty:${paths.repository}`, 'true');
        localStorage.setItem(`sai-main-pane-empty:${paths.first}`, 'true');
        localStorage.setItem(`sai-main-pane-empty:${paths.second}`, 'true');
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [paths.repository],
            groups: [],
            worktrees: {
              [paths.repository]: [
                { path: paths.first, branch: 'first' },
                { path: paths.second, branch: 'second' },
              ],
            },
          }),
        );
      },
      { repository, first, second },
    );
    await browser.refresh();
    await expect($(`.project-worktree-select[title="${first}"]`)).toBeDisplayed();
    await expect($('[data-pane-id="main"] [data-pane-picker]')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const ready = Reflect.get(window, '__SAIL_E2E_SIDEBAR_INVENTORY_READY__');
        return typeof ready === 'function' && ready();
      }),
    );
  });

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    console.error('Worktree selection regression diagnostic', {
      test: this.currentTest.fullTitle(),
      gitMarkers: slowGitDirectory ? readdirSync(slowGitDirectory) : [],
      state: await browser.execute(() => ({
        directory: localStorage.getItem('sai-directory'),
        selected: document.querySelector('[aria-current="page"]')?.getAttribute('title'),
        request: Reflect.get(window, '__selectionPerformanceRequest'),
        alerts: [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
      })),
    });
  });

  after(async () => {
    if (!fixtureDirectory) return;
    try {
      await browser.execute(() => {
        Reflect.deleteProperty(window, '__selectionPerformanceRequest');
        Reflect.deleteProperty(window, '__selectionPerformanceConcurrentConnect');
        localStorage.clear();
      });
      await browser.tauri.execute(({ core }) => core.invoke('acp_reset_test_runtimes'));
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });

  describe('with a private Git delay shim (SAIL_E2E_SLOW_GIT_DIR)', () => {
    before(function () {
      if (!slowGitDirectory) this.skip();
    });

    it('keeps the native window responsive and the latest sidebar selection visible during a slow lookup', async () => {
      const gate = gitGate(slowGitDirectory, first);

      try {
        await $(`.project-worktree-select[title="${first}"]`).click();
        await gate.entered();

        await assertNativeWindowResponds();
        await expect($(`.project-worktree-select[title="${first}"]`)).toHaveAttribute(
          'aria-current',
          'page',
        );
        await expect($('[data-pane-id="main"] [data-pane-picker]')).toBeDisplayed();
        await $(`.project-worktree-select[title="${second}"]`).click();
        await expect($(`.project-worktree-select[title="${second}"]`)).toHaveAttribute(
          'aria-current',
          'page',
        );
        expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(second);
        expect(gate.timedOut()).toBe(false);
      } finally {
        await gate.release();
      }

      await browser.tauri.execute(
        ({ core }, path) => core.invoke('worktree_config', { worktree: path }),
        first,
      );
      await expect($(`.project-worktree-select[title="${second}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(second);
    });

    const pendingRequests = [
      { command: 'acp_pending_permissions', name: 'permission recovery' },
      { command: 'acp_pending_elicitations', name: 'question recovery' },
    ];
    for (const { command, name } of pendingRequests) {
      it(`keeps native commands and the agent inbox responsive during slow ${name}`, async () => {
        const gate = gitGate(slowGitDirectory, first);

        try {
          await startNativeRequest(command, {
            agent: 'claude',
            directory: first,
            sessionId: missingSession,
            profile: 'build',
          });
          await gate.entered();

          await assertNativeWindowResponds();
          const started = performance.now();
          const inbox = await browser.tauri.execute(({ core }) => core.invoke('acp_pending_inbox'));
          const elapsed = performance.now() - started;
          expect(inbox).toEqual([]);
          expect(elapsed).toBeLessThan(nativeResponseBudget);
          expect((await nativeRequestResult()).settled).toBe(false);
          expect(gate.timedOut()).toBe(false);
        } finally {
          await gate.release();
        }

        await browser.waitUntil(async () => (await nativeRequestResult()).settled);
        expect((await nativeRequestResult()).error).toBe(
          'Agent session is not connected in this worktree.',
        );
      });
    }

    it('keeps the native window responsive while ending a restore resolves a slow worktree', async () => {
      const gate = gitGate(slowGitDirectory, first);

      try {
        await startNativeRequest('acp_end_session_restore', {
          agent: 'claude',
          directory: first,
          sessionId: missingSession,
          restoreToken: 'missing-token',
        });
        await gate.entered();

        await assertNativeWindowResponds();
        expect((await nativeRequestResult()).settled).toBe(false);
        expect(gate.timedOut()).toBe(false);
      } finally {
        await gate.release();
      }

      await browser.waitUntil(async () => (await nativeRequestResult()).settled);
      expect(await nativeRequestResult()).toEqual({ settled: true, value: null });
    });

    it('keeps other worktree runtimes available while a shared runtime startup waits for Git', async () => {
      const gate = gitGate(slowGitDirectory, first, '--git-common-dir');
      const concurrentKey = '__selectionPerformanceConcurrentConnect';
      const args = { agent: 'claude', directory: first, profile: 'review' };
      const startedBefore = startedAgentCount('claude', first);

      try {
        await startNativeRequest('acp_connect', args);
        await startNativeRequest('acp_connect', args, concurrentKey);
        await gate.entered();

        await assertNativeWindowResponds();
        const inboxStarted = performance.now();
        const inbox = await browser.tauri.execute(({ core }) => core.invoke('acp_pending_inbox'));
        const inboxElapsed = performance.now() - inboxStarted;
        expect(inbox).toEqual([]);
        expect(inboxElapsed).toBeLessThan(nativeResponseBudget);
        const startupStarted = performance.now();
        const independent = await browser.tauri.execute(
          ({ core }, path) =>
            core.invoke('acp_connect', { agent: 'claude', directory: path, profile: 'review' }),
          second,
        );
        const startupElapsed = performance.now() - startupStarted;
        console.log('Independent startup completed while the delayed startup stayed pending', {
          startupElapsed,
        });
        expect(independent).toEqual(expect.objectContaining({ protocolVersion: 1 }));
        expect((await nativeRequestResult()).settled).toBe(false);
        expect((await nativeRequestResult(concurrentKey)).settled).toBe(false);
        expect(gate.timedOut()).toBe(false);
      } finally {
        await gate.release();
        await browser.waitUntil(
          async () =>
            (await nativeRequestResult()).settled &&
            (await nativeRequestResult(concurrentKey)).settled,
        );
      }

      expect((await nativeRequestResult()).value).toEqual(
        expect.objectContaining({ protocolVersion: 1 }),
      );
      expect((await nativeRequestResult(concurrentKey)).value).toEqual(
        expect.objectContaining({ protocolVersion: 1 }),
      );
      assertOneNewAgent('claude', first, startedBefore);
    });

    it('cancels a runtime startup during cleanup and allows a fresh retry', async () => {
      // Earlier runtimes can still be cleaning up after reset. A worktree absent
      // from the sidebar makes this gate belong only to the startup under test.
      const cancelled = join(fixtureDirectory, 'cancelled');
      execFileSync('/usr/bin/git', [
        '-C',
        repository,
        'worktree',
        'add',
        '-q',
        '-b',
        'cancelled',
        cancelled,
      ]);
      const gate = gitGate(slowGitDirectory, cancelled, '--git-common-dir');
      const resetKey = '__selectionPerformanceConcurrentConnect';
      const args = { agent: 'claude', directory: cancelled, profile: 'build' };

      try {
        await startNativeRequest('acp_connect', args);
        await gate.entered();

        await startNativeRequest('acp_reset_test_runtimes', {}, resetKey);
        await assertNativeWindowResponds();
        await browser.waitUntil(async () => (await nativeRequestResult(resetKey)).settled);
        expect(await nativeRequestResult(resetKey)).toEqual({ settled: true, value: null });
        expect((await nativeRequestResult()).settled).toBe(false);
        expect(gate.timedOut()).toBe(false);
      } finally {
        await gate.release();
        await browser.waitUntil(async () => (await nativeRequestResult()).settled);
      }

      expect((await nativeRequestResult()).error).toBe('Agent startup was cancelled.');
      const activity = await browser.tauri.execute(
        ({ core }, path) => core.invoke('acp_activity', { directory: path }),
        cancelled,
      );
      expect(activity).not.toEqual(
        expect.objectContaining({ claude: expect.objectContaining({ alive: true }) }),
      );
      const retried = await browser.tauri.execute(
        ({ core }, connectArgs) => core.invoke('acp_connect', connectArgs),
        args,
      );
      expect(retried).toEqual(expect.objectContaining({ protocolVersion: 1 }));
    });
  });

  it('ignores a stale linked-worktree Git pointer during background session inventory', async () => {
    const broken = join(fixtureDirectory, 'broken');
    mkdirSync(broken);
    writeFileSync(
      join(broken, '.git'),
      `gitdir: ${join(fixtureDirectory, 'removed-git-metadata')}\n`,
    );
    const providers = await browser.tauri.execute(({ core }) => core.invoke('acp_agents'));
    expect(providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'opencode', available: true })]),
    );

    const available = await browser.tauri.execute(
      ({ core }, path) => core.invoke('repository_path_available', { path }),
      broken,
    );
    await browser.execute(
      (paths) => {
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [paths.repository],
            groups: [],
            worktrees: {
              [paths.repository]: [
                { path: paths.first, branch: 'first' },
                { path: paths.second, branch: 'second' },
                { path: paths.broken, branch: 'removed' },
              ],
            },
          }),
        );
      },
      { repository, first, second, broken },
    );
    await browser.refresh();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const ready = Reflect.get(window, '__SAIL_E2E_SIDEBAR_INVENTORY_READY__');
        return typeof ready === 'function' && ready();
      }),
    );

    expect(available).toBe(false);
    await assertNativeWindowResponds();
    await expect($('.app-shell [role="alert"]')).not.toExist();
    await expect($(`.project-default-worktree-select[title="${repository}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps the native window responsive while memory status waits for the private settings lock', async () => {
    const lock = await holdSettingsLock(configDirectory, fixtureDirectory);

    try {
      await startNativeRequest('memory_status', { directory: first });

      await assertNativeWindowResponds();
      expect((await nativeRequestResult()).settled).toBe(false);
      expect(lock.timedOut()).toBe(false);
    } finally {
      await lock.release();
    }

    await browser.waitUntil(async () => (await nativeRequestResult()).settled);
    expect((await nativeRequestResult()).value).toEqual(
      expect.objectContaining({ mode: 'off', enabled: false, count: 0, forgottenCount: 0 }),
    );
  });
});

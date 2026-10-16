import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShipRun, ShippingClaim } from '../../src/lib/issue-shipping';
import { initialTaskCheckpoint } from '../../src/lib/task-checkpoint';
import { loadShipRuns } from '../../src/lib/ship-progress';
import { shipMergeAction } from '../../src/lib/ship-actions';
import { nativeTab } from './native-keyboard';
import { openSettings, returnToWorkspace } from './settings-window';
import { assertNativeWebviews } from './native-preconditions';

const identity = () =>
  browser.execute(() => {
    const read: unknown = Reflect.get(window, '__SAIL_E2E_SHIP_IDENTITY__');
    if (typeof read !== 'function') throw new Error('Missing Ship identity probe');
    return String(read());
  });

const restore = () =>
  browser.execute(async () => {
    const reload: unknown = Reflect.get(window, '__SAIL_E2E_RESTORE_SHIP__');
    if (typeof reload !== 'function') throw new Error('Missing same-document Ship restore');
    await reload();
  });

const savedRuns = async () => {
  const saved = await browser.tauri.execute(async ({ core }) =>
    core.invoke<Record<string, string>>('load_settings'),
  );
  return loadShipRuns(saved['sai-ship-runs'] ?? null);
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('native Ship acceptance', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sail-native-acceptance-')));
  const repository = join(root, 'repository');

  before(async () => {
    await browser.execute(() => sessionStorage.setItem('sail-e2e-settings', 'enabled'));
    await browser.refresh();
    await assertNativeWebviews();
    mkdirSync(repository);
    git(repository, 'init', '-q', '-b', 'main');
    git(
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
    );
    git(repository, 'remote', 'add', 'origin', 'https://github.com/fixture/repo.git');
    git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  });

  after(async () => {
    await browser.tauri.switchWindow('main');
    await browser.tauri.execute(async ({ core }) => {
      await core.invoke('save_setting', { key: 'sai-ship-runs', value: '[]' });
    });
    await restore();
    await browser.execute(() => sessionStorage.removeItem('sail-e2e-settings'));
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    console.error(
      'Native acceptance failure',
      await browser.execute(() => ({
        url: location.href,
        active: document.activeElement?.outerHTML,
        headings: [...document.querySelectorAll('h2')].map((item) => item.textContent),
        alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent),
        runs: localStorage.getItem('sai-ship-runs'),
      })),
    );
  });

  it('traverses the final threshold control through native Tab with visible focus', async () => {
    await openSettings();
    await $('.settings-navigation').$('button=Agents').click();
    const threshold = $('#context-handoff-threshold');
    await threshold.waitForDisplayed();
    await threshold.click();
    await nativeTab(true);
    expect(await threshold.isFocused()).toBe(false);
    const preceding = await browser.execute(() => document.activeElement?.id);
    await nativeTab();
    await expect(threshold).toBeFocused();
    const nativeTitle = await browser.tauri.execute(async ({ core }) =>
      core.invoke<string>('plugin:window|title', { label: 'settings' }),
    );
    const handle = await browser.getWindowHandle();
    const measured = await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('#context-handoff-threshold')!;
      const style = getComputedStyle(input);
      return {
        window: new URL(location.href).searchParams.get('window'),
        active: document.activeElement?.id,
        visible: input.matches(':focus-visible'),
        outline: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        shadow: style.boxShadow,
      };
    });
    console.log('Native threshold traversal', { preceding, nativeTitle, handle, ...measured });
    expect(nativeTitle).toBe('Sail Settings');
    expect(handle).toBe('settings');
    expect(measured.window).toBe('settings');
    expect(measured.visible).toBe(true);
    expect(measured.outline !== 'none' || measured.shadow !== 'none').toBe(true);
    await nativeTab();
    expect(await threshold.isFocused()).toBe(false);
    await nativeTab(true);
    await expect(threshold).toBeFocused();
    await returnToWorkspace();
  });

  it('recovers pending handoffs for the same owner and fences foreign and failed workers', async () => {
    await browser.tauri.switchWindow('main');
    const fakeGh = process.env.SAIL_E2E_FAKE_GH_DIR;
    if (!fakeGh) throw new Error('Native acceptance requires the private fake gh fixture');
    writeFileSync(
      join(fakeGh, 'state.json'),
      JSON.stringify({ repository: 'fixture/repo', pulls: {} }),
    );
    const owner = await identity();
    const run: ShipRun = {
      id: 'native-phase-recovery',
      source: 'plan',
      repository,
      remote: 'fixture/repo',
      provider: 'claude',
      limit: 1,
      approvedAt: Date.now(),
      externalClosed: {},
      issues: [],
    };
    const pulls: Record<string, unknown> = {};
    run.issues = await Promise.all(
      ['same-owner', 'failed-successor', 'foreign-owner'].map(async (name, index) => {
        const path = join(root, name);
        git(repository, 'worktree', 'add', '-q', '-b', name, path);
        const session = await browser.tauri.execute(
          async ({ core }, cwd) =>
            core.invoke<{ sessionId: string }>('acp_new_session', {
              params: { agent: 'claude', cwd, profile: 'build' },
            }),
          path,
        );
        await browser.tauri.execute(
          async ({ core }, input) =>
            core.invoke('acp_prompt', {
              params: {
                agent: 'claude',
                directory: input.path,
                sessionId: input.sessionId,
                text: 'Task reporting fixture: recover',
                turnId: crypto.randomUUID(),
                imagePaths: [],
              },
            }),
          { path, sessionId: session.sessionId },
        );
        const number = index + 1;
        const now = Date.now();
        if (name === 'failed-successor')
          writeFileSync(join(path, '.sail-e2e-fail-next-session'), 'fail');
        const claim = await browser.tauri.execute(
          async ({ core }, input) =>
            core.invoke<ShippingClaim>('acquire_shipping_claim', {
              repository: input.repository,
              expectedRepository: 'fixture/repo',
              number: input.number,
              claim: {
                id: crypto.randomUUID(),
                instanceId: input.owner,
                holder: 'Native acceptance',
                task: `ship:native-phase-recovery:${input.name}`,
                acquiredAt: new Date().toISOString(),
                heartbeatAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 120000).toISOString(),
                status: 'active',
                commentId: 0,
              },
            }),
          {
            repository,
            number,
            name,
            owner: name === 'foreign-owner' ? 'foreign-instance' : owner,
          },
        );
        const revision = await browser.tauri.execute(
          async ({ core }, cwd) => core.invoke<string>('working_tree_revision', { path: cwd }),
          path,
        );
        const threadId = `acp:claude:${session.sessionId}`;
        const issue = {
          id: name,
          number,
          url: `https://github.com/fixture/repo/issues/${number}`,
          title: name,
          dependsOn: [],
          state: 'working' as const,
          branch: name,
          path,
          receiptId: null,
          threadId,
          pullRequest: `https://github.com/fixture/repo/pull/${number}`,
          error: null,
          workerSettled: true,
          workerState: 'completed' as const,
          claim,
          shippingTarget: {
            repository: 'fixture/repo',
            remote: 'origin',
            baseBranch: 'main',
            baseRef: 'refs/remotes/origin/main',
            baseRevision: git(repository, 'rev-parse', 'HEAD'),
          },
          checkpoint: {
            ...initialTaskCheckpoint(
              { id: name, url: `https://github.com/fixture/repo/issues/${number}`, title: name },
              now,
            ),
            sequence: 2,
            phase: 'review' as const,
            revision,
            nextAction: 'Review the existing draft.',
          },
          contextHandoffs: [
            {
              id: `phase-${name}`,
              provider: 'claude' as const,
              boundary: 'draft-published' as const,
              brief: 'Review the same draft using its checkpoint.',
              fromThreadId: threadId,
              toThreadId: null,
              context: 50,
              compactions: 0,
              checkpointSequence: 1,
              revision,
              offeredAt: now,
              startedAt: null,
              retriesBefore: 0,
              lostStateFailuresBefore: 0,
              retriesAfter: null,
              lostStateFailuresAfter: null,
              outcome: 'pending' as const,
              error: null,
            },
          ],
        };
        pulls[`fixture/repo#${number}`] = {
          branch: name,
          head: git(path, 'rev-parse', 'HEAD'),
          state: 'open',
          draft: true,
          merged: false,
        };
        return issue;
      }),
    );
    writeFileSync(
      join(fakeGh, 'state.json'),
      JSON.stringify({ repository: 'fixture/repo', pulls }),
    );
    expect(loadShipRuns(JSON.stringify([run]))).toHaveLength(1);
    await browser.tauri.execute(
      async ({ core }, value) =>
        core.invoke('save_setting', { key: 'sai-ship-runs', value: JSON.stringify([value]) }),
      run,
    );
    await restore();
    const [restored] = await savedRuns();
    console.log(
      'Native same-owner recovery',
      JSON.stringify({ owner, after: await identity(), run: restored }),
    );
    expect(await identity()).toBe(owner);
    expect(restored.id).toBe(run.id);
    expect(restored.issues).toHaveLength(3);
    for (const [index, previous] of run.issues.entries()) {
      const current = restored.issues[index];
      expect(current.path).toBe(previous.path);
      expect(current.pullRequest).toBe(previous.pullRequest);
      expect(current.claim?.id).toBe(previous.claim?.id);
      expect(current.claim?.instanceId).toBe(previous.claim?.instanceId);
      expect(current.checkpoint?.taskId).toBe(previous.checkpoint?.taskId);
      if (previous.id === 'same-owner') {
        expect(current.contextHandoffs?.[0].toThreadId).toBe(current.threadId);
        expect(current.threadId).not.toBe(previous.threadId);
        expect(current.checkpoint).toEqual(previous.checkpoint);
      } else {
        expect(current.threadId).toBe(previous.threadId);
        expect(current.contextHandoffs?.[0].toThreadId).toBeNull();
        if (previous.id === 'failed-successor') {
          expect(current.checkpoint?.status).toBe('blocked');
          expect(current.blockedReason).toContain('Phase handoff paused');
          expect(current.blockedReason).toContain('Injected successor failure');
          expect(shipMergeAction(current).enabled).toBe(false);
          expect(shipMergeAction(current).reason).toContain('Phase handoff paused');
        } else expect(current.claim?.instanceId).not.toBe(owner);
      }
    }
    await restore();
    const repeated = await savedRuns();
    expect(repeated).toHaveLength(1);
    expect(repeated[0].issues.map((issue) => issue.threadId)).toEqual(
      restored.issues.map((issue) => issue.threadId),
    );
    expect(repeated[0].issues.map((issue) => issue.receiptId)).toEqual(
      restored.issues.map((issue) => issue.receiptId),
    );
    expect(repeated[0].issues.map((issue) => issue.contextHandoffs?.length)).toEqual([1, 1, 1]);
    expect(repeated[0].issues[1].checkpoint?.status).toBe('blocked');
    expect(await identity()).toBe(owner);
  });
});

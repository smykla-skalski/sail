import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShipRun } from '../../src/lib/issue-shipping';
import { loadProjectCatalog } from '../../src/lib/projects.ts';
import { loadShipRuns } from '../../src/lib/ship-progress.ts';

async function diagnose<T>(label: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (cause) {
    console.error(
      `${label} diagnostic`,
      await browser.execute(() => ({
        catalog: localStorage.getItem('sai-project-catalog'),
        alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent),
      })),
    );
    throw cause;
  }
}

async function openPendingConfirmation(path: string, buttonLabel: string) {
  const dialog = $('dialog.confirmation-dialog[open]');
  const button = $(`[data-pending-worktree="${path}"]`).$(`button=${buttonLabel}`);
  await browser.waitUntil(
    async () => {
      if (await dialog.isExisting()) return true;
      await button.click();
      try {
        await browser.waitUntil(() => dialog.isExisting(), { timeout: 1500, interval: 100 });
        return true;
      } catch {
        const alert = $('.app-shell [role="alert"]');
        if (
          (await alert.isExisting()) &&
          (await alert.getText()).includes('A worktree operation is in progress')
        )
          return false;
        throw new Error(`Pending confirmation did not open for ${path}`);
      }
    },
    { timeout: 20000, interval: 100 },
  );
}

describe('merged Ship pending cleanup', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'sail-ship-pending-')));
  const worktrees = realpathSync(mkdtempSync(join(tmpdir(), 'sail-ship-pending-trees-')));
  const first = join(worktrees, 'first');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' });

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    git(
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'baseline',
    );
    git('worktree', 'add', '-q', '-b', 'first', first);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(worktrees, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const catalogPaths = async () => {
    const saved = await browser.execute(() => localStorage.getItem('sai-project-catalog'));
    return (loadProjectCatalog(saved, repository).worktrees[repository] ?? []).map(
      (item) => item.path,
    );
  };

  const pendingCleanup = async (path: string) => {
    const saved = await browser.execute(() => localStorage.getItem('sai-project-catalog'));
    return loadProjectCatalog(saved, repository).worktrees[repository]?.find(
      (item) => item.path === path,
    )?.pendingCleanup;
  };

  async function cleanPending(path: string): Promise<boolean> {
    await openPendingConfirmation(path, 'Clean up this worktree…');
    await diagnose('Pending cleanup dialog', async () => {
      const dialog = $('dialog.confirmation-dialog[open]');
      await expect(dialog).toExist();
      await expect(dialog).toHaveText(
        expect.stringContaining(
          'no other process will write to, move, or replace either until cleanup finishes',
        ),
      );
      await dialog.$('button=Remove this worktree').click();
    });
    await diagnose('Pending checkout result', () =>
      browser.waitUntil(
        async () =>
          !(await catalogPaths()).includes(path) ||
          !!(await pendingCleanup(path))?.storagePaths?.length ||
          (await pendingCleanup(path))?.reason.includes('Cleanup stopped') === true,
      ),
    );
    if ((await pendingCleanup(path))?.reason.includes('Cleanup stopped')) return false;
    if ((await pendingCleanup(path))?.storagePaths?.length) {
      await openPendingConfirmation(path, 'Retry selected storage cleanup…');
      await diagnose('Selected storage dialog', async () => {
        const dialog = $('dialog.confirmation-dialog[open]');
        await expect(dialog).toExist();
        await dialog.$('button=Clean up selected storage').click();
      });
    }
    await diagnose('Pending cleanup result', () =>
      browser.waitUntil(async () => !(await catalogPaths()).includes(path)),
    );
    return true;
  }

  it('keeps merged Ship cleanup pending until selected removal completes', async () => {
    const source = join(worktrees, 'ship-pending');
    git('worktree', 'add', '-q', '-b', 'ship-pending', source);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === source)?.generation;
    if (!generation) throw new Error('Missing Ship worktree generation');
    const run: ShipRun = {
      id: 'ship-pending-cleanup',
      source: 'plan',
      repository,
      remote: 'fixture/repo',
      provider: 'codex',
      limit: 1,
      approvedAt: 1,
      externalClosed: {},
      issues: [
        {
          id: 'ship-source',
          number: 630,
          url: 'https://github.com/fixture/repo/issues/630',
          title: 'Ship source',
          dependsOn: [],
          state: 'merged',
          branch: 'ship-pending',
          path: source,
          receiptId: null,
          threadId: null,
          pullRequest: null,
          workerSettled: true,
          error: 'Cleanup pending: confirm the merged worktree is unused before removing it.',
        },
      ],
    };
    await browser.tauri.execute(
      async ({ core }, input) => {
        await core.invoke('save_setting', { key: 'sai-directory', value: input.repo });
        await core.invoke('save_setting', {
          key: 'sai-project-catalog',
          value: JSON.stringify({
            repositories: [input.repo],
            groups: [],
            worktrees: {
              [input.repo]: [
                {
                  path: input.source,
                  branch: 'ship-pending',
                  generation: input.generation,
                  pendingCleanup: {
                    originalPath: input.source,
                    recoveryPath: input.source,
                    sizeBytes: 0,
                    reason: 'The merged Ship worktree remains registered.',
                  },
                },
              ],
            },
          }),
        });
        await core.invoke('save_setting', {
          key: 'sai-ship-runs',
          value: JSON.stringify([input.run]),
        });
      },
      { repo: repository, source, generation, run },
    );
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem('sail-settings-migrated-v1', '1');
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    });
    await browser.refresh();
    await diagnose('Merged Ship pending row', () =>
      browser.waitUntil(async () => $(`[data-pending-worktree="${source}"]`).isDisplayed()),
    );
    const archived = await browser.tauri.execute(
      async ({ core }, input) =>
        core
          .invoke('delete_worktree', {
            request: {
              repository: input.repo,
              worktree: input.source,
              force: false,
              archiveIgnored: true,
            },
          })
          .then(
            () => 'removed',
            (reason) => String(reason),
          ),
      { repo: repository, source },
    );
    expect(archived).toContain('Automatic ignored-file archival is unavailable');
    expect(existsSync(source)).toBe(true);
    const cleanAfterStartingSession = async (retriesLeft: number): Promise<boolean> => {
      const removed = await cleanPending(source);
      if (removed || retriesLeft === 0) return removed;
      if (!(await pendingCleanup(source))?.reason.includes('An agent session is starting'))
        return false;
      return cleanAfterStartingSession(retriesLeft - 1);
    };
    const removed = await cleanAfterStartingSession(2);
    console.log(`Merged Ship selected cleanup: ${removed ? 'removed' : 'retained pending'}`);
    expect(existsSync(source)).toBe(!removed);
    expect(existsSync(first)).toBe(true);
    await diagnose('Merged Ship cleanup record', () =>
      browser.waitUntil(async () => {
        const settings = await browser.tauri.execute(async ({ core }) =>
          core.invoke<Record<string, string>>('load_settings'),
        );
        const [saved] = loadShipRuns(settings['sai-ship-runs'] ?? null);
        const issue = saved?.issues[0];
        return removed
          ? issue?.path === null && issue?.error === null
          : issue?.path === source && issue?.error !== null;
      }),
    );
    if (!removed) {
      await expect($(`[data-pending-worktree="${source}"]`)).toHaveText(
        expect.stringContaining('unverifiable owner'),
      );
      expect(git('worktree', 'list')).toContain(source);
    }
  });
  it('rechecks a completed selected-storage cleanup after restart', async () => {
    const confirmed = join(worktrees, 'completed-storage');
    const external = join(worktrees, 'external-removal');
    git('worktree', 'add', '-q', '-b', 'completed-storage', confirmed);
    git('worktree', 'add', '-q', '-b', 'external-removal', external);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = (path: string) => registered.find((item) => item.path === path)?.generation;
    if (!generation(confirmed) || !generation(external))
      throw new Error('Missing worktree generation for interrupted cleanup fixture');
    git('worktree', 'remove', confirmed);
    git('worktree', 'remove', external);
    const pending = (path: string, authorized: boolean) => ({
      path,
      branch: path === confirmed ? 'completed-storage' : 'external-removal',
      generation: generation(path),
      pendingCleanup: {
        originalPath: path,
        recoveryPath: path,
        sizeBytes: 0,
        reason: 'Cleanup interrupted before catalog settlement.',
        storagePaths: [join(worktrees, `${path === confirmed ? 'confirmed' : 'external'}-storage`)],
        ...(authorized ? { selectedStorageCleanupConfirmed: true } : {}),
      },
    });
    await browser.tauri.execute(
      async ({ core }, input) => {
        await core.invoke('save_setting', { key: 'sai-directory', value: input.repo });
        await core.invoke('save_setting', {
          key: 'sai-project-catalog',
          value: JSON.stringify({
            repositories: [input.repo],
            groups: [],
            worktrees: { [input.repo]: input.entries },
          }),
        });
      },
      { repo: repository, entries: [pending(confirmed, true), pending(external, false)] },
    );
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem('sail-settings-migrated-v1', '1');
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    });
    await browser.refresh();
    await browser.waitUntil(async () => $(`[data-pending-worktree="${confirmed}"]`).isDisplayed());
    expect((await pendingCleanup(confirmed))?.selectedStorageCleanupConfirmed).toBe(true);
    await $(`[data-pending-worktree="${confirmed}"]`).$('button=Recheck storage').click();
    await browser.waitUntil(async () => !(await catalogPaths()).includes(confirmed));
    expect(await catalogPaths()).toContain(external);
    await $(`[data-pending-worktree="${external}"]`).$('button=Recheck storage').click();
    await browser.waitUntil(async () =>
      ((await pendingCleanup(external))?.reason ?? '').includes('removed outside Sail'),
    );
    expect(await catalogPaths()).toContain(external);
    const settings = await browser.tauri.execute(async ({ core }) =>
      core.invoke<Record<string, string>>('load_settings'),
    );
    const persisted = loadProjectCatalog(settings['sai-project-catalog'] ?? null, repository);
    expect(persisted.worktrees[repository]?.map((item) => item.path)).toEqual([external]);
  });

  it('keeps a selected parent when an unavailable alias owns its live child', async () => {
    const parent = join(worktrees, 'alias-parent');
    const child = join(worktrees, 'alias-child');
    const unavailableAlias = join(worktrees, 'unavailable-repository-alias');
    git('worktree', 'add', '-q', '-b', 'alias-parent', parent);
    git('worktree', 'add', '-q', '-b', 'alias-child', child);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const parentGeneration = registered.find((item) => item.path === parent)?.generation;
    const childGeneration = registered.find((item) => item.path === child)?.generation;
    if (!parentGeneration || !childGeneration) throw new Error('Missing alias fixture generation');
    await browser.tauri.execute(
      async ({ core }, input) => {
        await core.invoke('save_setting', { key: 'sai-directory', value: input.repo });
        await core.invoke('save_setting', {
          key: 'sai-project-catalog',
          value: JSON.stringify({
            repositories: [input.repo, input.alias],
            groups: [],
            worktrees: {
              [input.repo]: [
                {
                  path: input.parent,
                  branch: 'alias-parent',
                  generation: input.parentGeneration,
                  pendingCleanup: {
                    originalPath: input.parent,
                    recoveryPath: input.parent,
                    sizeBytes: 0,
                    reason: 'Merged Ship cleanup is pending.',
                    registeredWorktreesAtMark: input.registered,
                  },
                },
                { path: input.child, branch: 'alias-child', generation: input.childGeneration },
              ],
              [input.alias]: [
                {
                  path: input.child,
                  branch: 'alias-child',
                  generation: input.childGeneration,
                  origin: {
                    sourcePath: input.parent,
                    sourceGeneration: input.parentGeneration,
                    agent: 'test',
                    sessionId: 'alias-child-session',
                    sessionTitle: 'Alias child',
                  },
                },
              ],
            },
          }),
        });
      },
      {
        repo: repository,
        alias: unavailableAlias,
        parent,
        child,
        parentGeneration,
        childGeneration,
        registered,
      },
    );
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem('sail-settings-migrated-v1', '1');
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    });
    await browser.refresh();
    const row = $(`[data-pending-worktree="${parent}"]`);
    await browser.waitUntil(() => row.isDisplayed());
    await row.$('button=Clean up this worktree…').click();
    await browser.waitUntil(async () => {
      const alert = $('.app-shell [role="alert"]');
      return (
        (await alert.isExisting()) &&
        (await alert.getText()).includes('A live descendant is saved under another repository path')
      );
    });
    await expect($('dialog.confirmation-dialog[open]')).not.toExist();
    await expect(row).toHaveText(
      expect.stringContaining('A live descendant is saved under another repository path'),
    );
    expect(git('worktree', 'list')).toContain(parent);
    expect(git('worktree', 'list')).toContain(child);
  });
});

import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { topbarMenuTrigger } from './topbar';
import { openSettings, returnToWorkspace } from './settings-window';
import { loadProjectCatalog } from '../../src/lib/projects.ts';

async function captureDescendantPreviewTheme(theme: 'light' | 'dark') {
  await browser.tauri.execute(
    async ({ core }, chosenTheme) =>
      core.invoke('plugin:window|set_theme', { label: 'main', value: chosenTheme }),
    theme,
  );
  await [
    [2560, 1440],
    [1920, 1200],
    [390, 850],
  ].reduce<Promise<void>>(async (previous, [width, height]) => {
    await previous;
    await browser.setWindowSize(width, height);
    const actual = await browser.execute(() => innerWidth);
    console.log(`Descendant removal preview: ${theme}, requested ${width}, actual ${actual}`);
    expect(
      await browser.execute(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    if (process.env.SAIL_VISUAL_AUDIT_DIR) {
      mkdirSync(process.env.SAIL_VISUAL_AUDIT_DIR, { recursive: true });
      await browser.saveScreenshot(
        join(process.env.SAIL_VISUAL_AUDIT_DIR, `descendant-removal-${theme}-${actual}.png`),
      );
    }
  }, Promise.resolve());
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
        const message = (await alert.isExisting()) ? await alert.getText() : '<no error alert>';
        if (message.includes('A worktree operation is in progress')) return false;
        const row = $(`[data-pending-worktree="${path}"]`);
        const rowText = (await row.isExisting()) ? await row.getText() : '<pending row absent>';
        throw new Error(
          `Pending confirmation did not open for ${path}: alert=${message}; row=${rowText}`,
        );
      }
    },
    { timeout: 20000, interval: 100 },
  );
}

async function openRemovalConfirmation(path: string, branch: string) {
  const dialog = $('dialog.confirmation-dialog[open]');
  await browser.waitUntil(
    async () => {
      if (await dialog.isExisting()) return true;
      await $(`.project-worktree-select[title="${path}"]`).click({ button: 'right' });
      await $(`[aria-label="Delete worktree ${branch}"]`).click();
      try {
        await browser.waitUntil(() => dialog.isExisting(), { timeout: 1500, interval: 100 });
        return true;
      } catch {
        const alert = $('.app-shell [role="alert"]');
        const message = (await alert.isExisting()) ? await alert.getText() : '<no error alert>';
        if (
          message.includes('A worktree operation is in progress') ||
          message.includes('Another worktree deletion is in progress') ||
          message.includes('A worktree is being created')
        )
          return false;
        throw new Error(`Removal confirmation did not open for ${path}: ${message}`);
      }
    },
    { timeout: 20000, interval: 100 },
  );
}

describe('close worktree shortcut', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'sail-close-worktree-')));
  const worktrees = realpathSync(mkdtempSync(join(tmpdir(), 'sail-close-worktree-trees-')));
  const first = join(worktrees, 'first');
  const second = join(worktrees, 'second');
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
    git('worktree', 'add', '-q', '-b', 'second', second);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(worktrees, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function select(directory: string, waitForInventory = true) {
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = (path: string) => registered.find((item) => item.path === path)?.generation;
    await browser.execute(
      (repo, selected, firstPath, secondPath, firstGeneration, secondGeneration) => {
        sessionStorage.removeItem('sai-e2e-delete-worktree');
        localStorage.setItem('sai-directory', selected);
        localStorage.setItem(`sai-main-pane-empty:${selected}`, 'true');
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                ...(firstGeneration
                  ? [{ path: firstPath, branch: 'first', generation: firstGeneration }]
                  : []),
                ...(secondGeneration
                  ? [{ path: secondPath, branch: 'second', generation: secondGeneration }]
                  : []),
              ],
            },
          }),
        );
      },
      repository,
      directory,
      first,
      second,
      generation(first),
      generation(second),
    );
    await browser.refresh();
    await diagnose('Workspace load', () => expect(topbarMenuTrigger('New agent')).toBeDisplayed());
    await diagnose('Empty main pane', () =>
      expect($('[data-pane-id="main"] [data-pane-picker]')).toBeDisplayed(),
    );
    if (waitForInventory)
      await diagnose('Sidebar inventory', () =>
        browser.waitUntil(
          () =>
            browser.execute(() => {
              const ready = Reflect.get(window, '__SAIL_E2E_SIDEBAR_INVENTORY_READY__');
              return typeof ready === 'function' && ready();
            }),
          { timeout: 20000, timeoutMsg: 'Sidebar OpenCode inventory did not settle' },
        ),
      );
  }

  const catalogPaths = async () => {
    const saved = await browser.execute(() => localStorage.getItem('sai-project-catalog'));
    const catalog = loadProjectCatalog(saved, repository);
    return (catalog.worktrees[repository] ?? []).map((worktree) => worktree.path);
  };

  const pendingCleanup = async (path: string) => {
    const saved = await browser.execute(() => localStorage.getItem('sai-project-catalog'));
    return loadProjectCatalog(saved, repository).worktrees[repository]?.find(
      (worktree) => worktree.path === path,
    )?.pendingCleanup;
  };

  async function carryTaskRegisteredWorktrees() {
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const rows = registered
      .filter((item) => item.path !== repository)
      .map((item) => {
        const withinFixture = relative(worktrees, item.path);
        if (
          !withinFixture ||
          withinFixture === '..' ||
          withinFixture.startsWith(`..${sep}`) ||
          isAbsolute(withinFixture) ||
          !existsSync(item.path) ||
          !item.generation
        )
          throw new Error(`Unexpected or unverifiable worktree registration: ${item.path}`);
        return { path: item.path, branch: basename(item.path), generation: item.generation };
      });
    await browser.execute(
      (repo, taskRows) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        const entries = catalog.worktrees?.[repo];
        if (!Array.isArray(entries)) throw new Error('Missing task worktree catalog');
        const present = new Set(entries.map((item: { path: string }) => item.path));
        for (const row of taskRows) if (!present.has(row.path)) entries.push(row);
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      rows,
    );
  }

  async function retryPendingStorage(path: string) {
    await openPendingConfirmation(path, 'Retry selected storage cleanup…');
    await diagnose(`Selected storage dialog ${path}`, async () => {
      const dialog = $('dialog.confirmation-dialog[open]');
      await expect(dialog).toExist();
      await expect(dialog).toHaveText(
        expect.stringContaining(
          'no other process will write to, move, or replace it until cleanup finishes',
        ),
      );
      await dialog.$('button=Clean up selected storage').click();
    });
  }

  async function cleanPending(
    path: string,
    expectedSize?: number,
    expectSuccess = false,
    expectedArchiveWarning = false,
  ): Promise<boolean> {
    await openPendingConfirmation(path, 'Clean up this worktree…');
    await diagnose(`Pending cleanup dialog ${path}`, async () => {
      const dialog = $('dialog.confirmation-dialog[open]');
      await expect(dialog).toExist();
      await expect(dialog).toHaveText(
        expect.stringContaining(
          'no other process will write to, move, or replace either until cleanup finishes',
        ),
      );
      if (expectedArchiveWarning)
        await expect(dialog).toHaveText(
          expect.stringContaining(
            'The configured archive command will not run during selected cleanup',
          ),
        );
      if (expectedSize !== undefined)
        await expect(dialog).toHaveText(
          expect.stringContaining(`Retained size: ${expectedSize} bytes`),
        );
      await dialog.$('button=Remove this worktree').click();
    });
    if (expectSuccess) {
      await diagnose(`Pending cleanup success ${path}`, () =>
        browser.waitUntil(async () => !(await catalogPaths()).includes(path), {
          timeout: 20000,
          timeoutMsg: `Selected worktree remained pending after temporary cleanup: ${path}`,
        }),
      );
      return true;
    }
    await diagnose(`Pending checkout result ${path}`, () =>
      browser.waitUntil(
        async () =>
          !(await catalogPaths()).includes(path) ||
          !!(await pendingCleanup(path))?.storagePaths?.length ||
          (await pendingCleanup(path))?.reason.includes('Cleanup stopped') === true,
      ),
    );
    if ((await pendingCleanup(path))?.reason.includes('Cleanup stopped')) {
      const reason = (await pendingCleanup(path))!.reason;
      await expect($('.app-shell [role="alert"]')).toHaveText(
        expect.stringContaining(
          reason.includes('agent inventory request')
            ? 'an agent inventory request is still running'
            : 'Private agent data is retained while temporary data is still in use or cannot be verified',
        ),
      );
      await expect($(`[data-pending-worktree="${path}"]`)).toHaveText(
        expect.stringContaining('Retained size:'),
      );
      expect(existsSync(path)).toBe(true);
      expect(git('worktree', 'list')).toContain(path);
      return false;
    }
    if ((await pendingCleanup(path))?.storagePaths?.length) {
      await retryPendingStorage(path);
    }
    await diagnose(`Pending cleanup result ${path}`, () =>
      browser.waitUntil(async () => !(await catalogPaths()).includes(path)),
    );
    return true;
  }

  async function inspectSelectedTemp(path: string): Promise<void> {
    await openSettings();
    try {
      await $('.settings-window').$('button=Agents').click();
      const selector = `li[data-pending-temp-owner="${path}"]`;
      await diagnose(`Settings selected private temp ${path}`, () =>
        browser.waitUntil(async () => (await $$(selector)).length > 0, {
          timeoutMsg: `Settings did not show the selected private temp owner ${path}`,
        }),
      );
      const rows = await $$(selector);
      await Promise.all(
        Array.from({ length: rows.length }, async (_, index) => {
          const row = rows[index];
          const tempPath = await row.getAttribute('data-pending-temp-path');
          if (!tempPath) throw new Error('Settings omitted the selected temporary path');
          await expect(row).toHaveText(expect.stringContaining(`Owner worktree: ${path}`));
          await expect(row).toHaveText(expect.stringContaining(`Temporary data: ${tempPath}`));
          await expect(row).toHaveText(expect.stringContaining('Pending reason:'));
          await expect(row).toHaveText(expect.stringContaining('Retained size:'));
          const reason = await row.getText();
          if (/turn-temp-process-active|turn-temp-owner-unverified-active/.test(reason)) {
            await expect(row.$('button=Clean after checking unused')).not.toExist();
          }
        }),
      );
    } finally {
      await returnToWorkspace();
    }
  }

  async function cleanUnusedSelectedTemp(path: string): Promise<void> {
    const withinFixture = relative(worktrees, path);
    if (
      !withinFixture ||
      withinFixture === '..' ||
      withinFixture.startsWith(`..${sep}`) ||
      isAbsolute(withinFixture)
    )
      throw new Error('Refusing to clean temporary data outside the task-owned worktree fixture');
    await openSettings();
    try {
      await $('.settings-window').$('button=Agents').click();
      const selector = `li[data-pending-temp-owner="${path}"]`;
      await browser.waitUntil(async () => (await $$(selector)).length > 0);
      async function clearOne(attempt: number): Promise<void> {
        if (attempt >= 8)
          throw new Error(
            'Selected temporary data required more than eight explicit confirmations',
          );
        const rows = await $$(selector);
        if (rows.length === 0) return;
        const pending = await Promise.all(
          Array.from({ length: rows.length }, async (_, index) => ({
            row: rows[index],
            reason: await rows[index].getText(),
            tempPath: await rows[index].getAttribute('data-pending-temp-path'),
          })),
        );
        if (
          pending.some(({ reason }) =>
            /turn-temp-process-active|turn-temp-owner-unverified-active/.test(reason),
          )
        )
          throw new Error(
            `Selected temporary data still has an active owner: ${pending.map(({ reason }) => reason).join('; ')}`,
          );
        const canClean = await Promise.all(
          pending.map((item) => item.row.$('button=Clean after checking unused').isExisting()),
        );
        const item = pending[canClean.findIndex(Boolean)];
        if (!item?.tempPath)
          throw new Error('Selected unused temporary data has no verified cleanup action');
        await expect(item.row).toHaveText(expect.stringContaining(`Owner worktree: ${path}`));
        await expect(item.row).toHaveText(
          expect.stringContaining(`Temporary data: ${item.tempPath}`),
        );
        await expect(item.row).toHaveText(expect.stringContaining('Pending reason:'));
        await expect(item.row).toHaveText(expect.stringContaining('Retained size:'));
        await item.row.$('button=Clean after checking unused').click();
        const confirmation = $('dialog.confirmation-dialog[open]');
        await expect(confirmation).toHaveText(expect.stringContaining(`Owner worktree: ${path}`));
        await expect(confirmation).toHaveText(
          expect.stringContaining(`Temporary data: ${item.tempPath}`),
        );
        await expect(confirmation).toHaveText(
          expect.stringContaining('no other process will write to, move, or replace it'),
        );
        await confirmation.$('button=Remove selected temporary data').click();
        await browser.waitUntil(async () => !(await confirmation.isDisplayed()), {
          timeoutMsg: 'The selected temporary cleanup confirmation stayed open',
        });
        try {
          await browser.waitUntil(async () => {
            const error = $('.settings-window .runtime-diagnostic[role="alert"]');
            const remainingRows = await $$(selector);
            const remaining = await Promise.all(
              Array.from({ length: remainingRows.length }, (_, index) =>
                remainingRows[index].getAttribute('data-pending-temp-path'),
              ),
            );
            return !remaining.includes(item.tempPath) || (await error.isExisting());
          });
        } catch (cause) {
          const state = await browser.execute(
            (owner) => ({
              rows: [...document.querySelectorAll('li[data-pending-temp-owner]')]
                .filter((row) => row.getAttribute('data-pending-temp-owner') === owner)
                .map((row) => ({
                  path: row.getAttribute('data-pending-temp-path'),
                  text: row.textContent,
                  disabled: row.querySelector('button')?.hasAttribute('disabled'),
                })),
              alerts: [...document.querySelectorAll('.settings-window [role="alert"]')].map(
                (alert) => alert.textContent,
              ),
              dialogs: [...document.querySelectorAll('dialog[open]')].map(
                (dialog) => dialog.textContent,
              ),
            }),
            path,
          );
          throw new Error(
            `Selected temporary cleanup did not settle for ${item.tempPath}: ${JSON.stringify(state)}`,
            { cause },
          );
        }
        const error = $('.settings-window .runtime-diagnostic[role="alert"]');
        if (await error.isExisting()) throw new Error(await error.getText());
        await browser.waitUntil(
          async () => $('.settings-window').$('button=Retry cleanup').isEnabled(),
          { timeoutMsg: 'Settings remained busy after selected temporary cleanup' },
        );
        await clearOne(attempt + 1);
      }
      await clearOne(0);
    } finally {
      await returnToWorkspace();
    }
  }

  async function diagnose<T>(label: string, step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (cause) {
      console.error(`${label} diagnostic`, {
        state: await browser.execute(() => ({
          directory: localStorage.getItem('sai-directory'),
          catalog: localStorage.getItem('sai-project-catalog'),
          answer: sessionStorage.getItem('sai-e2e-delete-worktree'),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(
            (alert) => alert.textContent,
          ),
          dialogs: [...document.querySelectorAll('dialog[open]')].map(
            (dialog) => dialog.textContent,
          ),
          privateStorage: [
            ...document.querySelectorAll('.settings-window li[data-pending-temp-path]'),
          ].map((item) => ({
            owner: item.getAttribute('data-pending-temp-owner'),
            path: item.getAttribute('data-pending-temp-path'),
            text: item.textContent,
          })),
          settingsAlerts: [...document.querySelectorAll('.settings-window [role="alert"]')].map(
            (item) => item.textContent,
          ),
          focused: document.activeElement?.outerHTML.slice(0, 200),
          hasFocus: document.hasFocus(),
        })),
        firstExists: existsSync(first),
        worktrees: git('worktree', 'list'),
      });
      throw cause;
    }
  }

  it('refuses to delete the main checkout', async () => {
    await select(repository);
    await browser.keys(['Meta', 'Shift', 'w']);
    await diagnose('Main checkout', () =>
      expect($('.app-shell [role="alert"]')).toHaveText(
        expect.stringContaining('The main checkout cannot be deleted.'),
      ),
    );
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(await catalogPaths()).toEqual([first, second]);
  });

  it('keeps the worktree when the confirmation is declined', async () => {
    await select(first);
    await browser.execute(() => sessionStorage.setItem('sai-e2e-delete-worktree', 'No'));
    await browser.keys(['Meta', 'Shift', 'w']);
    await diagnose('Declined delete', () =>
      browser.waitUntil(() =>
        browser.execute(() => sessionStorage.getItem('sai-e2e-delete-worktree') === null),
      ),
    );
    expect(existsSync(first)).toBe(true);
    expect(await catalogPaths()).toEqual([first, second]);
  });

  it('marks only the selected worktree pending and retains its checkout when private temp is unverifiable', async () => {
    await select(second);
    await browser.execute(() => {
      sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes');
      for (let press = 0; press < 2; press++)
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'w', metaKey: true, shiftKey: true }),
        );
    });
    await diagnose('Repeated delete', () =>
      browser.waitUntil(async () => !!(await pendingCleanup(second))),
    );
    expect(existsSync(second)).toBe(true);
    expect(await catalogPaths()).toEqual([first, second]);
    expect((await pendingCleanup(second))?.originalPath).toBe(second);
    expect((await pendingCleanup(second))?.recoveryPath).toBe(second);
    await expect($(`[data-pending-worktree="${second}"]`)).toHaveText(
      expect.stringContaining('Retained size:'),
    );
    await browser.execute(
      (repo, path) => {
        const saved = localStorage.getItem('sai-project-catalog');
        if (!saved) throw new Error('Missing catalog for stale-size fixture');
        const catalog = JSON.parse(saved);
        const row = catalog.worktrees[repo].find((item: { path: string }) => item.path === path);
        if (!row?.pendingCleanup) throw new Error('Missing pending cleanup for stale-size fixture');
        row.pendingCleanup.sizeBytes = 0;
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      second,
    );
    await browser.refresh();
    await expect($(`[data-pending-worktree="${second}"]`)).toBeDisplayed();
    const [current] = await browser.tauri.execute(
      async ({ core }, [repo, selected]) =>
        core.invoke<{ sizeBytes: number | null }[]>('worktree_removal_preview', {
          repository: repo,
          paths: [selected],
        }),
      [repository, second],
    );
    if (current.sizeBytes === null || current.sizeBytes === 0)
      throw new Error('The stale-size fixture did not differ from the current checkout');
    await $(`[data-pending-worktree="${second}"]`).$('button=Clean up this worktree…').click();
    const declined = $('dialog.confirmation-dialog[open]');
    await expect(declined).toHaveText(
      expect.stringContaining(
        'no other process will write to, move, or replace either until cleanup finishes',
      ),
    );
    await declined.$('button=Cancel').click();
    expect(existsSync(second)).toBe(true);
    expect((await pendingCleanup(second))?.recoveryPath).toBe(second);
    expect(await cleanPending(second, current.sizeBytes)).toBe(false);
    expect((await pendingCleanup(second))?.reason).toMatch(
      /temporary data is still in use or cannot be verified|agent inventory request is still running/,
    );
    expect(await catalogPaths()).toEqual([first, second]);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    await expect($('dialog[open]')).not.toExist();
    await $(`.project-default-worktree-select[title="${repository}"]`).click();
    await browser.waitUntil(() =>
      browser.execute((repo) => localStorage.getItem('sai-directory') === repo, repository),
    );
    await inspectSelectedTemp(second);
    expect(existsSync(second)).toBe(true);
    expect((await pendingCleanup(second))?.originalPath).toBe(second);
    expect(await catalogPaths()).toEqual([first, second]);

    const eligible = join(worktrees, 'eligible-selected');
    git('worktree', 'add', '-q', '-b', 'eligible-selected', eligible);
    const archiveMarker = join(worktrees, 'eligible-archive-command-ran');
    mkdirSync(join(eligible, '.sail'));
    writeFileSync(
      join(eligible, '.sail', 'worktree.json'),
      JSON.stringify({ archive: 'touch ../eligible-archive-command-ran' }),
    );
    execFileSync('git', ['-C', eligible, 'add', '--', '.sail/worktree.json']);
    execFileSync('git', ['-C', eligible, 'commit', '-S', '-q', '-m', 'add archive fixture']);
    await carryTaskRegisteredWorktrees();
    await browser.refresh();
    await expect($(`.project-worktree-select[title="${eligible}"]`)).toBeDisplayed();
    await openRemovalConfirmation(eligible, 'eligible-selected');
    await $('dialog.confirmation-dialog[open]').$('button=Mark 1 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(eligible)));
    const unrelatedAfterMark = join(worktrees, 'unrelated-after-mark');
    git('worktree', 'add', '-q', '-b', 'unrelated-after-mark', unrelatedAfterMark);
    await carryTaskRegisteredWorktrees();
    await browser.refresh();
    await expect($(`.project-worktree-select[title="${unrelatedAfterMark}"]`)).toBeDisplayed();
    expect(
      (await pendingCleanup(eligible))?.registeredWorktreesAtMark?.some(
        (worktree) => worktree.path === unrelatedAfterMark,
      ),
    ).toBe(false);
    expect(await cleanPending(eligible, undefined, false, true)).toBe(false);
    expect(existsSync(eligible)).toBe(true);
    await cleanUnusedSelectedTemp(eligible);
    expect(await cleanPending(eligible, undefined, true, true)).toBe(true);
    expect(existsSync(archiveMarker)).toBe(false);
    expect(existsSync(eligible)).toBe(false);
    expect(git('worktree', 'list')).not.toContain(eligible);
    expect(existsSync(unrelatedAfterMark)).toBe(true);
    expect(git('worktree', 'list')).toContain(unrelatedAfterMark);
    expect(await catalogPaths()).toEqual([first, second, unrelatedAfterMark]);
    git('worktree', 'remove', unrelatedAfterMark);
    await browser.execute(
      (repo, path) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo] = catalog.worktrees[repo].filter(
          (worktree: { path: string }) => worktree.path !== path,
        );
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      unrelatedAfterMark,
    );
    await browser.refresh();
    expect(await catalogPaths()).toEqual([first, second]);
  });

  it('keeps an externally removed checkout pending across restart and path replacement', async () => {
    const completed = join(worktrees, 'completed-after-crash');
    const leftover = join(completed, 'leftover.txt');
    git('worktree', 'add', '-q', '-b', 'completed-after-crash', completed);
    await select(first, false);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((worktree) => worktree.path === completed)?.generation;
    if (!generation) throw new Error('Missing generation for completed cleanup fixture');
    await browser.execute(
      (repo, root, child, childGeneration) => {
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                { path: root, branch: 'first' },
                {
                  path: child,
                  branch: 'completed-after-crash',
                  generation: childGeneration,
                  pendingCleanup: {
                    originalPath: child,
                    recoveryPath: child,
                    sizeBytes: 8,
                    reason: 'Cleanup was interrupted.',
                  },
                },
              ],
            },
          }),
        );
      },
      repository,
      first,
      completed,
      generation,
    );
    git('worktree', 'remove', completed);
    mkdirSync(completed);
    writeFileSync(leftover, 'keep');
    await browser.refresh();
    await expect($(`[data-pending-worktree="${completed}"]`)).toBeDisplayed();
    await $(`[data-pending-worktree="${completed}"]`).$('button=Recheck worktree').click();
    await diagnose('Completed cleanup retained path', () =>
      browser.waitUntil(async () =>
        (await pendingCleanup(completed))?.reason.includes(
          'a saved checkout or storage path still exists',
        ),
      ),
    );
    expect(existsSync(leftover)).toBe(true);

    rmSync(completed, { recursive: true });
    git('worktree', 'add', '-q', '-b', 'completed-replacement', completed);
    await $(`[data-pending-worktree="${completed}"]`).$('button=Recheck worktree').click();
    await diagnose('Replaced checkout remains pending', () =>
      browser.waitUntil(async () => {
        const reason = (await pendingCleanup(completed))?.reason;
        return (
          reason?.includes('removed outside Sail') ||
          reason?.includes('private Git state remains pending')
        );
      }),
    );
    const overlayAbsent = await browser.tauri.execute(
      async ({ core }, path) =>
        core.invoke<boolean>('pending_cleanup_overlay_absent', { originalWorktree: path }),
      completed,
    );
    expect(overlayAbsent).toBe(
      (await pendingCleanup(completed))?.reason.includes('removed outside Sail'),
    );
    expect(await catalogPaths()).toContain(completed);
    expect(existsSync(completed)).toBe(true);
    expect(git('worktree', 'list')).toContain(completed);
    await browser.refresh();
    const replacement = $(`button[aria-label="Open external worktree completed-replacement"]`);
    await expect(replacement).toBeDisplayed();
    await replacement.click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('older generation still has pending cleanup'),
    );
    expect((await pendingCleanup(completed))?.reason).toBeTruthy();
    expect(await catalogPaths()).toContain(completed);
    expect(existsSync(completed)).toBe(true);
    git('worktree', 'remove', completed);
  });

  it('does not claim an external worktree that replaced a saved Sail generation', async () => {
    const reused = join(worktrees, 'reused-catalog-path');
    git('worktree', 'add', '-q', '-b', 'saved-generation', reused);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const oldGeneration = registered.find((item) => item.path === reused)?.generation;
    if (!oldGeneration) throw new Error('Missing saved generation for replacement fixture');
    git('worktree', 'remove', reused);
    git('worktree', 'add', '-q', '-b', 'catalog-external-replacement', reused);
    await select(reused, false);
    await browser.execute(
      (repo, path, generation) => {
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [{ path, branch: 'saved-generation', generation }],
            },
          }),
        );
      },
      repository,
      reused,
      oldGeneration,
    );
    await browser.refresh();
    await expect(topbarMenuTrigger('New agent')).toBeDisplayed();
    await browser.keys(['Meta', 'Shift', 'w']);
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringMatching(
        /Worktree identities changed during the preview|Private Git state .* requires recovery; task Git command refused/,
      ),
    );
    expect(await pendingCleanup(reused)).toBeUndefined();
    expect(existsSync(reused)).toBe(true);
    expect(git('worktree', 'list')).toContain(reused);
    git('worktree', 'remove', reused);
  });

  it('preserves a detached descendant changed after preview', async () => {
    const detached = join(worktrees, 'detached');
    const newFile = join(detached, 'new.txt');
    git('worktree', 'add', '-q', '-b', 'detached-child', detached);
    execFileSync('git', ['-C', detached, 'checkout', '--detach', '-q']);
    await select(first, false);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = (path: string) => {
      const value = registered.find((worktree) => worktree.path === path)?.generation;
      if (!value) throw new Error(`Missing worktree generation for ${path}`);
      return value;
    };
    await browser.execute(
      (repo, root, child, rootGeneration, childGeneration) => {
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                { path: root, branch: 'first', generation: rootGeneration },
                {
                  path: child,
                  branch: 'detached-child',
                  generation: childGeneration,
                  origin: {
                    sourcePath: root,
                    sourceGeneration: rootGeneration,
                    agent: 'codex',
                    sessionId: 'detached-session',
                    sessionTitle: 'Detached',
                  },
                },
              ],
            },
          }),
        );
      },
      repository,
      first,
      detached,
      generation(first),
      generation(detached),
    );
    await browser.refresh();
    await diagnose('Changed detached catalog', () =>
      browser.waitUntil(
        () =>
          browser.execute(() => {
            const ready = Reflect.get(window, '__SAIL_E2E_SIDEBAR_INVENTORY_READY__');
            return typeof ready === 'function' && ready();
          }),
        { timeout: 20000, timeoutMsg: 'Detached catalog did not settle after reload' },
      ),
    );
    await $(`.project-worktree-select[title="${first}"]`).click({ button: 'right' });
    await $('[aria-label="Delete worktree first"]').click();
    const dialog = $('dialog.confirmation-dialog[open]');
    await expect(dialog).toHaveText(expect.stringContaining('detached'));
    writeFileSync(newFile, 'keep this file');
    await dialog.$('button=Mark 2 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(detached)));
    await $(`[data-pending-worktree="${detached}"]`).$('button=Recheck worktree').click();
    await browser.waitUntil(async () =>
      (await pendingCleanup(detached))?.reason.includes('Files changed'),
    );
    await $(`[data-pending-worktree="${detached}"]`).$('button=Clean up this worktree…').click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('Pending worktrees with files'),
    );
    expect(existsSync(newFile)).toBe(true);
    expect(existsSync(first)).toBe(true);
    expect(await catalogPaths()).toEqual([first, detached]);
    git('worktree', 'remove', '--force', detached);
  });

  it('retains a detached descendant and its commit when private temp is unverifiable', async () => {
    const detached = join(worktrees, 'clean-detached');
    git('worktree', 'add', '-q', '-b', 'clean-detached', detached);
    execFileSync('git', ['-C', detached, 'checkout', '--detach', '-q']);
    execFileSync('git', [
      '-C',
      detached,
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
      'detached work',
    ]);
    const head = execFileSync('git', ['-C', detached, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    await select(first, false);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = (path: string) => {
      const value = registered.find((worktree) => worktree.path === path)?.generation;
      if (!value) throw new Error(`Missing worktree generation for ${path}`);
      return value;
    };
    await browser.execute(
      (repo, root, sibling, child, rootGeneration, siblingGeneration, childGeneration) => {
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                { path: root, branch: 'first', generation: rootGeneration },
                { path: sibling, branch: 'second', generation: siblingGeneration },
                {
                  path: child,
                  branch: 'clean-detached',
                  generation: childGeneration,
                  origin: {
                    sourcePath: root,
                    sourceGeneration: rootGeneration,
                    agent: 'codex',
                    sessionId: 'clean-detached-session',
                    sessionTitle: 'Clean detached',
                  },
                },
              ],
            },
          }),
        );
      },
      repository,
      first,
      second,
      detached,
      generation(first),
      generation(second),
      generation(detached),
    );
    await browser.refresh();
    await diagnose('Clean detached catalog', () =>
      expect($(`.project-worktree-select[title="${detached}"]`)).toBeDisplayed(),
    );
    await diagnose('Clean detached sidebar inventory', () =>
      browser.waitUntil(
        () =>
          browser.execute(() => {
            const ready = Reflect.get(window, '__SAIL_E2E_SIDEBAR_INVENTORY_READY__');
            return typeof ready === 'function' && ready();
          }),
        { timeout: 60000, timeoutMsg: 'Sidebar inventory did not settle before cleanup' },
      ),
    );
    await $(`.project-worktree-select[title="${first}"]`).click({ button: 'right' });
    await $('[aria-label="Delete worktree first"]').click();
    const dialog = $('dialog.confirmation-dialog[open]');
    await expect(dialog).toHaveText(expect.stringContaining('detached'));
    await dialog.$('button=Mark 2 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(detached)));
    expect(existsSync(first)).toBe(true);
    expect(existsSync(detached)).toBe(true);
    expect(await cleanPending(detached)).toBe(false);
    expect(await catalogPaths()).toEqual([first, second, detached]);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(detached)).toBe(true);
    expect(
      execFileSync('git', ['-C', detached, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(head);
    expect((await pendingCleanup(detached))?.reason).toContain(
      'temporary data is still in use or cannot be verified',
    );
  });

  it('keeps a pending parent when another instance registers an unseen child', async () => {
    const parent = join(worktrees, 'inventory-parent');
    const child = join(worktrees, 'inventory-new-child');
    const retained = join(worktrees, 'clean-detached');
    git('worktree', 'add', '-q', '-b', 'inventory-parent', parent);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === parent)?.generation;
    const retainedGeneration = registered.find((item) => item.path === retained)?.generation;
    if (!generation) throw new Error('Missing pending parent generation');
    if (!retainedGeneration) throw new Error('Missing retained descendant generation');
    await select(first, false);
    await browser.execute(
      (repo, path, identity, retainedPath, retainedIdentity) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push({
          path: retainedPath,
          branch: 'clean-detached',
          generation: retainedIdentity,
        });
        catalog.worktrees[repo].push({ path, branch: 'inventory-parent', generation: identity });
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      parent,
      generation,
      retained,
      retainedGeneration,
    );
    await browser.refresh();
    await diagnose('Pending parent row', () =>
      expect($(`.project-worktree-select[title="${parent}"]`)).toBeDisplayed(),
    );
    await openRemovalConfirmation(parent, 'inventory-parent');
    await $('dialog.confirmation-dialog[open]').$('button=Mark 1 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(parent)));
    git('worktree', 'add', '-q', '-b', 'inventory-new-child', child);
    await openPendingConfirmation(parent, 'Clean up this worktree…');
    await $('dialog.confirmation-dialog[open]').$('button=Remove this worktree').click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('registered worktree is not in this catalog'),
    );
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(child)).toBe(true);
    expect(await pendingCleanup(parent)).toBeDefined();
    git('worktree', 'remove', child);
    expect(await cleanPending(parent)).toBe(false);
    expect((await pendingCleanup(parent))?.reason).toContain(
      'temporary data is still in use or cannot be verified',
    );
    expect(existsSync(parent)).toBe(true);
  });

  it('previews Sail descendants and retains selected cleanup while private temp is unverifiable', async () => {
    const child = join(worktrees, 'child');
    const grandchild = join(worktrees, 'grandchild');
    const external = join(worktrees, 'external');
    const retained = join(worktrees, 'clean-detached');
    const pendingParent = join(worktrees, 'inventory-parent');
    const uncommitted = join(grandchild, 'uncommitted.txt');
    git('worktree', 'add', '-q', '-b', 'child', child);
    git('worktree', 'add', '-q', '-b', 'grandchild', grandchild);
    git('worktree', 'add', '-q', '-b', 'external', external);
    writeFileSync(uncommitted, 'keep until cleaned');
    await select(first, false);
    const registered = await browser.execute(async (repo) => {
      const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
      if (!internals || typeof internals !== 'object') throw new Error('Tauri bridge unavailable');
      const invoke: unknown = Reflect.get(internals, 'invoke');
      if (typeof invoke !== 'function') throw new Error('Tauri invoke unavailable');
      const result: unknown = await Reflect.apply(invoke, internals, [
        'repository_worktrees',
        { repository: repo },
      ]);
      if (!Array.isArray(result)) throw new Error('Invalid worktree registration');
      return result.map((item: unknown) => {
        if (!item || typeof item !== 'object') throw new Error('Invalid worktree registration');
        const path: unknown = Reflect.get(item, 'path');
        const generation: unknown = Reflect.get(item, 'generation');
        if (typeof path !== 'string' || (generation !== null && typeof generation !== 'string'))
          throw new Error('Invalid worktree identity');
        return { path, generation };
      });
    }, repository);
    const generation = (path: string) => {
      const value = registered.find((worktree) => worktree.path === path)?.generation;
      if (!value) throw new Error(`Missing worktree generation for ${path}`);
      return value;
    };
    await browser.execute(
      (repo, root, sibling, pendingSibling, descendant, leaf, unrelated, identities) => {
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                { path: root, branch: 'first', generation: identities.root },
                { path: sibling, branch: 'second', generation: identities.second },
                { path: pendingSibling, branch: 'clean-detached', generation: identities.retained },
                {
                  path: descendant,
                  branch: 'child',
                  generation: identities.child,
                  origin: {
                    sourcePath: root,
                    sourceGeneration: identities.root,
                    agent: 'codex',
                    sessionId: 'child-session',
                    sessionTitle: 'Child',
                  },
                },
                {
                  path: leaf,
                  branch: 'grandchild',
                  generation: identities.grandchild,
                  origin: {
                    sourcePath: descendant,
                    sourceGeneration: identities.child,
                    agent: 'codex',
                    sessionId: 'grandchild-session',
                    sessionTitle: 'Grandchild',
                  },
                },
                { path: unrelated, branch: 'external', generation: identities.external },
              ],
            },
          }),
        );
      },
      repository,
      first,
      second,
      retained,
      child,
      grandchild,
      external,
      {
        root: generation(first),
        second: generation(second),
        retained: generation(retained),
        child: generation(child),
        grandchild: generation(grandchild),
        external: generation(external),
      },
    );
    await carryTaskRegisteredWorktrees();
    await browser.refresh();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const ready = Reflect.get(window, '__SAIL_E2E_SIDEBAR_INVENTORY_READY__');
          return typeof ready === 'function' && ready();
        }),
      { timeout: 20000, timeoutMsg: 'Descendant catalog did not settle after reload' },
    );
    const openRemoval = async () => {
      let preview: { path: string; revision: string; sizeBytes: number | null }[] = [];
      await browser.waitUntil(
        async () => {
          try {
            preview = await browser.tauri.execute(
              async ({ core }, input) =>
                core.invoke<{ path: string; revision: string; sizeBytes: number | null }[]>(
                  'worktree_removal_preview',
                  {
                    repository: input.repository,
                    paths: input.paths,
                  },
                ),
              { repository, paths: [grandchild, child, first] },
            );
            return true;
          } catch (cause) {
            if (String(cause).includes('requires recovery; task Git command refused')) return false;
            throw cause;
          }
        },
        {
          timeout: 20000,
          timeoutMsg: 'Private Git overlay did not settle before descendant preview',
        },
      );
      await $(`.project-worktree-select[title="${first}"]`).click({ button: 'right' });
      await $('[aria-label="Delete worktree first"]').click();
      return preview;
    };
    const preview = await openRemoval();
    const dialog = $('dialog.confirmation-dialog[open]');
    await diagnose('Descendant dialog', () =>
      expect(dialog).toHaveText(expect.stringContaining('grandchild')),
    );
    await expect(dialog).toHaveText(expect.stringContaining('uncommitted changes'));
    await expect(dialog).not.toHaveText(expect.stringContaining('external'));
    const cleanChild = preview.find((entry) => entry.path === child);
    if (!cleanChild || cleanChild.sizeBytes === null)
      throw new Error('Clean child preview lacks retained size');
    await expect(dialog).toHaveText(expect.stringContaining(`Revision: ${cleanChild.revision}`));
    await expect(dialog).toHaveText(
      expect.stringContaining(`Retained size: ${cleanChild.sizeBytes} bytes`),
    );
    await captureDescendantPreviewTheme('light');
    await captureDescendantPreviewTheme('dark');
    await browser.setWindowSize(1920, 1200);
    await browser.execute(() => {
      document.documentElement.style.zoom = '2';
    });
    expect(
      await browser.execute(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    await browser.execute(() => {
      document.documentElement.style.zoom = '';
    });
    await diagnose('Descendant preview cancel', async () => {
      const currentDialog = $('dialog.confirmation-dialog[open]');
      await expect(currentDialog).toExist();
      await currentDialog.$('button=Cancel').click();
    });
    expect(existsSync(first)).toBe(true);
    expect(existsSync(child)).toBe(true);
    expect(existsSync(grandchild)).toBe(true);

    await openRemoval();
    await $('dialog.confirmation-dialog[open]').$('button=Mark 3 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(grandchild)));
    await $(`[data-pending-worktree="${grandchild}"]`).$('button=Clean up this worktree…').click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('Pending worktrees with files'),
    );
    expect(existsSync(uncommitted)).toBe(true);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(child)).toBe(true);
    expect(existsSync(grandchild)).toBe(true);
    expect(await catalogPaths()).toEqual([
      first,
      second,
      retained,
      child,
      grandchild,
      external,
      pendingParent,
    ]);

    rmSync(uncommitted);
    expect(await cleanPending(grandchild)).toBe(false);
    expect((await pendingCleanup(grandchild))?.reason).toContain(
      'temporary data is still in use or cannot be verified',
    );
    expect(existsSync(grandchild)).toBe(true);
    expect(existsSync(child)).toBe(true);
    expect(existsSync(first)).toBe(true);
    expect(await pendingCleanup(first)).toBeDefined();
    expect(existsSync(external)).toBe(true);
    expect(await catalogPaths()).toEqual([
      first,
      second,
      retained,
      child,
      grandchild,
      external,
      pendingParent,
    ]);
  });

  it('keeps an occupied original path and restores its registered recovery before cleanup', async () => {
    const original = join(worktrees, 'recovery-original');
    const recovery = join(worktrees, '.sail-pending-recovery');
    git('worktree', 'add', '-q', '-b', 'recovery-original', original);
    git('worktree', 'move', original, recovery);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((worktree) => worktree.path === recovery)?.generation;
    if (!generation) throw new Error('Missing registered recovery generation');
    await browser.execute(
      (repo, originalPath, recoveryPath, identity) => {
        localStorage.setItem('sai-directory', repo);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                {
                  path: recoveryPath,
                  branch: 'recovery-original',
                  generation: identity,
                  pendingCleanup: {
                    originalPath,
                    recoveryPath,
                    sizeBytes: 4096,
                    reason: 'Original path was occupied after cleanup stopped.',
                  },
                },
              ],
            },
          }),
        );
      },
      repository,
      original,
      recovery,
      generation,
    );
    await carryTaskRegisteredWorktrees();
    git('worktree', 'add', '-q', '-b', 'recovery-replacement', original);
    await browser.refresh();
    await browser.waitUntil(async () => $(`[data-pending-worktree="${recovery}"]`).isDisplayed());
    await expect($(`[data-pending-worktree="${recovery}"]`)).toHaveText(
      expect.stringContaining('Original path was occupied'),
    );
    await $(`[data-pending-worktree="${recovery}"]`).$('button=Clean up this worktree…').click();
    await expect($('.app-shell [role="alert"]')).toHaveText(expect.stringContaining('is occupied'));
    expect(existsSync(original)).toBe(true);
    expect(existsSync(recovery)).toBe(true);
    expect(git('worktree', 'list')).toContain(recovery);

    git('worktree', 'remove', original);
    await $(`[data-pending-worktree="${recovery}"]`).$('button=Clean up this worktree…').click();
    await browser.waitUntil(
      async () =>
        !!(await pendingCleanup(original)) ||
        /private Git state/i.test((await pendingCleanup(recovery))?.reason ?? ''),
    );
    if (!(await pendingCleanup(original))) {
      await expect($(`[data-pending-worktree="${recovery}"]`)).toHaveText(
        expect.stringMatching(/private Git state/i),
      );
      expect(existsSync(original)).toBe(false);
      expect(existsSync(recovery)).toBe(true);
      expect(git('worktree', 'list')).toContain(recovery);
      return;
    }
    expect(existsSync(recovery)).toBe(false);
    expect(existsSync(original)).toBe(true);
    expect((await pendingCleanup(original))?.recoveryPath).toBe(original);
    await browser.refresh();
    await browser.waitUntil(async () => $(`[data-pending-worktree="${original}"]`).isDisplayed());
    await $(`[data-pending-worktree="${original}"]`).$('button=Clean up this worktree…').click();
    const dialog = $('dialog.confirmation-dialog[open]');
    const alert = $('.app-shell [role="alert"]');
    await browser.waitUntil(
      async () =>
        (await dialog.isExisting()) ||
        ((await alert.isExisting()) && (await alert.getText()).includes('Private Git state')),
    );
    if (await dialog.isExisting()) {
      await dialog.$('button=Remove this worktree').click();
      await diagnose('Recovery cleanup result', () =>
        browser.waitUntil(
          async () => {
            const pending = await pendingCleanup(original);
            return (
              (!existsSync(original) && !pending) ||
              !!pending?.storagePaths?.length ||
              /(An agent session is starting|Private Git state|unverifiable owner|temporary data is still in use or cannot be verified)/i.test(
                pending?.reason ?? '',
              )
            );
          },
          { timeout: 30000 },
        ),
      );
      if ((await pendingCleanup(original))?.storagePaths?.length) {
        await retryPendingStorage(original);
        await diagnose('Recovered checkout storage cleanup', () =>
          browser.waitUntil(async () => !(await catalogPaths()).includes(original)),
        );
        expect(existsSync(original)).toBe(false);
      } else if (await pendingCleanup(original)) {
        await expect($(`[data-pending-worktree="${original}"]`)).toHaveText(
          expect.stringMatching(
            /An agent session is starting|Private Git state|unverifiable owner|temporary data is still in use or cannot be verified/i,
          ),
        );
        expect(existsSync(original)).toBe(true);
        expect(git('worktree', 'list')).toContain(original);
      }
    } else {
      await expect($(`[data-pending-worktree="${original}"]`)).toHaveText(
        expect.stringContaining('Private Git state'),
      );
      expect(existsSync(original)).toBe(true);
      expect(git('worktree', 'list')).toContain(original);
      expect((await pendingCleanup(original))?.recoveryPath).toBe(original);
    }
  });

  it('recovers an interrupted staged checkout beside an external replacement', async () => {
    const original = join(worktrees, 'interrupted-child');
    const recovery = join(worktrees, `.sail-removing-${randomUUID()}`);
    git('worktree', 'add', '-q', '-b', 'interrupted-child', original);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === original)?.generation;
    if (!generation) throw new Error('Missing interrupted worktree generation');
    await select(first, false);
    await browser.execute(
      (repo, path, expectedGeneration) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push({
          path,
          branch: 'interrupted-child',
          generation: expectedGeneration,
          pendingCleanup: {
            originalPath: path,
            recoveryPath: path,
            sizeBytes: 0,
            reason: 'Awaiting explicit confirmation that this worktree is unused.',
          },
        });
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      original,
      generation,
    );
    git('worktree', 'move', original, recovery);
    git('worktree', 'add', '-q', '-b', 'external-replacement', original);
    await browser.refresh();
    await diagnose('Interrupted pending row', () =>
      browser.waitUntil(async () => $(`[data-pending-worktree="${original}"]`).isDisplayed()),
    );
    await $(`[data-pending-worktree="${original}"]`).$('button=Recheck worktree').click();
    await diagnose('Recovered staged checkout', () =>
      browser.waitUntil(async () => (await pendingCleanup(recovery))?.originalPath === original),
    );
    await expect($(`[data-pending-worktree="${recovery}"]`)).toHaveText(
      expect.stringContaining('interrupted cleanup'),
    );
    await $(`[data-pending-worktree="${recovery}"]`).$('button=Clean up this worktree…').click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('Recovery worktree kept at'),
    );
    expect(existsSync(original)).toBe(true);
    expect(existsSync(recovery)).toBe(true);
    git('worktree', 'remove', recovery);
    git('worktree', 'remove', original);
  });

  it('follows a pending checkout moved with Git after recheck and restart', async () => {
    const original = join(worktrees, 'moved-pending-original');
    const moved = join(worktrees, 'moved-pending-new');
    git('worktree', 'add', '-q', '-b', 'moved-pending', original);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === original)?.generation;
    if (!generation) throw new Error('Missing movable worktree generation');
    await select(repository, false);
    await browser.execute(
      (repo, path, identity) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push({ path, branch: 'moved-pending', generation: identity });
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      original,
      generation,
    );
    await carryTaskRegisteredWorktrees();
    await browser.refresh();
    await diagnose('Movable worktree row', () =>
      expect($(`.project-worktree-select[title="${original}"]`)).toBeDisplayed(),
    );
    await openRemovalConfirmation(original, 'moved-pending');
    await $('dialog.confirmation-dialog[open]').$('button=Mark 1 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(original)));
    git('worktree', 'move', original, moved);
    await $(`[data-pending-worktree="${original}"]`).$('button=Recheck worktree').click();
    await diagnose('Moved pending row', () =>
      browser.waitUntil(async () => (await pendingCleanup(moved))?.recoveryPath === moved),
    );
    await browser.refresh();
    await diagnose('Moved row after restart', () =>
      expect($(`[data-pending-worktree="${moved}"]`)).toBeDisplayed(),
    );
    await $(`[data-pending-worktree="${moved}"]`).$('button=Clean up this worktree…').click();
    await diagnose('Restored original row', () =>
      browser.waitUntil(async () => (await pendingCleanup(original))?.recoveryPath === original),
    );
    expect(existsSync(original)).toBe(true);
    expect(existsSync(moved)).toBe(false);
    await browser.refresh();
    await diagnose('Restored row after restart', () =>
      expect($(`[data-pending-worktree="${original}"]`)).toBeDisplayed(),
    );
    expect(
      (await pendingCleanup(original))?.registeredWorktreesAtMark?.some(
        (entry) => entry.path === original && entry.generation === generation,
      ),
    ).toBe(true);
  });

  it('keeps a staged child recovery when its parent is marked pending', async () => {
    const parent = join(worktrees, 'staged-child-parent');
    const original = join(worktrees, 'staged-child-original');
    const recovery = join(worktrees, 'staged-child-recovery');
    git('worktree', 'add', '-q', '-b', 'staged-child-parent', parent);
    git('worktree', 'add', '-q', '-b', 'staged-child', original);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const parentGeneration = registered.find((item) => item.path === parent)?.generation;
    const childGeneration = registered.find((item) => item.path === original)?.generation;
    if (!parentGeneration || !childGeneration) throw new Error('Missing staged child identities');
    await select(repository, false);
    git('worktree', 'move', original, recovery);
    await browser.execute(
      (repo, source, originalPath, recoveryPath, sourceGeneration, generation) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push(
          { path: source, branch: 'staged-child-parent', generation: sourceGeneration },
          {
            path: recoveryPath,
            branch: 'staged-child',
            generation,
            origin: {
              sourcePath: source,
              sourceGeneration,
              agent: 'codex',
              sessionId: 'staged-child-session',
              sessionTitle: 'Staged child',
            },
            pendingCleanup: {
              originalPath,
              recoveryPath,
              sizeBytes: 0,
              reason: 'Interrupted cleanup left this checkout at its recovery path.',
            },
          },
        );
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      parent,
      original,
      recovery,
      parentGeneration,
      childGeneration,
    );
    await carryTaskRegisteredWorktrees();
    await browser.refresh();
    await diagnose('Parent with staged child', () =>
      expect($(`.project-worktree-select[title="${parent}"]`)).toBeDisplayed(),
    );
    await openRemovalConfirmation(parent, 'staged-child-parent');
    await expect($('dialog.confirmation-dialog[open]')).toHaveText(
      expect.stringContaining(recovery),
    );
    await $('dialog.confirmation-dialog[open]').$('button=Mark 2 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(parent)));
    expect((await pendingCleanup(recovery))?.originalPath).toBe(original);
    await browser.refresh();
    expect((await pendingCleanup(recovery))?.originalPath).toBe(original);
    await $(`[data-pending-worktree="${recovery}"]`).$('button=Clean up this worktree…').click();
    await diagnose('Child restored after parent mark', () =>
      browser.waitUntil(async () => (await pendingCleanup(original))?.recoveryPath === original),
    );
    expect(existsSync(original)).toBe(true);
    expect(existsSync(recovery)).toBe(false);
    git('worktree', 'remove', original);
    git('worktree', 'remove', parent);
  });

  it('keeps confirmed cleanup pending when a moved checkout generation cannot be read', async () => {
    const original = join(worktrees, 'unverifiable-original');
    const moved = join(worktrees, 'unverifiable-moved');
    git('worktree', 'add', '-q', '-b', 'unverifiable', original);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === original)?.generation;
    if (!generation) throw new Error('Missing generation for unverifiable checkout');
    await select(repository, false);
    await browser.execute(
      (repo, path, identity) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push({
          path,
          branch: 'unverifiable',
          generation: identity,
          pendingCleanup: {
            originalPath: path,
            recoveryPath: path,
            sizeBytes: 0,
            reason: 'Confirmed cleanup was interrupted.',
            selectedWorktreeCleanupConfirmed: true,
          },
        });
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      original,
      generation,
    );
    await carryTaskRegisteredWorktrees();
    git('worktree', 'move', original, moved);
    const admin = execFileSync('git', ['-C', moved, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    const marker = join(admin, 'sail-worktree-generation-v1');
    const savedMarker = readFileSync(marker);
    writeFileSync(marker, 'malformed generation marker');
    try {
      await browser.refresh();
      await diagnose('Unverifiable checkout after reload', () =>
        expect($(`[data-pending-worktree="${original}"]`)).toBeDisplayed(),
      );
      const current = await browser.tauri.execute(
        async ({ core }, repo) =>
          core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
            repository: repo,
          }),
        repository,
      );
      expect(current.find((item) => item.path === moved)?.generation).toBeNull();
      await $(`[data-pending-worktree="${original}"]`).$('button=Recheck worktree').click();
      await diagnose('Unverifiable moved checkout retained', () =>
        browser.waitUntil(async () =>
          (await pendingCleanup(original))?.reason.includes('unverifiable Git generation'),
        ),
      );
      expect(existsSync(moved)).toBe(true);
    } finally {
      writeFileSync(marker, savedMarker);
    }
    await $(`[data-pending-worktree="${original}"]`).$('button=Recheck worktree').click();
    await diagnose('Verified moved checkout recovered', () =>
      browser.waitUntil(async () => (await pendingCleanup(moved))?.originalPath === original),
    );
    git('worktree', 'remove', moved);
  });

  it('retains an interrupted private Git overlay for separate recovery', async () => {
    const path = join(worktrees, 'interrupted-overlay');
    git('worktree', 'add', '-q', '-b', 'interrupted-overlay', path);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === path)?.generation;
    if (!generation) throw new Error('Missing generation for overlay checkout');
    const sourceGitDir = execFileSync('git', ['-C', path, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim();
    const head = git('-C', path, 'rev-parse', 'HEAD').trim();
    const cache = await browser.tauri.execute(async ({ core }) =>
      core.invoke<string>('plugin:path|resolve_directory', { directory: 16 }),
    );
    if (!cache.includes('dev.smykla.sail.e2e')) {
      throw new Error(`Refusing overlay fixture outside the task-owned E2E app: ${cache}`);
    }
    const deletedStorage = join(cache, `deleted-selected-storage-${randomUUID()}`);
    if (existsSync(deletedStorage)) throw new Error('Interrupted storage fixture is not absent');
    await select(repository, false);
    await browser.execute(
      (repo, selected, identity, missingStorage) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push({
          path: selected,
          branch: 'interrupted-overlay',
          generation: identity,
          pendingCleanup: {
            originalPath: selected,
            recoveryPath: selected,
            sizeBytes: 0,
            reason: 'Confirmed selected cleanup was interrupted.',
            storagePaths: [missingStorage],
            storageKeys: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
            selectedWorktreeCleanupConfirmed: true,
            selectedStorageCleanupConfirmed: true,
          },
        });
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      path,
      generation,
      deletedStorage,
    );
    git('worktree', 'remove', path);
    await carryTaskRegisteredWorktrees();
    const identity = join(realpathSync(dirname(path)), basename(path));
    const key = createHash('sha256')
      .update(Buffer.from(identity, process.platform === 'win32' ? 'utf16le' : 'utf8'))
      .digest('hex');
    const manifest = join(cache, 'git-overlay-manifests', `${key}.json`);
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        worktree: identity,
        sourceGitDir,
        commonDir: realpathSync(join(repository, '.git')),
        branch: 'refs/heads/interrupted-overlay',
        promotedOid: head,
        sourceIndexHash: null,
        promotion: null,
      }),
    );
    const manifestBytes = readFileSync(manifest);
    await browser.refresh();
    expect((await pendingCleanup(path))?.storagePaths).toEqual([deletedStorage]);
    await expect($(`[data-pending-worktree="${path}"]`)).toHaveText(
      expect.stringContaining(deletedStorage),
    );
    await $(`[data-pending-worktree="${path}"]`).$('button=Recheck storage').click();
    await diagnose('Interrupted overlay retained', () =>
      browser.waitUntil(async () => (await pendingCleanup(path))?.reason.includes(manifest)),
    );
    expect((await pendingCleanup(path))?.storagePaths ?? []).toEqual([]);
    await browser.refresh();
    expect((await pendingCleanup(path))?.storagePaths ?? []).toEqual([]);
    const row = $(`[data-pending-worktree="${path}"]`);
    await expect(row).toHaveText(expect.stringContaining(manifest));
    await expect(row).toHaveText(expect.stringContaining('bytes'));
    await expect(row).toHaveText(expect.stringContaining('separate recovery'));
    await expect(row.$('button=Clean up this worktree…')).toBeDisabled();
    expect((await catalogPaths()).includes(path)).toBe(true);
    expect(readFileSync(manifest).equals(manifestBytes)).toBe(true);
    await row.$('button=Recheck worktree').click();
    await diagnose('Interrupted overlay stays pending after recheck', () =>
      browser.waitUntil(async () => (await pendingCleanup(path))?.reason.includes(manifest)),
    );
    expect(readFileSync(manifest).equals(manifestBytes)).toBe(true);
  });

  it('settles a confirmed checkout removed before its catalog update after restart', async () => {
    const path = join(worktrees, 'interrupted-confirmed');
    git('worktree', 'add', '-q', '-b', 'interrupted-confirmed', path);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === path)?.generation;
    if (!generation) throw new Error('Missing confirmed worktree generation');
    await select(repository, false);
    await browser.execute(
      (repo, selected, identity) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push({
          path: selected,
          branch: 'interrupted-confirmed',
          generation: identity,
          pendingCleanup: {
            originalPath: selected,
            recoveryPath: selected,
            sizeBytes: 0,
            reason: 'Unused cleanup was confirmed before interruption.',
            selectedWorktreeCleanupConfirmed: true,
          },
        });
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      path,
      generation,
    );
    await carryTaskRegisteredWorktrees();
    const [preview] = await browser.tauri.execute(
      async ({ core }, input) =>
        core.invoke<
          { path: string; branch: string | null; revision: string; generation: string | null }[]
        >('worktree_removal_preview', { repository: input.repository, paths: [input.path] }),
      { repository, path },
    );
    if (!preview || preview.generation !== generation)
      throw new Error('Confirmed checkout changed before native removal');
    await browser.tauri.execute(
      async ({ core }, input) =>
        core.invoke('delete_worktree', {
          request: {
            repository: input.repository,
            worktree: input.path,
            force: false,
            expectedRevision: input.preview.revision,
            expectedBranch: input.preview.branch,
            expectedGeneration: input.preview.generation,
            expectedRegisteredWorktrees: input.registered.map((item) => ({
              path: item.path,
              generation: item.generation,
            })),
            confirmedUnused: true,
          },
        }),
      { repository, path, preview, registered },
    );
    expect(existsSync(path)).toBe(false);
    expect(git('worktree', 'list')).not.toContain(path);
    // Reload before Sail can persist the success response. The saved catalog still has the row.
    await browser.refresh();
    await diagnose('Interrupted confirmed row', () =>
      expect($(`[data-pending-worktree="${path}"]`)).toBeDisplayed(),
    );
    await $(`[data-pending-worktree="${path}"]`).$('button=Recheck worktree').click();
    await diagnose('Interrupted confirmed cleanup settlement', () =>
      browser.waitUntil(async () => !(await catalogPaths()).includes(path)),
    );
  });

  it('previews a saved alias descendant when the selected repository is already canonical', async () => {
    const alias = join(worktrees, 'repository-alias');
    const parent = join(worktrees, 'alias-parent');
    const child = join(worktrees, 'alias-child');
    symlinkSync(repository, alias, 'dir');
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
    if (!parentGeneration || !childGeneration) throw new Error('Missing alias fixture generations');
    const taskRows = registered
      .filter((item) => item.path !== repository)
      .map((item) => {
        const withinFixture = relative(worktrees, item.path);
        if (
          !withinFixture ||
          withinFixture === '..' ||
          withinFixture.startsWith(`..${sep}`) ||
          isAbsolute(withinFixture) ||
          !existsSync(item.path) ||
          !item.generation
        )
          throw new Error(`Unexpected or unverifiable worktree registration: ${item.path}`);
        return { path: item.path, branch: basename(item.path), generation: item.generation };
      });
    await browser.execute(
      (repo, aliasPath, parentPath, childPath, parentIdentity, rows) => {
        localStorage.setItem('sai-directory', repo);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo, aliasPath],
            groups: [],
            worktrees: {
              [repo]: rows,
              [aliasPath]: [
                {
                  ...rows.find((item: { path: string }) => item.path === childPath),
                  origin: {
                    sourcePath: parentPath,
                    sourceGeneration: parentIdentity,
                    agent: 'test',
                    sessionId: 'alias-descendant',
                    sessionTitle: 'Alias descendant',
                  },
                },
              ],
            },
          }),
        );
      },
      repository,
      alias,
      parent,
      child,
      parentGeneration,
      taskRows,
    );
    await browser.refresh();
    await diagnose('Saved alias merged before preview', () =>
      browser.waitUntil(async () =>
        browser.execute(
          (repo, aliasPath, childPath, parentPath) => {
            const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
            return (
              !catalog.repositories?.includes(aliasPath) &&
              catalog.worktrees?.[repo]?.some(
                (item: { path: string; origin?: { sourcePath: string } }) =>
                  item.path === childPath && item.origin?.sourcePath === parentPath,
              )
            );
          },
          repository,
          alias,
          child,
          parent,
        ),
      ),
    );
    await openRemovalConfirmation(parent, 'alias-parent');
    await expect($('dialog.confirmation-dialog[open]')).toHaveText(expect.stringContaining(child));
    await $('dialog.confirmation-dialog[open]').$('button=Cancel').click();
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(child)).toBe(true);
  });

  it('keeps a moved Sail child from an unavailable alias in parent cleanup', async () => {
    const parent = join(worktrees, 'moved-parent');
    const original = join(worktrees, 'moved-child-original');
    const moved = join(worktrees, 'moved-child-current');
    const unavailableAlias = join(worktrees, 'moved-child-unavailable-alias');
    await select(first, false);
    await carryTaskRegisteredWorktrees();
    git('worktree', 'add', '-q', '-b', 'moved-parent', parent);
    git('worktree', 'add', '-q', '-b', 'moved-child', original);
    const beforeMove = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = (path: string) => {
      const value = beforeMove.find((item) => item.path === path)?.generation;
      if (!value) throw new Error(`Missing moved-child fixture generation at ${path}`);
      return value;
    };
    const parentGeneration = generation(parent);
    const childGeneration = generation(original);
    git('worktree', 'move', original, moved);
    const afterMove = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    expect(afterMove.find((item) => item.path === moved)?.generation).toBe(childGeneration);
    await browser.execute(
      (repo, alias, parentPath, oldChildPath, parentIdentity, childIdentity) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.repositories.push(alias);
        catalog.worktrees[repo].push({
          path: parentPath,
          branch: 'moved-parent',
          generation: parentIdentity,
        });
        catalog.worktrees[alias] = [
          {
            path: oldChildPath,
            branch: 'moved-child',
            generation: childIdentity,
            origin: {
              sourcePath: parentPath,
              sourceGeneration: parentIdentity,
              agent: 'codex',
              sessionId: 'moved-child-session',
              sessionTitle: 'Moved child',
            },
          },
        ];
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      unavailableAlias,
      parent,
      original,
      parentGeneration,
      childGeneration,
    );
    await browser.refresh();
    const external = $(`.project-worktree-select[title="${moved}"]`);
    await diagnose('Moved child external row', () => expect(external).toBeDisplayed());
    await external.click();
    await diagnose('Moved child Sail ancestry restored', () =>
      browser.waitUntil(async () =>
        browser.execute(
          (repo, alias, oldPath, currentPath, sourcePath) => {
            const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
            const entries = catalog.worktrees?.[repo] ?? [];
            return (
              !entries.some((item: { path: string }) => item.path === oldPath) &&
              !(catalog.worktrees?.[alias] ?? []).some(
                (item: { path: string }) => item.path === oldPath,
              ) &&
              entries.some(
                (item: { path: string; origin?: { sourcePath: string } }) =>
                  item.path === currentPath && item.origin?.sourcePath === sourcePath,
              )
            );
          },
          repository,
          unavailableAlias,
          original,
          moved,
          parent,
        ),
      ),
    );
    await openRemovalConfirmation(parent, 'moved-parent');
    const dialog = $('dialog.confirmation-dialog[open]');
    await expect(dialog).toHaveText(expect.stringContaining(moved));
    await dialog.$('button=Mark 2 pending').click();
    await diagnose('Moved child and parent remain pending', () =>
      browser.waitUntil(
        async () => !!(await pendingCleanup(parent)) && !!(await pendingCleanup(moved)),
      ),
    );
    await $(`[data-pending-worktree="${parent}"]`).$('button=Clean up this worktree…').click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('A live descendant remains registered'),
    );
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(moved)).toBe(true);
  });
});

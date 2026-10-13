import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topbarMenuTrigger } from './topbar';
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

  async function retryPendingStorage(path: string) {
    await $(`[data-pending-worktree="${path}"]`)
      .$('button=Retry selected storage cleanup…')
      .click();
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

  async function cleanPending(path: string, expectedSize?: number) {
    await $(`[data-pending-worktree="${path}"]`).$('button=Clean up this worktree…').click();
    await diagnose(`Pending cleanup dialog ${path}`, async () => {
      const dialog = $('dialog.confirmation-dialog[open]');
      await expect(dialog).toExist();
      await expect(dialog).toHaveText(
        expect.stringContaining(
          'no other process will write to, move, or replace either until cleanup finishes',
        ),
      );
      if (expectedSize !== undefined)
        await expect(dialog).toHaveText(
          expect.stringContaining(`Retained size: ${expectedSize} bytes`),
        );
      await dialog.$('button=Remove this worktree').click();
    });
    await diagnose(`Pending checkout result ${path}`, () =>
      browser.waitUntil(
        async () =>
          !(await catalogPaths()).includes(path) ||
          !!(await pendingCleanup(path))?.storagePaths?.length,
      ),
    );
    if ((await pendingCleanup(path))?.storagePaths?.length) {
      await retryPendingStorage(path);
    }
    await diagnose(`Pending cleanup result ${path}`, () =>
      browser.waitUntil(async () => !(await catalogPaths()).includes(path)),
    );
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

  it('marks only the selected worktree pending when pressed repeatedly, then cleans it explicitly', async () => {
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
    await cleanPending(second, current.sizeBytes);
    await diagnose('Explicit cleanup', async () => {
      await browser.waitUntil(async () => !existsSync(second));
      await browser.waitUntil(async () => (await catalogPaths()).length === 1);
    });
    expect(await catalogPaths()).toEqual([first]);
    expect(existsSync(first)).toBe(true);
    expect(git('worktree', 'list')).not.toContain(second);
    await expect($('.app-shell [role="alert"]')).not.toExist();
    expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(repository);
    expect(
      await browser.execute((path) => localStorage.getItem(`sai-main-pane-empty:${path}`), second),
    ).toBeNull();
    await expect($('dialog[open]')).not.toExist();
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
    await browser.waitUntil(async () =>
      (await pendingCleanup(completed))?.reason.includes('removed outside Sail'),
    );
    expect(await catalogPaths()).toContain(completed);
    expect(existsSync(completed)).toBe(true);
    expect(git('worktree', 'list')).toContain(completed);
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

  it('removes a clean detached descendant and preserves its commit', async () => {
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
      detached,
      generation(first),
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
    await cleanPending(detached);
    await browser.waitUntil(() => !existsSync(detached));
    await cleanPending(first);
    await browser.waitUntil(() => !existsSync(first) && !existsSync(detached));
    await browser.waitUntil(async () => (await catalogPaths()).length === 0);
    expect(
      git('for-each-ref', '--format=%(objectname)', 'refs/sail/preserved-detached').trim(),
    ).toBe(head);
    git('worktree', 'add', '-q', first, 'first');
  });

  it('keeps a pending parent when another instance registers an unseen child', async () => {
    const parent = join(worktrees, 'inventory-parent');
    const child = join(worktrees, 'inventory-new-child');
    git('worktree', 'add', '-q', '-b', 'inventory-parent', parent);
    const registered = await browser.tauri.execute(
      async ({ core }, repo) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: repo,
        }),
      repository,
    );
    const generation = registered.find((item) => item.path === parent)?.generation;
    if (!generation) throw new Error('Missing pending parent generation');
    await select(first, false);
    await browser.execute(
      (repo, path, identity) => {
        const catalog = JSON.parse(localStorage.getItem('sai-project-catalog') ?? '{}');
        catalog.worktrees[repo].push({ path, branch: 'inventory-parent', generation: identity });
        localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
      },
      repository,
      parent,
      generation,
    );
    await browser.refresh();
    await diagnose('Pending parent row', () =>
      expect($(`.project-worktree-select[title="${parent}"]`)).toBeDisplayed(),
    );
    await $(`.project-worktree-select[title="${parent}"]`).click({ button: 'right' });
    await $('[aria-label="Delete worktree inventory-parent"]').click();
    await $('dialog.confirmation-dialog[open]').$('button=Mark 1 pending').click();
    await browser.waitUntil(async () => !!(await pendingCleanup(parent)));
    git('worktree', 'add', '-q', '-b', 'inventory-new-child', child);
    await $(`[data-pending-worktree="${parent}"]`).$('button=Clean up this worktree…').click();
    await $('dialog.confirmation-dialog[open]').$('button=Remove this worktree').click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('registered worktree is not in this catalog'),
    );
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(child)).toBe(true);
    expect(await pendingCleanup(parent)).toBeDefined();
    git('worktree', 'remove', child);
    await cleanPending(parent);
    await browser.waitUntil(() => !existsSync(parent));
  });

  it('previews Sail descendants, preserves them pending, and cleans selected checkouts leaves first', async () => {
    const child = join(worktrees, 'child');
    const grandchild = join(worktrees, 'grandchild');
    const external = join(worktrees, 'external');
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
      (repo, root, descendant, leaf, unrelated, identities) => {
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                { path: root, branch: 'first', generation: identities.root },
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
      child,
      grandchild,
      external,
      {
        root: generation(first),
        child: generation(child),
        grandchild: generation(grandchild),
        external: generation(external),
      },
    );
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
      await $(`.project-worktree-select[title="${first}"]`).click({ button: 'right' });
      await $('[aria-label="Delete worktree first"]').click();
    };
    await openRemoval();
    const dialog = $('dialog.confirmation-dialog[open]');
    await diagnose('Descendant dialog', () =>
      expect(dialog).toHaveText(expect.stringContaining('grandchild')),
    );
    await expect(dialog).toHaveText(expect.stringContaining('uncommitted changes'));
    await expect(dialog).not.toHaveText(expect.stringContaining('external'));
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
    await dialog.$('button=Cancel').click();
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
    expect(await catalogPaths()).toEqual([first, child, grandchild, external]);

    rmSync(uncommitted);
    await cleanPending(grandchild);
    await browser.waitUntil(() => !existsSync(grandchild));
    await cleanPending(child);
    await browser.waitUntil(() => !existsSync(child));
    await cleanPending(first);
    await browser.waitUntil(
      () => !existsSync(first) && !existsSync(child) && !existsSync(grandchild),
    );
    await browser.waitUntil(async () => (await catalogPaths()).length === 1);
    expect(existsSync(external)).toBe(true);
    expect(await catalogPaths()).toEqual([external]);
  });

  it('keeps an occupied original path and restores its registered recovery before cleanup', async () => {
    const original = join(worktrees, 'recovery-original');
    const recovery = join(worktrees, '.sail-pending-recovery');
    git('worktree', 'add', '-q', '-b', 'recovery-original', original);
    git('worktree', 'move', original, recovery);
    git('worktree', 'add', '-q', '-b', 'recovery-replacement', original);
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
              /(An agent session is starting|Private Git state|unverifiable owner)/i.test(
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
            /An agent session is starting|Private Git state|unverifiable owner/i,
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
    await browser.refresh();
    await diagnose('Movable worktree row', () =>
      expect($(`.project-worktree-select[title="${original}"]`)).toBeDisplayed(),
    );
    await $(`.project-worktree-select[title="${original}"]`).click({ button: 'right' });
    await $('[aria-label="Delete worktree moved-pending"]').click();
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
});

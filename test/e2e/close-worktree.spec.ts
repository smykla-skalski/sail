import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
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
    rmSync(repository, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  });

  async function select(directory: string, waitForInventory = true) {
    await browser.execute(
      (repo, selected, firstPath, secondPath) => {
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
                { path: firstPath, branch: 'first' },
                { path: secondPath, branch: 'second' },
              ],
            },
          }),
        );
      },
      repository,
      directory,
      first,
      second,
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

  it('deletes only the selected worktree once when pressed repeatedly', async () => {
    await select(second);
    await browser.execute(() => {
      sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes');
      for (let press = 0; press < 2; press++)
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'w', metaKey: true, shiftKey: true }),
        );
    });
    await diagnose('Repeated delete', async () => {
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

  it('previews and removes only Sail descendants from the leaves inward', async () => {
    const child = join(worktrees, 'child');
    const grandchild = join(worktrees, 'grandchild');
    const external = join(worktrees, 'external');
    git('worktree', 'add', '-q', '-b', 'child', child);
    git('worktree', 'add', '-q', '-b', 'grandchild', grandchild);
    git('worktree', 'add', '-q', '-b', 'external', external);
    writeFileSync(join(grandchild, 'uncommitted.txt'), 'keep until confirmed');
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
    await $('dialog.confirmation-dialog[open]').$('button=Delete 3 worktrees').click();
    await browser.waitUntil(
      () => !existsSync(first) && !existsSync(child) && !existsSync(grandchild),
    );
    await browser.waitUntil(async () => (await catalogPaths()).length === 1);
    expect(existsSync(external)).toBe(true);
    expect(await catalogPaths()).toEqual([external]);
  });
});

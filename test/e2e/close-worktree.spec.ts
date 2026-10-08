import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topbarMenuTrigger } from './topbar';
import { loadProjectCatalog } from '../../src/lib/projects.ts';

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

  async function select(directory: string) {
    await browser.execute(
      (repo, selected, firstPath, secondPath) => {
        sessionStorage.removeItem('sai-e2e-delete-worktree');
        localStorage.setItem('sai-directory', selected);
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
    await select(first);
    await browser.execute(() => {
      sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes');
      localStorage.setItem(`sai-main-pane-empty:${localStorage.getItem('sai-directory')}`, 'true');
      for (let press = 0; press < 2; press++)
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'w', metaKey: true, shiftKey: true }),
        );
    });
    await diagnose('Repeated delete', async () => {
      await browser.waitUntil(async () => !existsSync(first));
      await browser.waitUntil(async () => (await catalogPaths()).length === 1);
    });
    expect(await catalogPaths()).toEqual([second]);
    expect(existsSync(second)).toBe(true);
    expect(git('worktree', 'list')).not.toContain(first);
    await expect($('.app-shell [role="alert"]')).not.toExist();
    expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(repository);
    expect(
      await browser.execute((path) => localStorage.getItem(`sai-main-pane-empty:${path}`), first),
    ).toBeNull();
    await expect($('dialog[open]')).not.toExist();
  });
});

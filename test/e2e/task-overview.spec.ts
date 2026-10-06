import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cross-worktree task overview', () => {
  const root = mkdtempSync(join(tmpdir(), 'sail-task-overview-'));
  const repository = join(root, 'repository');
  const worktree = join(root, 'worktree');

  before(() => {
    execFileSync('git', ['init', '-q', '-b', 'main', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Sail Test']);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'sail@example.test']);
    writeFileSync(join(repository, 'README.md'), 'Sail\n');
    execFileSync('git', ['-C', repository, 'add', 'README.md']);
    execFileSync('git', ['-C', repository, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    execFileSync('git', [
      '-C',
      repository,
      'worktree',
      'add',
      '-q',
      '-b',
      'feat/overview',
      worktree,
    ]);
    writeFileSync(join(worktree, 'changed.txt'), 'changed\n');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('scans, filters, restores, and opens configured worktrees', async () => {
    const repositoryPath = realpathSync(repository);
    const worktreePath = realpathSync(worktree);
    await browser.execute(
      (repo, checkout) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.setItem('sai-directory', repo);
        localStorage.setItem('sai-workspace-view', 'workspace');
        localStorage.removeItem('sai-task-overview');
        localStorage.removeItem('sail-agent-threads');
        localStorage.removeItem('sai-thread-attention');
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [],
            worktrees: {
              [repo]: [
                {
                  path: checkout,
                  branch: 'feat/overview',
                  statusComment: 'Build the cross-worktree overview',
                  setupStatus: 'ready',
                },
              ],
            },
          }),
        );
      },
      repositoryPath,
      worktreePath,
    );
    await browser.refresh();
    await $('.app-shell').waitForDisplayed();

    await $('button=Overview').click();
    await expect($('main[aria-label="Task overview"]')).toBeDisplayed();
    await expect($$('.task-card')).toBeElementsArrayOfSize(2);
    const featureCard = $('.task-card*=Build the cross-worktree overview');
    await expect(featureCard).toHaveText(expect.stringContaining('feat/overview'));
    try {
      await browser.waitUntil(async () => (await featureCard.getText()).includes('Changes 1'), {
        timeoutMsg: 'Changed-file count did not load',
      });
    } catch (cause) {
      console.error('Task overview metadata diagnostic', {
        featureCard: await featureCard.getText(),
        cards: await $$('.task-card').map((card) => card.getText()),
        storedCatalog: await browser.execute(() => localStorage.getItem('sai-project-catalog')),
        storedOverview: await browser.execute(() => localStorage.getItem('sai-task-overview')),
      });
      throw cause;
    }

    await $('.task-overview-search input').setValue('feat/overview');
    await expect($$('.task-card')).toBeElementsArrayOfSize(1);
    await featureCard.$('.task-card-pin').click();
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>('.task-overview-sort select');
      if (!select) throw new Error('Task overview sort is missing');
      select.value = 'pinned';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    try {
      await browser.waitUntil(
        () =>
          browser.execute((path) => {
            const saved: unknown = JSON.parse(localStorage.getItem('sai-task-overview') ?? '{}');
            if (typeof saved !== 'object' || saved === null) return false;
            const sort = Reflect.get(saved, 'sort');
            const pinned: unknown = Reflect.get(saved, 'pinned');
            return sort === 'pinned' && Array.isArray(pinned) && pinned.includes(path);
          }, worktreePath),
        { timeoutMsg: 'Overview preferences were not persisted' },
      );
    } catch (cause) {
      console.error('Task overview preference diagnostic', {
        expectedPath: worktreePath,
        stored: await browser.execute(() => localStorage.getItem('sai-task-overview')),
        pins: await $$('.task-card-pin').map(async (pin) => ({
          label: await pin.getAttribute('aria-label'),
          pressed: await pin.getAttribute('aria-pressed'),
        })),
        sort: await $('.task-overview-sort select').getValue(),
      });
      throw cause;
    }
    await browser.refresh();
    await expect($('main[aria-label="Task overview"]')).toBeDisplayed();
    await expect($('.task-card-pin')).toHaveAttribute('aria-pressed', 'true');
    await expect($('.task-overview-sort select')).toHaveValue('pinned');

    await $('.task-card-main').click();
    await expect($('main[aria-label="Task overview"]')).not.toExist();
    await expect($('.breadcrumb-project')).toHaveText(expect.stringContaining('worktree'));
    const selected = await browser.execute(() => {
      const saved: unknown = JSON.parse(localStorage.getItem('sai-task-overview') ?? '{}');
      return typeof saved === 'object' && saved !== null ? Reflect.get(saved, 'selected') : null;
    });
    expect(selected).toBe(worktreePath);
    expect(await browser.execute(() => localStorage.getItem('sai-workspace-view'))).toBe(
      'workspace',
    );
  });
});

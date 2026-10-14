import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

async function inspectViewport(width: number, height: number, view = 'single') {
  await browser.setWindowSize(width, height);
  const viewport = await browser.execute(() => ({
    width: innerWidth,
    overflows: document.documentElement.scrollWidth > innerWidth,
    messageOverflows: (() => {
      const message = document.querySelector('.confirmation-dialog p');
      return !message || message.scrollWidth > message.clientWidth;
    })(),
  }));
  expect(viewport.overflows).toBe(false);
  expect(viewport.messageOverflows).toBe(false);
  if (width === 2560) {
    console.log(`Force-delete dialog viewport: ${viewport.width}px`);
    if (process.env.SAIL_PR_SCREENSHOT_DIR) {
      await browser.saveScreenshot(
        join(
          process.env.SAIL_PR_SCREENSHOT_DIR,
          `force-delete-${view}-${process.env.SAIL_E2E_APPEARANCE ?? 'light'}-${viewport.width}.png`,
        ),
      );
    }
  }
}

describe('force delete during agent startup', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-force-delete-'));
  const worktree = join(process.env.SAIL_WORKTREE_ROOT!, basename(repository));
  const parent = `${worktree}-parent`;
  const child = `${worktree}-child`;
  const pending = `${worktree}-pending`;
  const startingMarker = join(worktree, '.sail-e2e-session-starting');

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', [
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
      '-q',
      '-m',
      'baseline',
    ]);
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'starting', worktree]);
  });

  after(() => {
    for (const path of [pending, child, parent]) {
      if (existsSync(path))
        execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', path]);
    }
    if (existsSync(worktree)) {
      rmSync(startingMarker, { force: true });
      execFileSync('git', ['-C', repository, 'worktree', 'remove', worktree]);
    }
    rmSync(repository, { recursive: true, force: true });
  });

  it('offers force deletion and stops agents before deleting', async () => {
    const canonicalRepository = realpathSync(repository);
    const canonicalWorktree = realpathSync(worktree);
    await browser.execute(
      (root, path) => {
        sessionStorage.removeItem('sai-e2e-pause-force-cleanup');
        sessionStorage.removeItem('sai-e2e-pause-selected-force-cleanup');
        localStorage.setItem('sai-directory', path);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [root],
            groups: [],
            worktrees: { [root]: [{ path, branch: 'starting' }] },
          }),
        );
      },
      canonicalRepository,
      canonicalWorktree,
    );
    await browser.refresh();
    const row = $(`.project-worktree-select[title="${canonicalWorktree}"]`);
    await expect(row).toBeDisplayed();
    await expect(row).toBeEnabled();
    await browser.tauri.execute(async ({ core }, path) => {
      await core.invoke('acp_connect', { agent: 'claude', directory: path });
    }, canonicalWorktree);
    await browser.execute((path) => {
      const core = Reflect.get(Reflect.get(window, '__TAURI__'), 'core');
      void core
        .invoke('acp_new_session', { params: { agent: 'claude', cwd: path } })
        .catch(() => undefined);
    }, canonicalWorktree);
    await browser.waitUntil(async () => existsSync(startingMarker), {
      timeoutMsg: 'Test agent did not begin its delayed session',
    });

    await browser.execute((path) => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('.project-worktree-select'),
      ].find((item) => item.title === path);
      const group = button?.closest('.project-worktree-row');
      if (!group) throw new Error('Worktree row missing');
      group.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 200,
          clientY: 200,
        }),
      );
    }, canonicalWorktree);
    await expect($('.worktree-menu')).toBeDisplayed();
    await $('.worktree-menu [role="menuitem"].danger').click();
    await expect($('.confirmation-dialog')).toBeDisplayed();
    await expect($('.confirmation-dialog')).toHaveText(
      expect.stringContaining('Sail stops agents running in it'),
    );
    expect(existsSync(worktree)).toBe(true);
    await inspectViewport(2560, 1440);
    await inspectViewport(1920, 1200);
    await inspectViewport(390, 844);
    await browser.setWindowSize(1280, 850);
    await $('.confirmation-dialog .confirmation-primary').click();
    await expect(row).not.toExist();
    expect(existsSync(worktree)).toBe(false);
  });

  it('force deletes descendants and their parent after one confirmation', async () => {
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'parent', parent]);
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'child', child]);
    const canonicalRepository = realpathSync(repository);
    const canonicalParent = realpathSync(parent);
    const canonicalChild = realpathSync(child);
    const registered = await browser.tauri.execute(
      async ({ core }, root) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: root,
        }),
      canonicalRepository,
    );
    const generation = (path: string) => {
      const value = registered.find((item) => item.path === path)?.generation;
      if (!value) throw new Error(`Missing worktree generation for ${path}`);
      return value;
    };
    await browser.execute(
      (root, parentPath, childPath, parentGeneration, childGeneration) => {
        sessionStorage.removeItem('sai-e2e-pause-force-cleanup');
        sessionStorage.removeItem('sai-e2e-pause-selected-force-cleanup');
        localStorage.setItem('sai-directory', parentPath);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [root],
            groups: [],
            worktrees: {
              [root]: [
                { path: parentPath, branch: 'parent', generation: parentGeneration },
                {
                  path: childPath,
                  branch: 'child',
                  generation: childGeneration,
                  origin: {
                    sourcePath: parentPath,
                    sourceGeneration: parentGeneration,
                    agent: 'codex',
                    sessionId: 'child-session',
                    sessionTitle: 'Child',
                  },
                },
              ],
            },
          }),
        );
      },
      canonicalRepository,
      canonicalParent,
      canonicalChild,
      generation(canonicalParent),
      generation(canonicalChild),
    );
    await browser.refresh();
    const parentRow = $(`.project-worktree-select[title="${canonicalParent}"]`);
    const childRow = $(`.project-worktree-select[title="${canonicalChild}"]`);
    await expect(parentRow).toBeDisplayed();
    await expect(childRow).toBeDisplayed();
    await parentRow.click({ button: 'right' });
    await $('[aria-label="Delete worktree parent"]').click();
    const dialog = $('dialog.confirmation-dialog[open]');
    await expect(dialog).toHaveText(expect.stringContaining('Force delete these 2 worktrees'));
    await inspectViewport(2560, 1440, 'descendants');
    await dialog.$('button=Force delete 2 worktrees').click();
    await browser.waitUntil(
      async () => !(await parentRow.isExisting()) && !(await childRow.isExisting()),
      { timeout: 30000, timeoutMsg: 'Descendant force deletion did not remove both rows' },
    );
    await expect(parentRow).not.toExist();
    await expect(childRow).not.toExist();
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(child)).toBe(false);
  });

  it('force deletes an already-pending dirty worktree', async () => {
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'pending', pending]);
    const canonicalRepository = realpathSync(repository);
    const canonicalPending = realpathSync(pending);
    const dirty = join(canonicalPending, 'uncommitted.txt');
    writeFileSync(dirty, 'remove me');
    const registered = await browser.tauri.execute(
      async ({ core }, root) =>
        core.invoke<{ path: string; generation: string | null }[]>('repository_worktrees', {
          repository: root,
        }),
      canonicalRepository,
    );
    const generation = registered.find((item) => item.path === canonicalPending)?.generation;
    if (!generation) throw new Error('Missing pending worktree generation');
    await browser.execute(
      (root, path, identity) => {
        sessionStorage.removeItem('sai-e2e-pause-force-cleanup');
        sessionStorage.removeItem('sai-e2e-pause-selected-force-cleanup');
        localStorage.setItem('sai-directory', root);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [root],
            groups: [],
            worktrees: {
              [root]: [
                {
                  path,
                  branch: 'pending',
                  generation: identity,
                  pendingCleanup: {
                    originalPath: path,
                    recoveryPath: path,
                    sizeBytes: 1,
                    reason: 'Previous cleanup did not finish.',
                  },
                },
              ],
            },
          }),
        );
      },
      canonicalRepository,
      canonicalPending,
      generation,
    );
    await browser.refresh();
    const row = $(`[data-pending-worktree="${canonicalPending}"]`);
    await expect(row).toBeDisplayed();
    await row.$('button=Force delete this worktree…').click();
    const dialog = $('dialog.confirmation-dialog[open]');
    await expect(dialog).toHaveText(
      expect.stringContaining(
        'Sail stops agents running in it and permanently removes uncommitted, untracked, and ignored files',
      ),
    );
    await inspectViewport(2560, 1440, 'pending');
    await dialog.$('button=Force delete').click();
    await expect(row).not.toExist();
    expect(existsSync(dirty)).toBe(false);
    expect(existsSync(pending)).toBe(false);
  });
});

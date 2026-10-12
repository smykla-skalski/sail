import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

async function inspectViewport(width: number, height: number) {
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
          `force-delete-${process.env.SAIL_E2E_APPEARANCE ?? 'light'}-${viewport.width}.png`,
        ),
      );
    }
  }
}

describe('force delete during agent startup', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-force-delete-'));
  const worktree = join(process.env.SAIL_WORKTREE_ROOT!, basename(repository));
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
    if (existsSync(worktree)) {
      rmSync(startingMarker, { force: true });
      execFileSync('git', ['-C', repository, 'worktree', 'remove', worktree]);
    }
    rmSync(repository, { recursive: true, force: true });
  });

  it('offers a confirmed retry and stops agents before deleting', async () => {
    const canonicalRepository = realpathSync(repository);
    const canonicalWorktree = realpathSync(worktree);
    await browser.execute(
      (root, path) => {
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
    await browser.execute(() => sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes'));
    await $('.worktree-menu [role="menuitem"].danger').click();
    await expect($('.confirmation-dialog')).toBeDisplayed();
    await expect($('.confirmation-dialog')).toHaveText(
      expect.stringContaining('running or starting'),
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
});

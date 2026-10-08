import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { returnToWorkspace, openSettings } from './settings-window';

async function openDiagnostics() {
  await openSettings();
  await $('.settings-navigation button:nth-child(2)').click();
  return $('.repository-diagnostics');
}

describe('repository setup', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sai-onboarding-'));
  const secondRepository = mkdtempSync(join(tmpdir(), 'sai-onboarding-second-'));

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
    execFileSync('git', ['init', '-q', secondRepository]);
  });

  after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(secondRepository, { recursive: true, force: true });
  });

  it('lists named project groups and switches repositories', async () => {
    await browser.execute(
      (first, second) => {
        localStorage.setItem('sai-directory', first);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [first, second],
            groups: [{ id: 'work', name: 'Work', collapsed: false, repositories: [second] }],
          }),
        );
      },
      repository,
      secondRepository,
    );
    await browser.refresh();
    await expect($('.project-group-toggle')).toHaveText(expect.stringContaining('Work'));
    await expect($(`.project-default-worktree-select[title="${secondRepository}"]`)).toBeEnabled();
    await $(`.project-default-worktree-select[title="${secondRepository}"]`).click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) ===
        realpathSync(secondRepository),
      { timeout: 60_000, timeoutMsg: 'App did not switch to the selected repository' },
    );
    expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(
      realpathSync(secondRepository),
    );
    await expect(
      $(`.project-default-worktree-select[title="${realpathSync(secondRepository)}"]`),
    ).toHaveAttribute('aria-current', 'page');
    await $('.project-group-toggle').click();
    await expect($('.project-group-toggle')).toHaveAttribute('aria-expanded', 'false');
    await $('[aria-label="Add project group"]').click();
    await expect($('[aria-label="New project group name"]')).toBeFocused();
    await browser.keys('Escape');
    await expect($('[aria-label="New project group name"]')).not.toExist();
    await expect($('[aria-label="Add project group"]')).toBeFocused();
    await $('[aria-label="Add project group"]').click();
    await $('[aria-label="New project group name"]').setValue('Personal');
    await $('[aria-label="Save project group"]').click();
    await expect($('[title="Personal"].project-group-toggle')).toBeDisplayed();
    await browser.refresh();
    await expect($('.project-group-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect($('[title="Personal"].project-group-toggle')).toBeDisplayed();
  });

  it('rejects a directory that is not a Git repository', async () => {
    const result = await browser.tauri.execute(async ({ core }, path) => {
      try {
        await core.invoke('validate_repository', { path });
        return 'accepted';
      } catch (cause) {
        return String(cause);
      }
    }, tmpdir());
    expect(result).toContain('not inside a Git repository');
  });

  it('keeps setup diagnostics in settings for a repository without the plugin', async () => {
    await $(
      `.project-default-worktree-select[title="${repository}"], .project-default-worktree-select[title="${realpathSync(repository)}"]`,
    ).click();
    const diagnostics = await openDiagnostics();
    try {
      await browser.waitUntil(
        async () => (await diagnostics.getText()).includes(realpathSync(repository)),
        { timeout: 20_000, timeoutMsg: 'App did not inspect the selected repository' },
      );
    } catch (cause) {
      console.error('Repository setup diagnostic', {
        savedDirectory: await browser.execute(() => localStorage.getItem('sai-directory')),
        setup: await $('.repository-diagnostics').getText(),
      });
      throw cause;
    }
    await browser.tauri.switchWindow('main');
    await expect($('.setup-panel')).not.toExist();
    await browser.tauri.switchWindow('settings');
    await expect(diagnostics).toHaveText(expect.stringContaining(realpathSync(repository)));
    await expect(diagnostics).toHaveText(expect.stringContaining('Plan-review plugin: not loaded'));
    await expect(diagnostics).toHaveText(
      expect.stringContaining('github:smykla-skalski/opencode-plugin-plan-review'),
    );
    await returnToWorkspace();
    await expect($('[aria-label="New plan"]')).toBeEnabled();
    if ((await $('.topbar-actions').getText()).includes('Ready'))
      await expect($('.composer textarea')).toBeEnabled();
    else await expect($('.composer textarea')).not.toExist();
  });

  it('creates and opens a worktree in the Sail workspace', async () => {
    const name = 'sidebar-task';
    const repositoryName = realpathSync(repository).split('/').at(-1);
    await $(`[aria-label="Create worktree for ${repositoryName}"]`).click();
    await expect($('.worktree-dialog')).toBeDisplayed();
    await expect($('.worktree-dialog')).toHaveAttribute('open');
    await expect($('.worktree-dialog')).toHaveText(expect.stringContaining(repositoryName!));
    await $('.worktree-dialog .worktree-cancel').click();
    await expect($('.worktree-dialog')).not.toBeDisplayed();
    await $(`[aria-label="Create worktree for ${repositoryName}"]`).click();
    await $(`[aria-label="Worktree name for ${repositoryName}"]`).setValue(name);
    await $('.worktree-form button[type="submit"]').click();
    try {
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => localStorage.getItem('sai-directory')))?.endsWith(
            `/${name}`,
          ) ?? false,
        { timeout: 15_000, timeoutMsg: 'New worktree did not open' },
      );
    } catch (cause) {
      console.error('Worktree creation diagnostic', {
        form: await $('.worktree-form').getText(),
        sidebar: await $('.sidebar').getText(),
        gitWorktrees: execFileSync('git', ['-C', repository, 'worktree', 'list'], {
          encoding: 'utf8',
        }),
      });
      throw cause;
    }
    const worktree = await browser.execute(() => localStorage.getItem('sai-directory'));
    await expect($('.worktree-dialog')).not.toBeDisplayed();
    expect(worktree).toContain(realpathSync(process.env.SAIL_WORKTREE_ROOT!));
    expect(
      execFileSync('git', ['-C', worktree!, 'branch', '--show-current'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(name);
    await browser.refresh();
    await expect($(`.project-worktree-select[title="${worktree}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(await openDiagnostics()).toHaveText(
      expect.stringContaining('Plan-review plugin: not loaded'),
    );
    await returnToWorkspace();
  });

  it('creates a worktree from an explicitly selected base branch', async () => {
    execFileSync('git', ['-C', repository, 'branch', 'develop']);
    const baseCommit = execFileSync('git', ['-C', repository, 'rev-parse', 'develop'], {
      encoding: 'utf8',
    }).trim();
    const created = await browser.tauri.execute(async ({ core }, path) => {
      return core.invoke<{ path: string; base: string }>('create_worktree', {
        repository: path,
        name: 'from-develop',
        destinationParent: null,
        baseRef: 'develop',
      });
    }, repository);
    expect(created.base).toBe('develop');
    expect(
      execFileSync('git', ['-C', created.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe(baseCommit);
  });

  it('deletes a worktree from its right-click menu and confirms force deletion', async () => {
    const worktree = await browser.execute(() => localStorage.getItem('sai-directory'));
    if (!worktree) throw new Error('Expected the created worktree to remain selected');
    const row = $(`.project-worktree-select[title="${worktree}"]`);
    const deleteMenuItem = '[aria-label="Delete worktree sidebar-task"]';

    await row.click({ button: 'right' });
    try {
      await expect($('.worktree-menu')).toBeDisplayed();
    } catch (cause) {
      console.error('Worktree context menu diagnostic', {
        sidebar: await $('.sidebar').getText(),
        row: await row.getHTML(),
        menus: await browser.execute(() =>
          [...document.querySelectorAll('.worktree-menu')].map((menu) => menu.outerHTML),
        ),
      });
      throw cause;
    }
    await browser.execute(() => sessionStorage.setItem('sai-e2e-delete-worktree', 'No'));
    await $(deleteMenuItem).click();
    await expect($('.worktree-menu')).not.toExist();
    await expect(row).toBeDisplayed();

    const dirty = join(worktree, 'keep-me.txt');
    writeFileSync(dirty, 'unsaved work\n');
    await row.click({ button: 'right' });
    await expect($('.worktree-menu')).toBeDisplayed();
    await browser.execute(() => sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes'));
    await $(deleteMenuItem).click();
    await expect($('.app-shell [role="alert"]')).toHaveText(
      expect.stringContaining('Cannot delete worktree'),
    );
    expect(existsSync(dirty)).toBe(true);
    await expect(row).toHaveAttribute('aria-current', 'page');

    rmSync(dirty);
    const ignored = join(worktree, 'ignored-secret.txt');
    writeFileSync(join(repository, '.git', 'info', 'exclude'), 'ignored-secret.txt\n');
    writeFileSync(ignored, 'local secret\n');
    await row.click({ button: 'right' });
    await browser.execute(() => sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes'));
    await $(deleteMenuItem).click();
    await expect($('.confirmation-dialog')).toHaveText(
      expect.stringContaining('permanently removes uncommitted and ignored files'),
    );
    await expect($('.app-shell > .notice.error')).not.toExist();
    expect(existsSync(ignored)).toBe(true);
    await expect(row).toHaveAttribute('aria-current', 'page');

    await $('.confirmation-dialog button:first-child').click();
    expect(existsSync(ignored)).toBe(true);
    await expect(row).toBeDisplayed();

    await row.click({ button: 'right' });
    await browser.execute(() => sessionStorage.setItem('sai-e2e-delete-worktree', 'Yes'));
    await $(deleteMenuItem).click();
    await expect($('.confirmation-dialog')).toBeDisplayed();
    await $('.confirmation-dialog .confirmation-primary').click();
    await expect(row).not.toExist();
    expect(existsSync(worktree)).toBe(false);
    expect(
      execFileSync('git', ['-C', repository, 'worktree', 'list'], { encoding: 'utf8' }),
    ).not.toContain(worktree);
  });

  it('opens the selected agent in a newly created worktree', async () => {
    const path = realpathSync(repository);
    await $(`.project-default-worktree-select[title="${path}"]`).click();
    const name = path.split('/').at(-1);
    await $(`[aria-label="Create worktree for ${name}"]`).click();
    await $(`[aria-label="Worktree name for ${name}"]`).setValue('agent-launch');
    await browser.execute(() =>
      document
        .querySelector<HTMLInputElement>('.worktree-agent-option input[value="claude"]')
        ?.focus(),
    );
    await browser.keys('Space');
    await expect($('.worktree-agent-option input[value="claude"]')).toBeSelected();
    await $('.worktree-form button[type="submit"]').click();
    await expect($('.worktree-dialog')).not.toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    const worktree = await browser.execute(() => localStorage.getItem('sai-directory'));
    expect(worktree).toMatch(/\/agent-launch$/);
    await expect($(`.project-worktree-select[title="${worktree}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
    await $(`[aria-label="Create worktree for ${name}"]`).click();
    await expect($('.worktree-agent-option input[value="claude"]')).toBeSelected();
    await $('.worktree-dialog .worktree-cancel').click();
  });

  it('shows an actionable error for a saved invalid path', async () => {
    await browser.execute(
      (path) => localStorage.setItem('sai-directory', path),
      join(repository, 'gone'),
    );
    await browser.refresh();
    await expect($('.main-area > [role="alert"]')).toHaveText(
      'Repository path does not exist. Choose an existing directory.',
    );
    await expect($('.composer textarea')).not.toExist();
  });
});

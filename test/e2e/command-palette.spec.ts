import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const input = () => $('[aria-label="Search command palette"]');

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

async function openPalette() {
  await browser.waitUntil(async () => {
    await browser.execute(() => {
      if (!document.querySelector('.command-palette[open]'))
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
        );
    });
    return browser.execute(() => !!document.querySelector('.command-palette[open]'));
  });
}

async function searchAndEnter(query: string) {
  await input().setValue(query);
  await expect($('.palette-entry.active')).toBeDisplayed();
  await $('.palette-entry.active').click();
}

describe('command palette project flow', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-palette-repo-'));
  const worktreeParent = mkdtempSync(join(tmpdir(), 'sail-palette-worktree-'));
  const worktree = join(worktreeParent, 'feature');

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'test(fixture): create repository',
    ]);
    execFileSync('git', [
      '-C',
      repository,
      'worktree',
      'add',
      '-q',
      '-b',
      'palette-feature',
      worktree,
    ]);
  });

  after(() => {
    rmSync(worktreeParent, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  });

  it('opens a worktree session directly and shows the pane picker when empty', async () => {
    const repoPath = realpathSync(repository);
    const worktreePath = realpathSync(worktree);
    await browser.execute(
      (repo, branch) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem('sai-directory', repo);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repo],
            groups: [{ id: 'team', name: 'Team', collapsed: false, repositories: [repo] }],
            worktrees: { [repo]: [{ path: branch, branch: 'palette-feature' }] },
          }),
        );
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            {
              agent: 'claude',
              directory: branch,
              sessionId: 'old',
              title: 'Old thread',
              updated: Date.now() - 1000,
            },
            {
              agent: 'claude',
              directory: branch,
              sessionId: 'new',
              title: 'Newest thread',
              updated: Date.now(),
            },
          ]),
        );
        localStorage.setItem(
          'sai-pane-layouts',
          JSON.stringify({
            [branch]: {
              id: 'main',
              agent: 'claude',
              thread: {
                agent: 'claude',
                directory: branch,
                sessionId: 'new',
                title: 'Newest thread',
                updated: Date.now(),
              },
            },
          }),
        );
      },
      repoPath,
      worktreePath,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();

    await openPalette();
    await searchAndEnter('Newest thread');
    await expect($('.command-palette[open]')).not.toExist();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === worktreePath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Newest thread'));

    await openPalette();
    await capture('palette-projects');
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await expect($('.palette-path')).toHaveText(
      expect.stringContaining(repoPath.split('/').at(-1)!),
    );
    await expect($('[data-kind="new-worktree"]')).toBeDisplayed();
    await capture('palette-worktrees');
    await searchAndEnter('palette-feature');
    await expect($('.command-palette[open]')).not.toExist();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === worktreePath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Newest thread'));

    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await $('[data-kind="worktree"]').click();
    await browser.waitUntil(
      async () => (await browser.execute(() => localStorage.getItem('sai-directory'))) === repoPath,
    );
    await expect($('.pane-picker-intro h2')).toHaveText('What would you like to open?');
    await expect($('.pane-picker-choices')).toHaveText(expect.stringContaining('Agent'));

    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await searchAndEnter('palette-feature');
    await expect($('.command-palette[open]')).not.toExist();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Newest thread'));

    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await expect($('[data-kind="new-worktree"]')).toBeDisplayed();
    await browser.execute(() =>
      document
        .querySelector('[aria-label="Search command palette"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await expect($('.command-palette[open]')).not.toExist();
  });

  it('chooses an agent in the worktree popup and opens it after creation', async () => {
    const repoPath = realpathSync(repository);
    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await $('[data-kind="new-worktree"]').click();
    await expect($('.worktree-dialog[open]')).toBeDisplayed();
    await capture('palette-create-worktree');
    await expect($('.worktree-agent-picker')).toBeDisplayed();
    await $('.worktree-cancel').click();
    await expect($('.command-palette[open]')).toBeDisplayed();
    await expect($('[data-kind="new-worktree"]')).toBeDisplayed();
    await $('[data-kind="new-worktree"]').click();
    await expect($('.worktree-dialog[open]')).toBeDisplayed();
    await $('[aria-label^="Worktree name for"]').setValue('palette-created');
    await $('.worktree-agent-option:has(input[value="claude"])').click();
    await $('.worktree-create').click();
    await expect($('.worktree-dialog[open]')).not.toExist();
    await expect($('.command-palette[open]')).not.toExist();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await expect($('textarea[aria-label="Message Claude"]')).toBeDisplayed();
    await browser.waitUntil(async () =>
      (await browser.execute(() => localStorage.getItem('sai-directory')))?.includes(
        'palette-created',
      ),
    );
    const selected = await browser.execute(() => localStorage.getItem('sai-directory'));
    expect(selected).toContain('palette-created');
  });

  it('adds an agent choice pane when the worktree only has an unsent draft', async () => {
    const repoPath = realpathSync(repository);
    await browser.execute((repo) => {
      localStorage.setItem('sai-directory', repo);
      localStorage.setItem(
        'sai-pane-layouts',
        JSON.stringify({ [repo]: { id: 'main', agent: 'claude', thread: null } }),
      );
    }, repoPath);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();
    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await $('[data-kind="worktree"]').click();
    await expect($('.command-palette[open]')).not.toExist();
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeDisplayed();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 2);
  });

  it('focuses a saved session in a secondary pane', async () => {
    const repoPath = realpathSync(repository);
    await browser.execute((repo) => {
      localStorage.setItem('sai-directory', repo);
      localStorage.setItem(
        'sai-pane-layouts',
        JSON.stringify({
          [repo]: {
            id: 'split',
            direction: 'row',
            ratio: 0.5,
            first: { id: 'main', agent: null, thread: null },
            second: {
              id: 'saved-agent',
              agent: 'claude',
              thread: {
                agent: 'claude',
                directory: repo,
                sessionId: 'saved-secondary',
                title: 'Saved secondary thread',
                updated: Date.now(),
              },
            },
          },
        }),
      );
    }, repoPath);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();
    await openPalette();
    await searchAndEnter(repoPath.split('/').at(-1)!);
    await $('[data-kind="worktree"]').click();
    await expect($('.command-palette[open]')).not.toExist();
    await expect($('.pane-leaf.focused .agent-header')).toHaveText(
      expect.stringContaining('Saved secondary thread'),
    );
    expect((await $$('.pane-leaf')).length).toBe(2);
  });

  it('opens the full worktree popup with Cmd+N for the current project', async () => {
    await browser.keys(['Meta', 'n']);
    await expect($('.worktree-dialog[open]')).toBeDisplayed();
    await expect($('.command-palette[open]')).not.toExist();
    await expect($('.worktree-dialog')).toHaveText(
      expect.stringContaining(realpathSync(repository).split(/[\\/]/).at(-1)!),
    );
    await expect($('.worktree-agent-picker')).toBeDisplayed();
    await $('.worktree-cancel').click();
    await expect($('.worktree-dialog[open]')).not.toExist();
    await expect($('.command-palette[open]')).not.toExist();
  });
});

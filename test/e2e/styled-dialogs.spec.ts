import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('styled app dialogs', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sail-styled-dialogs-'));
  const first = join(fixture, 'first');
  const second = join(fixture, 'second');
  const worktree = join(fixture, 'linked');

  before(() => {
    mkdirSync(first);
    mkdirSync(second);
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', [
      '-C',
      first,
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
    execFileSync('git', ['-C', first, 'worktree', 'add', '-q', '-b', 'linked', worktree]);
    execFileSync('git', ['init', '-q', second]);
  });

  after(() => rmSync(fixture, { recursive: true, force: true }));

  it('chooses worktree folders and confirms destructive actions inside Sail', async () => {
    const root = realpathSync(first);
    const another = realpathSync(second);
    const linked = realpathSync(worktree);
    await browser.execute(
      (repository, secondRepository, linkedPath) => {
        sessionStorage.removeItem('sai-e2e-delete-worktree');
        localStorage.setItem('sai-directory', repository);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [repository, secondRepository],
            groups: [],
            worktrees: { [repository]: [{ path: linkedPath, branch: 'linked' }] },
          }),
        );
      },
      root,
      another,
      linked,
    );
    await browser.refresh();
    await expect($(`.project-default-worktree-select[title="${another}"]`)).toBeDisplayed();

    await $(`.project-worktree-select[title="${linked}"]`).click({ button: 'right' });
    await $('[aria-label="Delete worktree linked"]').click();
    try {
      await expect($('.confirmation-dialog')).toBeDisplayed();
    } catch (cause) {
      console.error(
        'Confirmation diagnostic',
        await browser.execute(() => ({
          dialog: document.querySelector('.confirmation-dialog')?.outerHTML,
          alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent),
          e2eAnswer: sessionStorage.getItem('sai-e2e-delete-worktree'),
          menu: document.querySelector('.worktree-menu')?.outerHTML,
          body: document.body.textContent?.slice(-1200),
        })),
      );
      throw cause;
    }
    await expect($('.confirmation-dialog')).toHaveText(expect.stringContaining('Delete worktree'));
    await $('.confirmation-dialog button:first-child').click();
    await expect($('.confirmation-dialog')).not.toBeDisplayed();
    expect(existsSync(linked)).toBe(true);

    await $('[aria-label="Create worktree for second"]').click();
    await $('.worktree-destination button').click();
    await expect($('.path-picker-dialog[open]')).toBeDisplayed();
    await $('.path-picker-dialog[open] [aria-label="Parent folder"]').click();
    await expect($('.path-picker-dialog[open] .path-picker-actions span')).toHaveText(
      realpathSync(fixture),
    );
    await $('.path-picker-dialog[open] .path-picker-actions .confirmation-primary').click();
    await expect($('.worktree-destination span')).toHaveText(realpathSync(fixture));
    await browser.execute(() =>
      document
        .querySelector<HTMLInputElement>('.worktree-agent-option input:not(:disabled)')
        ?.focus(),
    );
    await browser.keys('ArrowRight');
    const focusedAgent = $('.worktree-agent-option input:focus');
    await expect(focusedAgent).toBeSelected();
    expect(await focusedAgent.getValue()).not.toBe('');
    await expect($('.worktree-dialog')).toBeDisplayed();
  });
});

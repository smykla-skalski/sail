import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('composer task location', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-location-repository-'));
  const worktree = mkdtempSync(join(tmpdir(), 'sail-location-worktree-'));
  const branch = 'feature/مرحبا-日本語-location-that-must-truncate-at-compact-width';

  before(() => {
    execFileSync('git', ['init', '-q', '-b', 'main', repository]);
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
    rmSync(worktree, { recursive: true });
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', branch, worktree]);
  });

  after(() => {
    execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', worktree]);
    rmSync(repository, { recursive: true, force: true });
  });

  it('keeps real per-worktree context beside active and restored prompts', async () => {
    const repositoryPath = realpathSync(repository);
    const worktreePath = realpathSync(worktree);
    const repositoryName = repositoryPath.split('/').at(-1)!;
    await browser.execute(
      (path, child, childBranch) => {
        localStorage.setItem('sai-directory', path);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [path],
            groups: [],
            worktrees: { [path]: [{ path: child, branch: childBranch }] },
          }),
        );
      },
      repositoryPath,
      worktreePath,
      branch,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeDisplayed();
    await $('.agent-launches button').click();
    await expect($('.agent-composer .task-location')).toHaveAttribute(
      'aria-label',
      `Task location: ${repositoryName}, branch main`,
    );

    await browser.keys(['Meta', 'd']);
    await browser.keys('a');
    await browser.keys('Enter');
    await browser.waitUntil(async () => (await $$('.pane-leaf .task-location')).length === 2);
    const splitLabels = await $$('.pane-leaf .task-location').map((element) =>
      element.getAttribute('aria-label'),
    );
    expect(splitLabels).toEqual([
      `Task location: ${repositoryName}, branch main`,
      `Task location: ${repositoryName}, branch main`,
    ]);

    await browser.refresh();
    await browser.waitUntil(async () => (await $$('.pane-leaf .task-location')).length === 2);
    const restoredLabels = await $$('.pane-leaf .task-location').map((element) =>
      element.getAttribute('aria-label'),
    );
    expect(restoredLabels).toEqual(splitLabels);

    await $(`.project-worktree-select[title="${worktreePath}"]`).click();
    await expect($('.agent-launches button')).toBeDisplayed();
    await $('.agent-launches button').click();
    await expect($('.agent-composer .task-location')).toHaveAttribute(
      'aria-label',
      `Task location: ${repositoryName}, branch ${branch}`,
    );

    await browser.setWindowSize(320, 500);
    const compact = await browser.execute(() => {
      const location = document.querySelector<HTMLElement>('.agent-composer .task-location')!;
      const branchLabel = location.querySelector<HTMLElement>('.task-location-branch')!;
      const agent = document.querySelector<HTMLElement>('.agent-header .agent-heading')!;
      const prompt = document.querySelector<HTMLTextAreaElement>('.agent-composer textarea')!;
      return {
        locationRight: location.getBoundingClientRect().right,
        viewport: innerWidth,
        branchOverflow: branchLabel.scrollWidth > branchLabel.clientWidth,
        agentVisible: agent.getBoundingClientRect().height > 0,
        promptEnabled: !prompt.disabled,
      };
    });
    expect(compact.locationRight).toBeLessThanOrEqual(compact.viewport + 1);
    expect(compact.branchOverflow).toBe(true);
    expect(compact.agentVisible).toBe(true);
    expect(compact.promptEnabled).toBe(true);

    execFileSync('git', ['-C', worktreePath, 'checkout', '--detach', '-q']);
    await browser.refresh();
    await expect($('.agent-composer .task-location')).toHaveAttribute(
      'aria-label',
      `Task location: ${repositoryName}, unknown branch or worktree`,
    );
    await expect($('.agent-composer textarea')).toBeEnabled();

    await $('.mobile-switcher button:nth-child(1)').click();
    await $(`.project-default-worktree-select[title="${repositoryPath}"]`).click();
    await $('.mobile-switcher button:nth-child(2)').click();
    await browser.waitUntil(async () => {
      const state = await browser.execute((staleBranch) => {
        const prompt = document.querySelector<HTMLTextAreaElement>('[data-pane-prompt]');
        const label = document
          .querySelector<HTMLElement>('.task-location')
          ?.getAttribute('aria-label');
        return !!prompt && !prompt.disabled && !!label && !label.includes(staleBranch);
      }, branch);
      return state;
    });
    await expect($('.task-location')).toHaveAttribute(
      'aria-label',
      `Task location: ${repositoryName}, branch main`,
    );
  });
});

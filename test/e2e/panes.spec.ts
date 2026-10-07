import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topbarMenuTrigger } from './topbar';

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

// OpenCode is a choice only when its model is set up, so count the enabled agents.
const enabledChoices = '.pane-leaf.focused [data-agent-choice]:not([disabled])';

async function lastEnabledChoice() {
  const choices = await $$(enabledChoices);
  return choices[choices.length - 1];
}

async function topbarLayout() {
  return browser.execute(() => {
    const topbar = document.querySelector<HTMLElement>('.topbar')!;
    const actions = document.querySelector<HTMLElement>('.topbar-actions')!;
    const actionsBox = actions.getBoundingClientRect();
    const breadcrumb = document.querySelector('.breadcrumb')!.getBoundingClientRect();
    const controls = [...actions.querySelectorAll('.topbar-actions > button, .menu-trigger')].map(
      (control) => control.getBoundingClientRect(),
    );
    return {
      viewport: innerWidth,
      topbarWidth: topbar.clientWidth,
      topbarOverflow: topbar.scrollWidth - topbar.clientWidth,
      actionsOverflow: actions.scrollWidth - actions.clientWidth,
      actionsLeft: actionsBox.left,
      actionsRight: actionsBox.right,
      breadcrumbRight: breadcrumb.right,
      breadcrumbItemsRight: Math.max(
        ...[...document.querySelectorAll('.breadcrumb > *')].map(
          (item) => item.getBoundingClientRect().right,
        ),
      ),
      controlCount: controls.length,
      clippedControls: controls.filter(
        (control) =>
          control.width === 0 ||
          control.left < actionsBox.left - 1 ||
          control.right > actionsBox.right + 1,
      ).length,
    };
  });
}

function expectTopbarFits(layout: Awaited<ReturnType<typeof topbarLayout>>) {
  expect(Math.abs(layout.viewport - 1280)).toBeLessThanOrEqual(2);
  expect(layout.topbarOverflow).toBeLessThanOrEqual(1);
  expect(layout.actionsOverflow).toBeLessThanOrEqual(1);
  expect(layout.actionsRight).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.breadcrumbRight).toBeLessThanOrEqual(layout.actionsLeft);
  expect(layout.breadcrumbItemsRight).toBeLessThanOrEqual(layout.breadcrumbRight + 1);
  expect(layout.controlCount).toBe(4);
  expect(layout.clippedControls).toBe(0);
}

describe('split agent panes', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-panes-e2e-'));
  const worktree = mkdtempSync(join(tmpdir(), 'sail-panes-worktree-e2e-'));

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
    rmSync(worktree, { recursive: true });
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'pane-test', worktree]);
  });
  after(() => {
    execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', worktree]);
    rmSync(repository, { recursive: true, force: true });
  });

  it('keeps the topbar inside the window at 1280 px with two panes and details open', async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sai-pane-layouts');
      localStorage.removeItem('sail-agent-threads');
    }, realpathSync(repository));
    await browser.refresh();
    await expect(topbarMenuTrigger('New agent')).toBeDisplayed();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await browser.keys(['Meta', 'd']);
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 2);
    expectTopbarFits(await topbarLayout());

    await browser.execute(() =>
      document.querySelector<HTMLElement>('.pane-leaf[data-pane-id="main"] textarea')?.focus(),
    );
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await expect($('.app-shell')).toHaveAttribute('data-details-visible', 'true');
    const withDetails = await topbarLayout();
    expect(withDetails.topbarWidth).toBeLessThan(760);
    expectTopbarFits(withDetails);

    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await expect($('.app-shell')).toHaveAttribute('data-details-visible', 'false');
    await $('button[aria-label="Close pane"]').click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 1);
  });

  it('splits in both directions, restores the worktree layout, and closes panes', async () => {
    await browser.execute(
      (path, worktreePath) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.setItem('sai-directory', path);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [path],
            groups: [],
            worktrees: { [path]: [{ path: worktreePath, branch: 'pane-test' }] },
          }),
        );
      },
      realpathSync(repository),
      realpathSync(worktree),
    );
    await browser.refresh();
    await expect(topbarMenuTrigger('New agent')).toBeDisplayed();
    await $('.agent-launches button').click();
    await browser.keys(['Meta', 'd']);
    await expect($('.pane-split.row')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(2);
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeFocused();
    await browser.execute(() => document.querySelector<HTMLElement>('.sidebar')?.focus());
    await browser.keys('a');
    await expect($(enabledChoices)).toBeFocused();
    await browser.keys('ArrowDown');
    await expect(await lastEnabledChoice()).toBeFocused();
    await browser.keys('ArrowUp');
    await expect($(enabledChoices)).toBeFocused();
    await browser.keys('Escape');
    await browser.execute(() => {
      const target = document.activeElement!;
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }),
      );
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    await expect(await lastEnabledChoice()).toBeFocused();
    await browser.keys('ArrowUp');
    await expect($(enabledChoices)).toBeFocused();
    await $('.pane-leaf.focused .pane-picker-intro h2').click();
    await browser.keys('ArrowDown');
    await expect(await lastEnabledChoice()).toBeFocused();
    await browser.keys('ArrowUp');
    await expect($(enabledChoices)).toBeFocused();
    await browser.execute(() => document.querySelector<HTMLElement>('.sidebar')?.focus());
    await browser.keys('ArrowUp');
    await expect(await lastEnabledChoice()).toBeFocused();
    await browser.keys('ArrowDown');
    await expect($(enabledChoices)).toBeFocused();
    await browser.keys('Enter');
    await expect($('.pane-leaf.focused textarea[data-pane-prompt]')).toBeFocused();
    const header = await browser.execute(() => {
      const actions = document.querySelector<HTMLElement>('.topbar-actions')!;
      return {
        right: actions.getBoundingClientRect().right,
        scrollWidth: actions.scrollWidth,
        clientWidth: actions.clientWidth,
        viewport: innerWidth,
      };
    });
    expect(header.right).toBeLessThanOrEqual(header.viewport + 1);
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    await capture('desktop-agent-two-panes');
    await $('.pane-divider').click();
    await browser.keys('ArrowRight');
    const ratio = await browser.execute((path) => {
      const layouts = JSON.parse(localStorage.getItem('sai-pane-layouts') ?? '{}');
      return layouts[path]?.ratio;
    }, realpathSync(repository));
    expect(ratio).toBeGreaterThan(0.5);
    await browser.keys(['Meta', 'Shift', 'd']);
    await expect($('.pane-split.column')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(3);
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeFocused();
    await browser.keys('a');
    await browser.keys('Enter');
    await capture('desktop-agent-three-panes');
    const focusedBefore = await $('.pane-leaf.focused').getAttribute('data-pane-id');
    await browser.keys('F6');
    const focusedAfter = await $('.pane-leaf.focused').getAttribute('data-pane-id');
    expect(focusedAfter).not.toBe(focusedBefore);
    await expect($('.pane-leaf.focused textarea[data-pane-prompt]')).toBeFocused();

    await browser.refresh();
    await expect($('.pane-split.column')).toBeDisplayed();
    expect((await $$('.pane-leaf')).length).toBe(3);
    await capture('desktop-agent-restored-panes');
    await $(`.project-worktree-select[title="${realpathSync(worktree)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 1);
    await expect(topbarMenuTrigger('New agent')).toBeDisplayed();
    await $('.agent-launches button').click();
    await browser.keys(['Meta', 'd']);
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 2);
    await $(`.project-default-worktree-select[title="${realpathSync(repository)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 3);
    await $(`.project-worktree-select[title="${realpathSync(worktree)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 2);
    await $(`.project-default-worktree-select[title="${realpathSync(repository)}"]`).click();
    await browser.waitUntil(async () => (await $$('.pane-leaf')).length === 3);
    await $('button[aria-label="Close pane"]').click();
    expect((await $$('.pane-leaf')).length).toBe(2);
    await $('button[aria-label="Close pane"]').click();
    expect((await $$('.pane-leaf')).length).toBe(1);
    await expect($('.workspace')).toBeDisplayed();

    await browser.keys(['Meta', 'd']);
    await $('button[aria-label="Close main pane"]').click();
    await $('button[aria-label="Close pane"]').click();
    await browser.refresh();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Parent memory');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Parent memory'),
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const savedLayout = await browser.execute(() => localStorage.getItem('sai-pane-layouts'));
    const savedThreads = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    await browser.keys(['Meta', 'Shift', 'j']);
    await expect($('[aria-label="Side chat pane"]')).toBeDisplayed();
    await expect($('[aria-label="Side chat pane"] [data-pane-prompt]')).toBeFocused();
    expect(await browser.execute(() => localStorage.getItem('sai-pane-layouts'))).toBe(savedLayout);
    expect(await browser.execute(() => localStorage.getItem('sail-agent-threads'))).toBe(
      savedThreads,
    );
    await browser.keys(['Meta', 'w']);
    await expect($('[aria-label="Side chat pane"]')).not.toExist();
    await expect($('.agent-composer textarea')).toBeFocused();
    await browser.refresh();
    await expect($('[aria-label="Side chat pane"]')).not.toExist();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Parent memory'),
    );
    await browser.keys(['Meta', 'w']);
    await expect($('.agent-header')).not.toExist();
    await expect($('.workspace')).toBeDisplayed();
  });
});

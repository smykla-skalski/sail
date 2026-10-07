import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSettings, returnToWorkspace } from './settings-window';

const waitForComposer = () =>
  browser.waitUntil(
    () =>
      browser.execute(() =>
        Boolean(document.querySelector('.agent-composer textarea:not([disabled])')),
      ),
    { timeout: 15000, timeoutMsg: 'Agent composer did not become ready' },
  );

describe('agent thread attention', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-attention-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('tracks hidden permissions and completion until a thread is opened', async () => {
    await browser.execute((path) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-thread-attention');
      localStorage.removeItem('sai-collapsed-agent-worktrees');
      localStorage.removeItem('sai-pane-layouts');
      localStorage.setItem('sai-notifications-enabled', 'false');
      localStorage.setItem('sai-notification-sound', 'true');
    }, realpathSync(repository));
    await browser.refresh();
    await browser.waitUntil(
      () =>
        browser.execute(
          (name) => document.querySelector('.breadcrumb-project')?.textContent?.includes(name),
          repository.split('/').at(-1) ?? '',
        ),
      { timeout: 15000, timeoutMsg: 'Test repository did not load' },
    );
    await expect($('.agent-launches button')).toBeEnabled();

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button').click();
    const row = $('.session-item[title="Delayed approval"]');
    await expect(row).toBeDisplayed();
    await $('.agent-launches button').click();
    await expect(row).toHaveText(expect.stringContaining('Waiting for input'));
    const sidebarRow = $('.project-agent-row[aria-label*="Delayed approval"]');
    await expect(sidebarRow).toHaveText(expect.stringContaining('Needs input'));
    const worktree = $('.project-default-worktree-select');
    await expect(worktree).toHaveAttribute('aria-expanded', 'true');
    await worktree.click();
    await expect(worktree).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebarRow).not.toBeDisplayed();
    await browser.refresh();
    await expect(worktree).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebarRow).not.toBeDisplayed();
    await worktree.click();
    await expect(sidebarRow).toHaveText(expect.stringContaining('Needs input'));
    await expect(row.$('.thread-unread')).toBeDisplayed();
    await browser.refresh();
    await expect(row).toHaveText(expect.stringContaining('Waiting for input'));
    await expect(sidebarRow).toHaveText(expect.stringContaining('Needs input'));
    await expect(row.$('.thread-unread')).toBeDisplayed();

    await sidebarRow.click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect($('.agent-header .activity-status')).toHaveAttribute('data-state', 'waiting');
    await expect($('.agent-header .activity-status')).toHaveText(
      expect.stringContaining('Needs input'),
    );
    await expect(row.$('.thread-unread')).not.toExist();
    await $('.agent-permission button').click();
    await expect(row).toHaveText(expect.stringContaining('done'));
    await expect(sidebarRow).toHaveText(expect.stringContaining('Completed'));
    if (!(await browser.execute(() => document.hasFocus()))) {
      await expect(row.$('.thread-unread')).toBeDisplayed();
      await row.click();
    }
    await expect(row.$('.thread-unread')).not.toExist();

    await waitForComposer();
    await $('.agent-composer textarea').setValue('Delayed completion');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await $('.agent-launches button').click();
    await expect(row).toHaveText(expect.stringContaining('done'));
    await expect(row.$('.thread-unread')).toBeDisplayed();
    await row.click();
    await expect(row.$('.thread-unread')).not.toExist();

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer textarea').setValue('Slow cancel');
    await $('.agent-actions button').click();
    const cancelled = $('.session-item[title="Slow cancel"]');
    await expect($('.agent-permission')).toBeDisplayed();
    await browser.refresh();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect($('.agent-busy button')).toBeDisplayed();
    await $('.agent-busy button').click();
    await $('.agent-launches button').click();
    await expect(cancelled).toHaveText(expect.stringContaining('done'));
    await expect(cancelled.$('.thread-unread')).not.toExist();
    const cancelledSidebar = $('.project-agent-row[aria-label*="Slow cancel"]');
    await expect(cancelledSidebar.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );

    await waitForComposer();
    await $('.agent-composer textarea').setValue('Cancel ignored');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-busy button').click();
    await $('.agent-launches button').click();
    const completedAfterCancel = $('.project-agent-row[aria-label*="Cancel ignored"]');
    await expect(completedAfterCancel.$('.activity-status')).toHaveAttribute('data-state', 'done');
    await expect(completedAfterCancel).toHaveText(expect.stringContaining('Completed'));

    await waitForComposer();
    await $('.agent-composer textarea').setValue('Agent interrupted');
    await $('.agent-actions button').click();
    const agentInterrupted = $('.project-agent-row[aria-label*="Agent interrupted"]');
    await expect(agentInterrupted.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(agentInterrupted).toHaveText(expect.stringContaining('Interrupted'));
    const interruptedColor = await browser.execute(() => {
      const status = document.querySelector(
        '.project-agent-row[aria-label*="Agent interrupted"] .activity-status',
      );
      const reference = document.createElement('span');
      reference.style.color = 'var(--activity-failed)';
      document.body.append(reference);
      const colors = [getComputedStyle(status!).color, getComputedStyle(reference).color];
      reference.remove();
      return colors;
    });
    expect(interruptedColor[0]).toBe(interruptedColor[1]);
    await browser.refresh();
    await expect(agentInterrupted.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );

    await waitForComposer();
    await $('.agent-composer textarea').setValue('Agent text interrupted');
    await $('.agent-actions button').click();
    await $('.agent-launches button').click();
    const textInterrupted = $('.project-agent-row[aria-label*="Agent text interrupted"]');
    await expect(textInterrupted.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(textInterrupted).toHaveText(expect.stringContaining('Interrupted'));

    await waitForComposer();
    await $('.agent-composer textarea').setValue('Discuss interruption');
    await $('.agent-actions button').click();
    await $('.agent-launches button').click();
    const discussed = $('.project-agent-row[aria-label*="Discuss interruption"]');
    await expect(discussed.$('.activity-status')).toHaveAttribute('data-state', 'done');
    await expect(discussed).toHaveText(expect.stringContaining('Completed'));

    await openSettings();
    await $('.settings-navigation button:nth-of-type(3)').click();
    const options = await $$('.attention-setting input');
    await options[0].click();
    await expect(options[1]).toBeEnabled();
    await options[1].click();
    await returnToWorkspace();
    expect(await browser.execute(() => localStorage.getItem('sai-notifications-enabled'))).toBe(
      'true',
    );
    expect(await browser.execute(() => localStorage.getItem('sai-notification-sound'))).toBe(
      'false',
    );
  });
});

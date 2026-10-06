import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent status bar', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-agent-status-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('summarizes active agents and opens their details', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-thread-attention');
      localStorage.removeItem('sai-pane-layouts');
    }, realpathSync(repository));
    await browser.refresh();

    const bar = $('.agent-status-bar');
    await expect(bar).toHaveText(expect.stringContaining('No agents running'));
    const idleLayout = await browser.execute(() => {
      const status = document.querySelector('.agent-status-bar')!.getBoundingClientRect();
      const shell = document.querySelector('.app-shell')!.getBoundingClientRect();
      return { height: status.height, left: status.left, right: status.right, shell: shell.width };
    });
    expect(idleLayout).toEqual({
      height: 32,
      left: 0,
      right: idleLayout.shell,
      shell: idleLayout.shell,
    });
    await $('.agent-launches button').click();
    await expect($('.agent-composer textarea')).toBeEnabled();
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect(bar).toHaveText(expect.stringContaining('1 need input'));

    await $('.agent-status-summary').click();
    const details = $('.agent-status-popover');
    await expect(details).toBeDisplayed();
    await expect(details).toHaveText(expect.stringContaining('Delayed approval'));
    await expect(details).toHaveText(expect.stringContaining('Needs input'));
    const popoverLayout = await browser.execute(() => {
      const bounds = document.querySelector('.agent-status-popover')!.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: innerWidth };
    });
    expect(popoverLayout.left).toBeGreaterThanOrEqual(0);
    expect(popoverLayout.right).toBeLessThanOrEqual(popoverLayout.width);

    await browser.keys('Escape');
    await expect(details).not.toExist();
    await $('.agent-status-summary').click();
    await $('.topbar').click();
    await expect(details).not.toExist();
    await $('.agent-status-summary').click();
    await $('.agent-status-row').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect(details).not.toExist();

    await browser.setWindowSize(700, 700);
    await $('.sidebar-toggle').click();
    const mobileLayout = await browser.execute(() => {
      const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
      const status = document.querySelector('.agent-status-bar')!.getBoundingClientRect();
      return { sidebarBottom: sidebar.bottom, statusTop: status.top };
    });
    expect(mobileLayout.sidebarBottom).toBeLessThanOrEqual(mobileLayout.statusTop);
  });
});

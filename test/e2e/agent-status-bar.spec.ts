import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function secondaryColors() {
  return browser.execute(() =>
    [...document.querySelectorAll('.sui-button[data-variant="secondary"]')].map((button) => {
      const style = getComputedStyle(button);
      return `${button.textContent?.trim()}: ${style.backgroundColor} ${style.color}`;
    }),
  );
}

const sendButton = "//*[contains(@class,'agent-actions')]//button[contains(.,'Send')]";

/** Samples the painted thread header and status bar on every animation frame and every 10 ms,
 * and records any frame where they disagree about the one running thread. */
function startStatusSampler() {
  return browser.execute(() => {
    const previous: unknown = Reflect.get(window, 'sailStatusStop');
    if (typeof previous === 'function') previous();
    const mismatches: string[] = [];
    const sample = () => {
      const header = document.querySelector('.agent-header .activity-status')?.textContent ?? '';
      const summary = document.querySelector('.agent-status-summary')?.textContent ?? '';
      const headerState = header.includes('Needs input')
        ? 'waiting'
        : header.includes('Working')
          ? 'working'
          : header.includes('Ready')
            ? 'ready'
            : null;
      const summaryState = summary.includes('need attention')
        ? 'waiting'
        : summary.includes('working')
          ? 'working'
          : 'ready';
      if (headerState && headerState !== summaryState)
        mismatches.push(`${header.trim()} || ${summary.replace(/\s+/g, ' ').trim()}`);
    };
    let stopped = false;
    const frame = () => {
      if (stopped) return;
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const timer = setInterval(() => requestAnimationFrame(sample), 10);
    Reflect.set(window, 'sailStatusMismatches', mismatches);
    Reflect.set(window, 'sailStatusStop', () => {
      stopped = true;
      clearInterval(timer);
    });
  });
}

function statusMismatches(): Promise<string[]> {
  return browser.execute(() => {
    const stop: unknown = Reflect.get(window, 'sailStatusStop');
    if (typeof stop === 'function') stop();
    const mismatches: unknown = Reflect.get(window, 'sailStatusMismatches');
    return Array.isArray(mismatches) ? mismatches.map(String) : ['sampler missing'];
  });
}

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
    await expect($('.agent-composer [data-pane-prompt]')).toBeEnabled();
    await $('.agent-composer [data-pane-prompt]').setValue('Delayed approval');
    await startStatusSampler();
    await $(sendButton).click();
    // The first session of a fresh app can take a while to start the agent.
    await expect($('.agent-permission')).toBeDisplayed({ wait: 45_000 });
    await expect(bar).toHaveText(expect.stringContaining('1 need attention'));
    expect(await statusMismatches()).toEqual([]);

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

    await browser.execute(() => (document.documentElement.dataset.suiTheme = 'dark'));
    await browser.waitUntil(
      async () => {
        const colors = await secondaryColors();
        return (
          colors.length >= 2 &&
          colors.every((color) => color.endsWith('rgb(21, 26, 33) rgb(243, 246, 247)'))
        );
      },
      { timeout: 5000, timeoutMsg: 'Dark secondary buttons kept light-theme colors' },
    );
    await browser.execute(() => (document.documentElement.dataset.suiTheme = 'light'));

    await browser.keys('Escape');
    await expect(details).not.toExist();
    await expect($('.agent-status-summary')).toBeFocused();
    await $('.agent-status-summary').click();
    await $('.topbar').click();
    await expect(details).not.toExist();
    await $('.agent-status-summary').click();
    await $('.agent-status-row').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect(details).not.toExist();

    await startStatusSampler();
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Delayed approval'),
    );
    await expect($('.agent-header .activity-status')).toHaveText(expect.stringContaining('Ready'));
    await browser.pause(300);
    expect(await statusMismatches()).toEqual([]);

    await startStatusSampler();
    await $('.agent-composer [data-pane-prompt]').setValue('Delayed approval');
    await $(sendButton).click();
    await expect($('.agent-header .activity-status')).toHaveText(
      expect.stringContaining('Working'),
    );
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await expect($('.agent-header .activity-status')).toHaveText(expect.stringContaining('Ready'));
    await browser.pause(300);
    expect(await statusMismatches()).toEqual([]);

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

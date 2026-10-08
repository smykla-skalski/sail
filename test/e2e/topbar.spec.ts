import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTopbarMenu, topbarMenuTrigger } from './topbar';

describe('workspace topbar', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-topbar-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('opens agent launches and workspace actions from keyboard menus', async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-pane-layouts');
    }, realpathSync(repository));
    await browser.refresh();

    const newAgent = topbarMenuTrigger('New agent');
    const launches = $('[role="menu"][aria-label="New agent"]');
    await expect(newAgent).toBeDisplayed();
    await expect($('.agent-header .activity-status')).toBeDisplayed();
    const idle = await browser.execute(() => ({
      header: document.querySelector('.agent-header .activity-status')?.textContent ?? '',
      bar: document.querySelector('.agent-status-summary')?.textContent ?? '',
    }));
    if (idle.bar.includes('No agents running'))
      expect(idle.header).not.toMatch(/Working|Needs input/);
    await expect(newAgent).toHaveAttribute('aria-haspopup', 'menu');
    await expect(newAgent).toHaveAttribute('aria-expanded', 'false');
    await expect(launches).not.toBeDisplayed();
    await expect($('.agent-launches button')).toBeEnabled();

    await newAgent.click();
    await expect(launches).toBeDisplayed();
    await expect(newAgent).toHaveAttribute('aria-expanded', 'true');
    await expect($('.agent-launches button:first-child')).toBeFocused();
    await browser.keys('ArrowDown');
    await expect($('.agent-launches button:nth-child(2)')).toBeFocused();
    await browser.keys('ArrowUp');
    await expect($('.agent-launches button:first-child')).toBeFocused();
    await browser.keys('ArrowUp');
    expect(
      await browser.execute(() => {
        const active = document.activeElement;
        return (
          !!active?.closest('[role="menu"][aria-label="New agent"]') &&
          active !== document.querySelector('.agent-launches button:first-child')
        );
      }),
    ).toBe(true);
    await browser.keys('Escape');
    await expect(launches).not.toBeDisplayed();
    await expect(newAgent).toBeFocused();
    await expect(newAgent).toHaveAttribute('aria-expanded', 'false');

    await browser.keys('ArrowDown');
    await expect(launches).toBeDisplayed();
    await expect($('.agent-launches button:first-child')).toBeFocused();
    await $('.agent-launches button:first-child').click();
    await expect(launches).not.toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Claude'));

    const more = await openTopbarMenu('More actions');
    const actions = await more.getText();
    const placement = await browser.execute(() => {
      const trigger = document
        .querySelector('.topbar button[aria-label="More actions"]')!
        .getBoundingClientRect();
      const popup = document
        .querySelector('[role="menu"][aria-label="More actions"]')!
        .getBoundingClientRect();
      return { trigger: trigger.toJSON(), popup: popup.toJSON(), width: innerWidth };
    });
    expect(Math.abs(placement.popup.right - placement.trigger.right)).toBeLessThanOrEqual(1);
    expect(placement.popup.top).toBeGreaterThanOrEqual(placement.trigger.bottom);
    expect(placement.popup.top - placement.trigger.bottom).toBeLessThanOrEqual(6);
    expect(placement.popup.left).toBeGreaterThanOrEqual(8);
    expect(placement.popup.right).toBeLessThanOrEqual(placement.width - 8);
    for (const label of ['Task overview', 'Switch thread', 'Commands', 'Agent browser'])
      expect(actions).toContain(label);
    const browserAccess = more.$('[role="menuitemcheckbox"]');
    const before = await browserAccess.getAttribute('aria-checked');
    await browserAccess.click();
    await expect(more).not.toBeDisplayed();
    await openTopbarMenu('More actions');
    await expect(browserAccess).toHaveAttribute(
      'aria-checked',
      before === 'true' ? 'false' : 'true',
    );
    await browserAccess.click();
    await openTopbarMenu('More actions');
    await expect(browserAccess).toHaveAttribute('aria-checked', before);

    await $('.topbar').click();
    await expect(more).not.toBeDisplayed();

    await openTopbarMenu('More actions');
    await more.$('.agent-menu-launch').click();
    await expect($('.command-palette')).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.command-palette')).not.toBeDisplayed();
    await expect(topbarMenuTrigger('More actions')).toBeFocused();
    await openTopbarMenu('More actions');
    await openTopbarMenu('New agent');
    await expect(more).not.toBeDisplayed();
    await browser.keys('Escape');
    await expect(launches).not.toBeDisplayed();

    await openTopbarMenu('More actions');
    await browser.keys('Tab');
    await expect(more).not.toBeDisplayed();
    expect(
      await browser.execute(() => {
        const active = document.activeElement;
        return !!active && active !== document.body && !active.closest('[role="menu"]');
      }),
    ).toBe(true);
  });
});

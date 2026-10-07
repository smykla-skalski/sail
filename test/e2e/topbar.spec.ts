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
    await openTopbarMenu('New agent');
    await expect(more).not.toBeDisplayed();
    await browser.keys('Escape');
    await expect(launches).not.toBeDisplayed();
  });
});

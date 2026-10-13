import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { chooseTopbarAction } from './topbar';

const root = process.env.SAIL_E2E_CONFIG_DIR;
if (!root) throw new Error('Agent focus tests require isolated SAIL_E2E_CONFIG_DIR.');
const repository = join(root, 'focus-repository');

describe('reported agent focus', () => {
  before(() => {
    mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-q', repository]);
  });

  it('shows source and report time across session Tasks, overview, and compact Agents rows', async () => {
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-thread-attention');
      localStorage.removeItem('sai-pane-layouts');
    }, realpathSync(repository));
    await browser.refresh();
    await chooseTopbarAction('New agent', 'Claude');
    const auth = $('.agent-auth');
    if (await auth.isExisting()) await auth.$('button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer [data-pane-prompt]').setValue('Report session focus');
    await $('.agent-actions button:last-child').click();
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await $('button[role="tab"]*=Tasks').click();
    const panel = $('#session-details [aria-label="Session tasks"]');
    await expect(panel).toHaveText(expect.stringContaining('Observed status'));
    await expect(panel.$('[data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await expect(panel.$('time')).toExist();
    await $('.agent-status-summary').click();
    await expect($('.agent-status-popover [data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await expect($('.agent-status-popover time')).toExist();
    await browser.keys('Escape');
    await chooseTopbarAction('More actions', 'Task overview');
    await expect($('.task-card-focus [data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await expect($('.task-card-focus time')).toExist();
    await $('.task-card-focus').click();
    await $('.project-agent-menu').click();
    await $('[role="menuitem"]*=Remove from sidebar').click();
    await $('.agent-status-summary').click();
    await expect($('.agent-status-popover [data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await browser.keys('Escape');
    await browser.waitUntil(
      async () => (await $$('[data-focus-source="Agent report"]')).length === 0,
      { timeout: 25_000 },
    );
  });
  it('suppresses current focus while an elicitation form waits for input', async () => {
    await $('.agent-composer [data-pane-prompt]').setValue('Report focus then ask');
    await $('.agent-actions button:last-child').click();
    const panel = $('#session-details [aria-label="Session tasks"]');
    await expect(panel.$('[data-focus-source="Agent report"]')).toExist();
    await expect($('[aria-label="Agent question"]')).toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Needs input'));
    await expect(panel).toHaveText(expect.stringContaining('Waiting for input'));
    await expect(panel).not.toHaveText(expect.stringContaining('Current focus'));
    await expect(panel.$('[data-focus-source="Agent report"]')).not.toExist();
    await $('[aria-label="Agent question"] button*=Decline').click();
  });
});

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

  beforeEach(async () => {
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-thread-attention');
      localStorage.removeItem('sai-pane-layouts');
      localStorage.removeItem('sai-hidden-sidebar-threads');
    }, realpathSync(repository));
    await browser.refresh();
    await chooseTopbarAction('New agent', 'Claude');
    const auth = $('.agent-auth');
    if (await auth.isExisting()) await auth.$('button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await $('button[role="tab"]*=Tasks').click();
  });

  it('shows source and report time across session Tasks, overview, and compact Agents rows', async () => {
    await $('.agent-composer [data-pane-prompt]').setValue('Report session focus');
    const send = $('.agent-actions button:last-child');
    await send.waitForEnabled();
    await send.click();
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
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await browser.waitUntil(
      async () => (await $$('[data-focus-source="Agent report"]')).length === 0,
      { timeout: 25_000 },
    );
  });
  it('retains current Tasks focus when the working session is hidden and reopened through Agents', async () => {
    await $('.agent-composer [data-pane-prompt]').setValue('Report session focus');
    const send = $('.agent-actions button:last-child');
    await send.waitForEnabled();
    await send.click();
    const panel = $('#session-details [aria-label="Session tasks"]');
    await expect(panel.$('[data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    const reportedAt = await panel.$('time').getAttribute('datetime');
    const storedReport = await browser.execute(() => localStorage.getItem('sai-session-tasks'));
    expect(storedReport).toBeTruthy();
    await $('.project-agent-menu').click();
    await $('[role="menuitem"]*=Remove from sidebar').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await expect(panel.$('[data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await expect(panel.$('time')).toHaveAttribute('datetime', reportedAt);
    expect(await browser.execute(() => localStorage.getItem('sai-session-tasks'))).toBe(
      storedReport,
    );
    await $('.agent-status-summary').click();
    await expect($('.agent-status-popover [data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await expect($('.agent-status-popover time')).toHaveAttribute('datetime', reportedAt);
    await $('.agent-status-row').click();
    await expect(panel.$('[data-focus-source="Agent report"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await expect(panel.$('time')).toHaveAttribute('datetime', reportedAt);
    expect(await browser.execute(() => localStorage.getItem('sai-session-tasks'))).toBe(
      storedReport,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await expect(panel.$('[data-focus-source="Agent report"]')).not.toExist();
  });
  it('suppresses split Tasks focus and report time immediately while waiting for input', async () => {
    await browser.setWindowSize(2560, 1440);
    await browser.keys(['Meta', 'd']);
    await $('.pane-leaf.focused [data-pane-picker]').click();
    await $('.pane-leaf.focused [data-agent-choice]:not(:disabled)').click();
    const pane = $('.pane-leaf.focused');
    const auth = pane.$('.agent-auth');
    if (await auth.isExisting()) await auth.$('button').click();
    await expect(pane.$('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await browser.keys(['Meta', 'l']);
    await pane.$('.agent-composer [data-pane-prompt]').setValue('Report focus then ask');
    const send = pane.$('.agent-actions button:last-child');
    await send.waitForEnabled();
    await send.click();
    const panel = pane.$('[aria-label="Session tasks"]');
    await expect(panel.$('[data-focus-source="Agent report"]')).toExist();
    await expect(panel.$('time')).toExist();
    const question = pane.$('[aria-label="Agent question"]');
    await expect(question).toBeDisplayed();
    await expect(pane.$('.agent-header')).toHaveText(expect.stringContaining('Needs input'));
    try {
      const waiting = await browser.execute(() => {
        const leaf = document.querySelector('.pane-leaf.focused');
        const tasks = leaf?.querySelector('[aria-label="Session tasks"]');
        return {
          question: leaf?.querySelector('[aria-label="Agent question"]') !== null,
          header: leaf?.querySelector('.agent-header')?.textContent,
          tasks: tasks?.textContent,
          source: tasks?.querySelector('[data-focus-source]')?.getAttribute('data-focus-source'),
          report: tasks?.querySelector('[data-focus-source="Agent report"]') !== null,
          time: tasks?.querySelector('time') !== null,
        };
      });
      expect(waiting.question).toBe(true);
      expect(waiting.header).toContain('Needs input');
      expect(waiting.tasks).toContain('Waiting for input');
      expect(waiting.tasks).not.toContain('Current focus');
      expect(waiting.source).toBe('Observed status');
      expect(waiting.report).toBe(false);
      expect(waiting.time).toBe(false);
    } finally {
      if (await question.isDisplayed()) await question.$('button*=Decline').click();
    }
  });
  it('suppresses current focus while an elicitation form waits for input', async () => {
    await $('.agent-composer [data-pane-prompt]').setValue('Report focus then ask');
    const send = $('.agent-actions button:last-child');
    await send.waitForEnabled();
    await send.click();
    const panel = $('#session-details [aria-label="Session tasks"]');
    await expect(panel.$('[data-focus-source="Agent report"]')).toExist();
    await expect($('[aria-label="Agent question"]')).toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Needs input'));
    await expect(panel).toHaveText(expect.stringContaining('Waiting for input'));
    await expect(panel).not.toHaveText(expect.stringContaining('Current focus'));
    await expect(panel.$('[data-focus-source="Agent report"]')).not.toExist();
    await $('[aria-label="Agent question"]').$('button*=Decline').click();
  });
});

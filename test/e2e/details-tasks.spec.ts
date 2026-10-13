import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTopbarAction } from './topbar';

async function toggleDetails() {
  await browser.keys(['Meta', 'l']);
}

async function checkTabs(root: string, close: string) {
  const tasks = $(`${root} button[role="tab"]*=Tasks`);
  await expect(tasks).toHaveAttribute('aria-selected', 'true');
  await expect($(`${root} [aria-label="Session tasks"]`)).toHaveText(
    expect.stringContaining('No tasks reported in this session.'),
  );
  async function selectTab(label: string) {
    const tab = $(`${root} button[role="tab"]*=${label}`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tasks).toHaveAttribute('aria-selected', 'false');
  }
  await selectTab('Changes');
  await selectTab('Activity');
  await selectTab('Ship runs');
  await toggleDetails();
  await expect($(root)).not.toBeDisplayed();
  await toggleDetails();
  await expect(tasks).toHaveAttribute('aria-selected', 'true');
  await $(`${root} button[role="tab"]*=Changes`).click();
  await $(close).click();
  await toggleDetails();
  await expect(tasks).toHaveAttribute('aria-selected', 'true');
}

describe('Tasks default details tab', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-details-tasks-'));
  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('resets main and split details to Tasks on each open and preserves tab selection', async () => {
    await browser.setWindowSize(1920, 1200);
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await chooseTopbarAction('New agent', 'Claude');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await toggleDetails();
    await checkTabs('#session-details', '#session-details button[aria-label="Close Changes"]');

    await $('.agent-composer [data-pane-prompt]').setValue('Plan revision fixture');
    await $('.agent-actions button:last-child').click();
    await expect($('#session-details button[role="tab"]*=Plan')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect($('#session-details [aria-label="Native plan"]')).toHaveText(
      expect.stringContaining('Initial plan'),
    );
    await $('#session-details button[role="tab"]*=Tasks').click();
    await expect($('#session-details button[role="tab"]*=Tasks')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await toggleDetails();

    await browser.keys(['Meta', 'd']);
    await $('.pane-leaf.focused [data-pane-picker]').click();
    await $('.pane-leaf.focused [data-agent-choice]:not(:disabled)').click();
    await expect($('.pane-leaf.focused .agent-header')).toHaveText(
      expect.stringContaining('Ready'),
    );
    await toggleDetails();
    await checkTabs(
      '.pane-leaf.focused .native-details',
      '.pane-leaf.focused button[aria-label="Close agent details"]',
    );
    const composer = $('.pane-leaf.focused .agent-composer [data-pane-prompt]');
    await composer.setValue('Report session tasks');
    await $('.pane-leaf.focused .agent-actions button:last-child').click();
    await expect($('.pane-leaf.focused [aria-label="Session tasks"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
    await expect($('.pane-leaf.focused .native-details button[role="tab"]*=Tasks')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect($('#session-details')).not.toBeDisplayed();
  });
});

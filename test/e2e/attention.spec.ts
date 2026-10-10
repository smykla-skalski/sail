import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShipIssue, ShipRun } from '../../src/lib/issue-shipping';

const waitForComposer = () =>
  browser.waitUntil(
    () =>
      browser.execute(() =>
        Boolean(
          document.querySelector('.agent-composer [data-pane-prompt][contenteditable="true"]'),
        ),
      ),
    { timeout: 15000, timeoutMsg: 'Agent composer did not become ready' },
  );

const sendButton = () => $('.agent-actions button:last-child');

const actionDiagnostics = async () =>
  Promise.all(
    (await $$('.agent-actions button')).map(async (button) => ({
      text: await button.getText(),
      enabled: await button.isEnabled(),
    })),
  );

const submitPrompt = async (attempt = 0): Promise<void> => {
  const textarea = $('.agent-composer [data-pane-prompt]');
  await sendButton().waitForEnabled();
  await sendButton().click();
  const accepted = await browser
    .waitUntil(async () => (await textarea.getText()) === '', { timeout: 3000, interval: 100 })
    .then(() => true)
    .catch(() => false);
  if (accepted) return;
  if (attempt < 2) return submitPrompt(attempt + 1);
  console.error('Attention prompt submission diagnostic', {
    actions: await actionDiagnostics(),
    textarea: await textarea.getText(),
  });
  throw new Error('Agent prompt was not accepted');
};

const waitForStopButton = async () => {
  try {
    await expect($('.agent-busy button')).toBeDisplayed();
  } catch (cause) {
    console.error('Attention stop diagnostic', {
      conversation: await $('.agent-conversation').getText(),
      actions: await actionDiagnostics(),
      busy: await $$('.agent-busy').length,
      permissions: await $$('.agent-permission').length,
      textarea: await $('.agent-composer [data-pane-prompt]').getText(),
    });
    throw cause;
  }
};

const waitForTurnIdle = async () => {
  try {
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const send = document.querySelector<HTMLButtonElement>(
            '.agent-actions button:last-child',
          );
          return Boolean(
            !document.querySelector('.agent-busy') &&
            send &&
            send.textContent?.trim().startsWith('Send'),
          );
        }),
      { timeout: 15000, timeoutMsg: 'Agent turn did not settle' },
    );
  } catch (cause) {
    console.error('Attention turn settlement diagnostic', {
      conversation: await $('.agent-conversation').getText(),
      actions: await actionDiagnostics(),
      busy: await $$('.agent-busy').length,
      permissions: await $$('.agent-permission').length,
    });
    throw cause;
  }
};

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
    await $('.agent-composer [data-pane-prompt]').setValue('Stop during setup');
    await submitPrompt();
    await waitForStopButton();
    await $('.agent-busy button').click();
    const stoppedDuringSetup = $('.project-agent-row[aria-label*="Stop during setup"]');
    await expect(stoppedDuringSetup.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect($('.agent-composer [data-pane-prompt]')).toHaveText('Stop during setup');

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Delayed approval');
    await submitPrompt();
    const row = $('.project-agent-row[aria-label*="Delayed approval"]');
    await expect(row).toBeDisplayed();
    await $('.agent-launches button').click();
    await expect(row).toHaveText(expect.stringContaining('Needs input'));
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
    await browser.refresh();
    await expect(row).toHaveText(expect.stringContaining('Needs input'));
    await expect(sidebarRow).toHaveText(expect.stringContaining('Needs input'));

    await sidebarRow.click();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect($('.agent-header .activity-status')).toHaveAttribute('data-state', 'waiting');
    await expect($('.agent-header .activity-status')).toHaveText(
      expect.stringContaining('Needs input'),
    );
    await $('.agent-permission button').click();
    await expect(row).toHaveText(expect.stringContaining('Completed'));
    await expect(sidebarRow).toHaveText(expect.stringContaining('Completed'));

    await waitForTurnIdle();
    await $('.agent-composer [data-pane-prompt]').setValue('Delayed completion');
    await submitPrompt();
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-permission button').click();
    await $('.agent-launches button').click();
    await expect(row).toHaveText(expect.stringContaining('Completed'));
    await row.click();

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Slow cancel');
    await submitPrompt();
    const cancelled = $('.project-agent-row[aria-label*="Slow cancel"]');
    await expect($('.agent-permission')).toBeDisplayed();
    await browser.refresh();
    await expect($('.agent-permission')).toBeDisplayed();
    await expect($('.agent-busy button')).toBeDisplayed();
    await $('.agent-busy button').click();
    await $('.agent-launches button').click();
    await expect(cancelled).toHaveText(expect.stringContaining('Interrupted'));
    const cancelledSidebar = $('.project-agent-row[aria-label*="Slow cancel"]');
    await expect(cancelledSidebar.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );

    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Cancel error');
    await submitPrompt();
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-busy button').click();
    await $('.agent-launches button').click();
    const cancelledWithError = $('.project-agent-row[aria-label*="Cancel error"]');
    await expect(cancelledWithError.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(cancelledWithError).toHaveText(expect.stringContaining('Interrupted'));

    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Cancel ignored');
    await submitPrompt();
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-busy button').click();
    await $('.agent-launches button').click();
    const completedAfterCancel = $('.project-agent-row[aria-label*="Cancel ignored"]');
    await expect(completedAfterCancel.$('.activity-status')).toHaveAttribute(
      'data-state',
      'completed',
    );
    await expect(completedAfterCancel).toHaveText(expect.stringContaining('Completed'));

    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Agent interrupted');
    await submitPrompt();
    const agentInterrupted = $('.project-agent-row[aria-label*="Agent interrupted"]');
    await expect(agentInterrupted.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(agentInterrupted).toHaveText(expect.stringContaining('Interrupted'));
    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Agent error interrupted');
    await submitPrompt();
    const errorInterrupted = $('.project-agent-row[aria-label*="Agent error interrupted"]');
    await expect(errorInterrupted.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(errorInterrupted).toHaveText(expect.stringContaining('Interrupted'));
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

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Agent text interrupted');
    await submitPrompt();
    const textInterrupted = $('.project-agent-row[aria-label*="Agent text interrupted"]');
    await expect(textInterrupted.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(textInterrupted).toHaveText(expect.stringContaining('Interrupted'));

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Agent text interrupted error');
    await submitPrompt();
    const textInterruptedWithError = $(
      '.project-agent-row[aria-label*="Agent text interrupted error"]',
    );
    await expect(textInterruptedWithError.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(textInterruptedWithError).toHaveText(expect.stringContaining('Interrupted'));

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue(
      'Agent text interrupted unrelated error',
    );
    await submitPrompt();
    const unrelatedError = $(
      '.project-agent-row[aria-label*="Agent text interrupted unrelated error"]',
    );
    await expect(unrelatedError.$('.activity-status')).toHaveAttribute('data-state', 'failed');
    await expect(unrelatedError).toHaveText(expect.stringContaining('Failed'));

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Discuss interruption');
    await submitPrompt();
    const discussed = $('.project-agent-row[aria-label*="Discuss interruption"]');
    await expect(discussed.$('.activity-status')).toHaveAttribute('data-state', 'completed');
    await expect(discussed).toHaveText(expect.stringContaining('Completed'));

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Continue after interruption');
    await submitPrompt();
    const continued = $('.project-agent-row[aria-label*="Continue after interruption"]');
    await expect(continued.$('.activity-status')).toHaveAttribute('data-state', 'completed');
    await expect(continued).toHaveText(expect.stringContaining('Completed'));

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Native interrupted subagent');
    await submitPrompt();
    const nativeChildren = $('button[aria-label*="for Native interrupted subagent"]');
    await expect(nativeChildren).toHaveText(expect.stringContaining('1 historical'));
    await nativeChildren.click();
    const nativeInterrupted = $('.project-agent-row[aria-label*="Inspect interrupted delegation"]');
    await expect(nativeInterrupted.$('.activity-status')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    await expect(nativeInterrupted).toHaveText(expect.stringContaining('Interrupted'));

    await $('.agent-launches button').click();
    await waitForComposer();
    await $('.agent-composer [data-pane-prompt]').setValue('Crash on cancel');
    await submitPrompt();
    await expect($('.agent-permission')).toBeDisplayed();
    await $('.agent-busy button').click();
    const crashed = $('.project-agent-row[aria-label*="Crash on cancel"]');
    await expect(crashed.$('.activity-status')).toHaveAttribute('data-state', 'failed');
    await expect(crashed).toHaveText(expect.stringContaining('Failed'));
  });
});

const blocked = (id: string, number: number): ShipIssue => ({
  id,
  number,
  url: `https://github.com/fixture/repo/issues/${number}`,
  title: `Blocked fixture ${number}`,
  dependsOn: [],
  state: 'working',
  branch: id,
  path: null,
  receiptId: null,
  threadId: null,
  pullRequest: null,
  error: null,
  reportedStatus: 'blocked',
  blockedReason: `Decide ${id}`,
});

const focusedIssue = () =>
  browser.execute(() => document.activeElement?.getAttribute('data-ship-issue-id') ?? '');

describe('shared attention items', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-shared-attention-'));
  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    await browser.setWindowSize(1280, 850);
  });
  after(async () => {
    await browser.execute(() => {
      localStorage.removeItem('sai-ship-runs');
      localStorage.removeItem('sai-attention-ledger');
      localStorage.removeItem('sai-notification-prefs');
    });
    rmSync(repository, { recursive: true, force: true });
  });

  it('counts one list everywhere, opens a clicked Ship notification, and moves with Cmd+J', async () => {
    const path = realpathSync(repository);
    const run: ShipRun = {
      id: 'attention-run',
      source: 'plan',
      repository: path,
      remote: 'fixture/repo',
      provider: 'claude',
      limit: 2,
      approvedAt: 1,
      externalClosed: {},
      issues: [blocked('first', 71), blocked('second', 72)],
    };
    await browser.execute(
      (directory, input) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.setItem('sai-directory', directory);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
        );
        localStorage.setItem('sai-ship-runs', input);
        localStorage.removeItem('sai-attention-ledger');
        localStorage.setItem('sai-notifications-enabled', 'false');
      },
      path,
      JSON.stringify([run]),
    );
    await browser.refresh();
    await expect($('.app-shell')).toBeDisplayed();

    await expect($('[data-topbar-inbox]')).toHaveText('Inbox (2)');
    await expect($('.agent-status-bar')).toHaveText(expect.stringContaining('2 need attention'));
    await $('[data-topbar-inbox]').click();
    await expect($('.inbox-header span')).toHaveText('2');
    await expect($$('.inbox-attention')).toBeElementsArrayOfSize(2);
    await expect($('.inbox-group-heading')).toHaveText(path.split('/').at(-1)!);
    await $('[aria-label="Close pending requests"]').click();

    await browser.execute(
      (target) =>
        window.dispatchEvent(new CustomEvent('sail-e2e-notification-click', { detail: target })),
      { type: 'ship-issue', runId: run.id, issueId: 'second', repository: path },
    );
    await expect($('.ship-panel')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(
        () => document.activeElement?.getAttribute('data-ship-issue-id') === 'second',
      ),
    );
    await expect($('.side-tabs')).toHaveText(expect.stringContaining('Ship runs (2)'));

    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }),
      ),
    );
    await browser.waitUntil(async () => (await focusedIssue()) === 'first');
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }),
      ),
    );
    await browser.waitUntil(async () => (await focusedIssue()) === 'second');

    await $('[data-topbar-inbox]').click();
    await $('.inbox-attention').$('button=Dismiss').click();
    await expect($('[data-topbar-inbox]')).toHaveText('Inbox (1)');
    await expect($('.agent-status-bar')).toHaveText(expect.stringContaining('1 need attention'));
  });
});

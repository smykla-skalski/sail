import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('pending requests across projects', () => {
  const first = mkdtempSync(join(tmpdir(), 'sail-inbox-first-'));
  const second = mkdtempSync(join(tmpdir(), 'sail-inbox-second-'));

  before(() => {
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', ['init', '-q', second]);
  });
  after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  it('orders requests, answers inline, and opens the exact thread', async () => {
    const paths = [realpathSync(first), realpathSync(second)];
    await browser.execute(([one, two]) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.setItem('sai-directory', one);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [one, two], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-thread-attention');
      localStorage.removeItem('sai-inbox-seen');
      localStorage.setItem('sai-notifications-enabled', 'false');
    }, paths);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();

    await $('.agent-launches button').click();
    await $('.agent-composer [data-pane-prompt]').waitForEnabled();
    await $('.agent-composer [data-pane-prompt]').setValue('First request');
    await $('.agent-actions button').click();
    try {
      await expect($('.agent-permission')).toBeDisplayed();
    } catch (cause) {
      console.error('Inbox pending diagnostic', {
        conversation: await $('.agent-conversation').getText(),
        alerts: await browser.execute(() => document.body.innerText.slice(-2000)),
        settings: await browser.execute(() =>
          Object.fromEntries(
            Object.entries(localStorage).filter(([key]) => key.startsWith('sai-')),
          ),
        ),
      });
      throw cause;
    }
    await $(`.project-default-worktree-select[title="${paths[1]}"]`).click();
    await expect($('.agent-launches button')).toBeEnabled();
    await $('.agent-launches button').click();
    await $('.agent-composer [data-pane-prompt]').waitForEnabled();
    await $('.agent-composer [data-pane-prompt]').setValue('Second request');
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await $(`.project-default-worktree-select[title="${paths[0]}"]`).click();

    await $('[data-topbar-inbox]').click();
    const entries = await $$('.inbox-item');
    await expect(entries).toBeElementsArrayOfSize(2);
    await expect(entries[0]).toHaveText(expect.stringContaining(first.split('/').at(-1)!));
    await expect(entries[1]).toHaveText(expect.stringContaining(second.split('/').at(-1)!));
    await entries[0].$('.inbox-actions button').click();
    await expect($$('.inbox-item:not(.inbox-result)')).toBeElementsArrayOfSize(1);
    await $('.inbox-item:not(.inbox-result) .inbox-open').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => document.activeElement?.classList.contains('agent-permission')),
    );
    await $('.agent-permission button').click();
    await $('[data-topbar-inbox]').click();
    await expect($('.inbox-empty')).toHaveText('Nothing needs your input.');
  });

  it('keeps completed turns and opens the matching earlier response', async () => {
    await browser.execute((path) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-inbox-outcomes');
      localStorage.setItem('sai-notifications-enabled', 'false');
    }, realpathSync(first));
    await browser.refresh();
    await $('.agent-launches button').click();
    await $('.agent-composer [data-pane-prompt]').waitForEnabled();
    await $('.agent-composer [data-pane-prompt]').setValue('Activity demo');
    await $('.agent-actions button').click();
    await browser.waitUntil(async () => (await $$('.inbox-result')).length === 1);
    await $('[data-topbar-inbox]').click();
    await expect($('.inbox-result')).toHaveText(expect.stringContaining('Turn completed'));
    await expect($('.inbox-result')).toHaveAttribute('class', expect.stringContaining('unread'));
    await $('.inbox-result .inbox-open').click();
    await expect($('.agent-message.assistant-message')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => document.activeElement?.classList.contains('assistant-message')),
    );
    await $('[data-topbar-inbox]').click();
    await expect($('.inbox-result')).not.toHaveAttribute(
      'class',
      expect.stringContaining('unread'),
    );
    await $('[aria-label="Close pending requests"]').click();
    await $('.agent-composer [data-pane-prompt]').setValue('Steer no-response follow-up');
    await $('.agent-actions button').click();
    await browser.waitUntil(async () => (await $$('.inbox-result')).length === 2);
    await $('[data-topbar-inbox]').click();
    const results = await $$('.inbox-result');
    await expect(results).toBeElementsArrayOfSize(2);
    await results[1].$('.inbox-open').click();
    await browser.waitUntil(() =>
      browser.execute(
        () => document.activeElement?.textContent?.includes('The checks passed.') ?? false,
      ),
    );
    await browser.refresh();
    await $('[data-topbar-inbox]').click();
    await expect($$('.inbox-result')).toBeElementsArrayOfSize(2);
  });

  it('opens a failed check without clearing unrelated unread thread attention', async () => {
    const paths = [realpathSync(first), realpathSync(second)];
    mkdirSync(join(first, '.sail'), { recursive: true });
    writeFileSync(
      join(first, '.sail', 'worktree.json'),
      JSON.stringify({ postTurnChecks: ['printf check; exit 7'] }),
    );
    execFileSync('git', ['-C', first, 'add', '.sail/worktree.json']);
    execFileSync('git', [
      '-C',
      first,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'baseline',
    ]);
    await browser.execute(([one, two]) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.setItem('sai-directory', one);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [one, two], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-thread-attention');
      localStorage.removeItem('sai-inbox-outcomes');
      localStorage.setItem('sai-notifications-enabled', 'false');
    }, paths);
    await browser.refresh();
    await browser.execute(async (path) => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.core.invoke('approve_post_turn_check', {
        directory: path,
        command: 'printf check; exit 7',
      });
    }, paths[0]);
    await $('.agent-launches button').click();
    await $('.agent-composer [data-pane-prompt]').waitForEnabled();
    await $('.agent-composer [data-pane-prompt]').setValue('Activity demo');
    await $('.agent-actions button').click();
    await $(`.project-default-worktree-select[title="${paths[1]}"]`).click();
    await browser.waitUntil(() =>
      browser.execute(() =>
        Object.values(JSON.parse(localStorage.getItem('sai-thread-attention') ?? '{}')).some(
          (item: unknown) =>
            !!item &&
            typeof item === 'object' &&
            Reflect.get(item, 'status') === 'done' &&
            Reflect.get(item, 'unread') === true,
        ),
      ),
    );
    await $('[data-topbar-inbox]').click();
    const failedCheck = $('//li[contains(@class, "inbox-result")][contains(., "Check failed")]');
    await expect(failedCheck).toBeDisplayed();
    const before = await browser.execute(() =>
      JSON.parse(localStorage.getItem('sai-thread-attention') ?? '{}'),
    );
    await failedCheck.$('.inbox-open').click();
    await browser.waitUntil(() =>
      browser.execute(() => document.activeElement?.classList.contains('post-turn-check')),
    );
    const after = await browser.execute(() =>
      JSON.parse(localStorage.getItem('sai-thread-attention') ?? '{}'),
    );
    expect(after).toEqual(before);
  });
});

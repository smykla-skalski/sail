import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('shared transcript view', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-transcript-e2e-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('shows a provider avatar, a time, a grouped tool and a permission card without Always', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Do a small thing');
    await $('.agent-actions button').click();
    const card = $('.permission-card');
    await expect(card).toBeDisplayed();
    await expect(card).not.toHaveText(expect.stringContaining('Always'));
    await expect($('.agent-tool-group, .agent-tool-current')).toBeDisplayed();
    await $('.permission-card .permission-link').click();
    await $('.permission-card .permission-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Do a small thing'),
    );
    await expect($('.assistant-message .provider-avatar')).toBeDisplayed();
    await expect($('.user-message .message-time')).toBeDisplayed();
    expect((await $$('.agent-conversation .message')).length).toBeGreaterThan(1);
  });

  it('keeps a queued message under the running turn and places the permission card', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Delayed approval');
    await $('.agent-actions button:last-of-type').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Working'));
    await $('.agent-composer textarea').setValue('Queued follow-up');
    await $('.agent-actions button:last-of-type').click();
    await expect($('.agent-conversation .queued-messages')).toHaveText(
      expect.stringContaining('Queued follow-up'),
    );
    await expect($('.permission-card')).toBeDisplayed();
    await $('.permission-card .permission-actions button').click();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Done: Delayed approval'),
    );
  });
});

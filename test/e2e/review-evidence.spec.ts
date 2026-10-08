import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topbarMenuTrigger } from './topbar';

describe('review evidence', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-review-evidence-e2e-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('collects current changes and opens the selected evidence', async () => {
    await browser.setWindowSize(1280, 850);
    const path = realpathSync(repository);
    await browser.execute((directory) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [] }),
      );
    }, path);
    await browser.refresh();
    await expect(topbarMenuTrigger('New agent')).toBeDisplayed();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));

    writeFileSync(join(repository, 'review-me.txt'), 'Review this evidence\n');
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();

    await expect($('.review-evidence')).toBeDisplayed();
    await expect($('.review-evidence')).toHaveText(expect.stringContaining('Review evidence'));
    await expect($('.review-evidence')).toHaveText(
      expect.stringContaining('Git working tree · current'),
    );
    await expect($('.review-evidence')).toHaveText(
      expect.stringContaining('No checks recorded. Turn completion does not mean checks passed.'),
    );
    await $(
      "//section[contains(@class,'review-evidence')]//button[.//span[contains(.,'review-me.txt')]]",
    ).click();
    await expect($('.diff-files button.active')).toHaveText(
      expect.stringContaining('review-me.txt'),
    );
    await expect($('.diff-file-heading')).toHaveText(expect.stringContaining('review-me.txt'));

    await browser.setWindowSize(390, 600);
    await $('.mobile-switcher button:nth-child(3)').click();
    await expect($('.review-evidence')).toBeDisplayed();
    const mobileBounds = await browser.execute(() => ({
      details: document.querySelector('#session-details')!.getBoundingClientRect().toJSON(),
      evidence: document.querySelector('.review-evidence')!.getBoundingClientRect().toJSON(),
      topbar: document.querySelector('.topbar')!.getBoundingClientRect().toJSON(),
      status: document.querySelector('.agent-status-bar')!.getBoundingClientRect().toJSON(),
    }));
    expect(mobileBounds.details.top).toBe(mobileBounds.topbar.bottom);
    expect(mobileBounds.details.bottom).toBeLessThanOrEqual(mobileBounds.status.top);
    expect(mobileBounds.evidence.width).toBeLessThanOrEqual(390);
  });
});

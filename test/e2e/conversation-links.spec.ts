import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('conversation links', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-links-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('opens safe links through the desktop browser command', async () => {
    const openedUrlLog = process.env.SAIL_E2E_OPEN_URL_LOG;
    if (!openedUrlLog) throw new Error('External link test log is not configured');
    rmSync(openedUrlLog, { force: true });
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer [data-pane-prompt]').setValue('Link example');
    await $('.agent-actions button').click();
    await $('.agent-permission button').click();
    const link = $('.agent-conversation a[href="https://example.com/path"]');
    await expect(link).toBeDisplayed();
    await expect($('.agent-conversation a[href^="javascript:"]')).not.toExist();

    await link.click();
    await browser.waitUntil(() => existsSync(openedUrlLog), {
      timeout: 3000,
      timeoutMsg: 'Conversation link did not invoke the external browser command',
    });
    expect(readFileSync(openedUrlLog, 'utf8')).toBe('https://example.com/path');
  });
});

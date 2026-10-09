import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sidebar agent rows', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-sidebar-titles-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('shows agent icons without provider names or thread descriptions', async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute((path: string) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.setItem(
        'sail-agent-threads',
        JSON.stringify([
          {
            agent: 'claude',
            directory: path,
            sessionId: 'p',
            title: 'Sail keyboard pass for the sidebar',
            updated: 2,
          },
          {
            agent: 'claude',
            directory: path,
            sessionId: 'c',
            title: 'Subagent reviewing the sidebar layout',
            updated: 3,
          },
        ]),
      );
      localStorage.setItem(
        'sai-agent-spawn-receipts',
        JSON.stringify([
          {
            receiptId: 'nested',
            accessKey: '',
            requestId: 'nested',
            project: path,
            sourceId: 'acp:claude:p',
            sourceDirectory: path,
            targetId: 'acp:claude:c',
            turnId: null,
            targetDirectory: path,
            worktreeId: null,
            provider: 'claude',
            prompt: 'Review the layout',
            state: 'working',
            created: 1,
            updated: Date.now(),
            result: null,
            error: null,
          },
        ]),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await expect($('.project-agent-row.subagent')).toBeDisplayed();
    expect(await $$('.project-agent-row .activity-status').length).toBeGreaterThan(1);

    const rows = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.project-agent-row')].map((row) => ({
        provider: row.querySelector('.project-agent-provider')?.textContent?.trim() ?? '',
        title: row.querySelector('.project-agent-title')?.textContent?.trim() ?? '',
        status: row.querySelector<HTMLElement>('.activity-status')?.offsetWidth ?? 0,
      })),
    );
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.provider)).toEqual(['', '↳']);
    expect(rows.map((row) => row.title)).toEqual(['', '']);
    expect(rows.map((row) => row.status > 0)).toEqual([true, true]);
  });
});

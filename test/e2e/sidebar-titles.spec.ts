import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sidebar agent rows', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-sidebar-titles-'));
  const other = mkdtempSync(join(tmpdir(), 'sail-sidebar-reference-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', other]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('shows agent icons without provider names or thread descriptions', async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute(
      (path: string, otherPath: string) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.clear();
        localStorage.setItem('sai-directory', path);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [path, otherPath], groups: [], worktrees: {} }),
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
            {
              agent: 'claude',
              directory: path,
              sessionId: 'g',
              title: 'Nested review',
              updated: 4,
            },
            {
              agent: 'claude',
              directory: otherPath,
              sessionId: 'r',
              title: 'Cross-worktree review',
              updated: 5,
            },
          ]),
        );
        localStorage.setItem(
          'sai-agent-spawn-receipts',
          JSON.stringify(
            [
              ['native:nested', path, 'p', path, 'c', 'working'],
              ['native:grandchild', path, 'c', path, 'g', 'working'],
              ['reference', path, 'c', otherPath, 'r', 'working'],
              ['native:sibling-a', path, 'c', path, 'a', 'working'],
              ['native:sibling-b', path, 'c', path, 'b', 'working'],
              ['native:waiting-a', path, 'c', path, 'd', 'waiting'],
              ['native:waiting-b', path, 'c', path, 'e', 'waiting'],
              ['native:waiting-c', path, 'c', path, 'f', 'waiting'],
            ].map(([id, sourceDirectory, source, targetDirectory, target, state]) => ({
              receiptId: id,
              accessKey: '',
              requestId: id,
              project: path,
              sourceId: `acp:claude:${source}`,
              sourceDirectory,
              targetId: `acp:claude:${target}`,
              turnId: null,
              targetDirectory,
              worktreeId: null,
              provider: 'claude',
              prompt: 'Review the layout',
              state,
              created: 1,
              updated: Date.now(),
              result: null,
              error: null,
            })),
          ),
        );
      },
      realpathSync(repository),
      realpathSync(other),
    );
    await browser.refresh();
    await expect($('.project-agent-row.subagent')).toBeDisplayed();
    expect(await $$('.project-agent-row .activity-status').length).toBeGreaterThan(1);

    const rows = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.project-agent-row')].map((row) => ({
        provider: row.querySelector('.project-agent-provider')?.textContent?.trim() ?? '',
        subagent: !!row.querySelector('.project-subagent-tag'),
        title: row.querySelector('.project-agent-title')?.textContent?.trim() ?? '',
        status: row.querySelector<HTMLElement>('.activity-status')?.offsetWidth ?? 0,
      })),
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.map((row) => row.provider)).toContain('↳Subagent');
    expect(rows.every((row) => row.title === '' && row.status > 0)).toBe(true);
    await expect($('.project-agent-row[data-depth="2"]')).toBeDisplayed();
    await expect($('.project-agent-row[data-reference="true"]')).toBeDisplayed();
    const longStatus = $('.project-agent-row[aria-label*="3 active, 3 waiting"]');
    await expect(longStatus).toBeDisplayed();
    expect(await longStatus.getAttribute('data-depth')).toBe('1');
    await expect(longStatus.$('.project-subagent-tag')).toHaveText('Subagent');
    const visibleStart = await longStatus.execute((row) => {
      const provider = row.querySelector<HTMLElement>('.project-agent-provider')!;
      const tag = row.querySelector<HTMLElement>('.project-subagent-tag')!;
      const status = row.querySelector<HTMLElement>('.activity-status')!;
      const providerRect = provider.getBoundingClientRect();
      const tagRect = tag.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      return {
        providerWidth: providerRect.width,
        tagVisible: tagRect.left >= providerRect.left && tagRect.left < providerRect.right,
        statusWidth: statusRect.width,
        rowWidth: row.getBoundingClientRect().width,
        gap: statusRect.left - providerRect.left,
      };
    });
    expect(visibleStart.providerWidth).toBeGreaterThan(20);
    expect(visibleStart.tagVisible).toBe(true);
    expect(visibleStart.statusWidth).toBeLessThanOrEqual(visibleStart.rowWidth / 2);
    expect(visibleStart.gap).toBeGreaterThan(20);
  });
});

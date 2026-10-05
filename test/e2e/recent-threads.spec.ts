import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function createThread(title: string) {
  await $('.agent-launches button').click();
  await expect($('.agent-composer textarea')).toBeEnabled();
  await $('.agent-composer textarea').setValue(title);
  await $('.agent-actions button').click();
  await expect($('.agent-permission')).toBeDisplayed();
  await $('.agent-permission button').click();
  await expect($('.agent-conversation')).toHaveText(expect.stringContaining(`Done: ${title}`));
}

describe('recent thread shortcuts', () => {
  const first = mkdtempSync(join(tmpdir(), 'sail-recent-first-'));
  const second = mkdtempSync(join(tmpdir(), 'sail-recent-second-'));

  before(() => {
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', ['init', '-q', second]);
  });
  after(() => {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  });

  it('jumps across projects, ignores empty slots, and persists visit order', async () => {
    const firstPath = realpathSync(first);
    const secondPath = realpathSync(second);
    await browser.execute(
      (a, b) => {
        sessionStorage.removeItem('sail-e2e-settings');
        localStorage.removeItem('sail-agent-threads');
        localStorage.removeItem('sai-recent-agent-threads');
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem('sai-directory', a);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [a, b], groups: [], worktrees: {} }),
        );
      },
      firstPath,
      secondPath,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();

    await createThread('Thread one');
    await $(`.project-default-worktree-select[title="${secondPath}"]`).click();
    await createThread('Thread two');
    await createThread('Thread three');
    await browser.execute(() => {
      const saved: unknown = JSON.parse(localStorage.getItem('sail-agent-threads') ?? '[]');
      if (!Array.isArray(saved)) throw new Error('Expected saved agent threads');
      const threads = saved.filter(
        (item): item is { agent: string; directory: string; sessionId: string; title: string } =>
          typeof item === 'object' &&
          item !== null &&
          'agent' in item &&
          typeof item.agent === 'string' &&
          'directory' in item &&
          typeof item.directory === 'string' &&
          'sessionId' in item &&
          typeof item.sessionId === 'string' &&
          'title' in item &&
          typeof item.title === 'string',
      );
      const byTitle = ['Thread one', 'Thread two', 'Thread three'].map((title) =>
        threads.find((thread) => thread.title === title),
      );
      if (byTitle.some((thread) => !thread)) throw new Error('Expected three real agent threads');
      localStorage.setItem(
        'sai-recent-agent-threads',
        JSON.stringify(
          byTitle.map((thread) =>
            JSON.stringify([thread!.agent, thread!.directory, thread!.sessionId]),
          ),
        ),
      );
    });
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();

    await browser.keys(['Meta', '2']);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === secondPath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread two'));
    await expect($('.agent-composer textarea')).toBeEnabled();
    await expect($('.agent-composer textarea')).toBeFocused();
    await expect($('.agent-error')).not.toExist();

    await browser.keys(['Meta', '9']);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread two'));
    await expect($('.agent-error')).not.toExist();

    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await browser.keys(['Meta', '1']);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread two'));
    await expect($('.agent-composer textarea')).toBeEnabled();
    await expect($('.agent-composer textarea')).toBeFocused();
    await expect($('.agent-error')).not.toExist();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }),
      ),
    );
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === firstPath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread one'));
    await expect($('.agent-composer textarea')).toBeEnabled();
    await expect($('.agent-composer textarea')).toBeFocused();
    await expect($('.agent-error')).not.toExist();

    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === secondPath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread two'));
    await expect($('.agent-composer textarea')).toBeEnabled();
    await expect($('.agent-composer textarea')).toBeFocused();
    await expect($('.agent-error')).not.toExist();
    await $('.project-agent-row[aria-label*="Thread one"]').click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => localStorage.getItem('sai-directory'))) === firstPath,
    );
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Thread one'));
  });

  it('hides a thread until it is reopened without deleting its conversation', async () => {
    await browser.setWindowSize(1280, 850);
    const path = realpathSync(first);
    await browser.execute((directory) => {
      localStorage.removeItem('sail-agent-threads');
      localStorage.removeItem('sai-recent-agent-threads');
      localStorage.removeItem('sai-hidden-sidebar-threads');
      localStorage.removeItem('sai-pane-layouts');
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
    }, path);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await createThread('Hidden thread');
    const row = $('.project-agent-row[aria-label*="Hidden thread"]');
    await expect(row).toBeDisplayed();

    await row.click({ button: 'right' });
    await expect($('.project-menu')).toBeDisplayed();
    await $('.project-menu button[role="menuitem"]').click();
    await expect(row).not.toExist();
    const saved = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    expect(saved).toContain('Hidden thread');

    await browser.refresh();
    await expect(row).not.toExist();
    await expect($('.agent-launches button')).toBeEnabled();
    await browser.keys(['Meta', '1']);
    await expect(row).toBeDisplayed();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Hidden thread'));
  });
});

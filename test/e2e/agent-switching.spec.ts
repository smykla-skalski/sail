import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent switching', () => {
  const currentRepository = mkdtempSync(join(tmpdir(), 'sail-switch-current-'));
  const targetRepository = mkdtempSync(join(tmpdir(), 'sail-switch-target-'));

  before(() => {
    execFileSync('git', ['init', '-q', currentRepository]);
    execFileSync('git', ['init', '-q', targetRepository]);
  });

  after(() => {
    rmSync(currentRepository, { recursive: true, force: true });
    rmSync(targetRepository, { recursive: true, force: true });
  });

  it('opens an ACP thread while OpenCode prepares its worktree', async () => {
    const current = realpathSync(currentRepository);
    const target = realpathSync(targetRepository);
    await browser.execute((path) => sessionStorage.setItem('sai-e2e-switch-target', path), target);
    const session = await browser.tauri.execute(async ({ core }) => {
      const path = sessionStorage.getItem('sai-e2e-switch-target');
      if (!path) throw new Error('Missing target repository');
      await core.invoke('acp_connect', { agent: 'claude' });
      return core.invoke<{ sessionId: string }>('acp_new_session', {
        params: { agent: 'claude', cwd: path },
      });
    });
    await browser.execute(
      ({ current: selectedPath, target: targetPath, sessionId }) => {
        sessionStorage.removeItem('sai-e2e-switch-target');
        localStorage.setItem('sai-directory', selectedPath);
        localStorage.removeItem('sai-pane-layouts');
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [selectedPath, targetPath], groups: [], worktrees: {} }),
        );
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            {
              agent: 'claude',
              sessionId,
              directory: targetPath,
              title: 'Switch target',
              updated: Date.now(),
            },
          ]),
        );
      },
      { current, target, sessionId: session.sessionId },
    );
    await browser.refresh();
    await expect($('.sidebar-footer')).toHaveText(expect.stringContaining('OpenCode connected'));
    const row = $('.project-agent-row[aria-label*="Switch target"]');
    await expect(row).toBeDisplayed();

    await browser.execute(() => {
      sessionStorage.setItem('sai-e2e-browser-setup-delay', '2000');
      sessionStorage.removeItem('sai-e2e-browser-setup-started');
      sessionStorage.removeItem('sai-e2e-browser-setup-finished');
    });

    try {
      await browser.execute(() => {
        Reflect.set(window, '__switchStart', performance.now());
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.agent-header')?.textContent?.includes('Switch target'))
            return;
          Reflect.set(window, '__switchVisible', performance.now());
          Reflect.set(
            window,
            '__switchStartedAtVisible',
            sessionStorage.getItem('sai-e2e-browser-setup-started'),
          );
          Reflect.set(
            window,
            '__switchFinishedAtVisible',
            sessionStorage.getItem('sai-e2e-browser-setup-finished'),
          );
          observer.disconnect();
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        document
          .querySelector<HTMLButtonElement>('.project-agent-row[aria-label*="Switch target"]')
          ?.click();
      });
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Switch target'));
      await browser.waitUntil(async () =>
        browser.execute(() => Reflect.has(window, '__switchVisible')),
      );
      const result = await browser.execute(() => ({
        elapsed:
          Number(Reflect.get(window, '__switchVisible')) -
          Number(Reflect.get(window, '__switchStart')),
        started: Reflect.get(window, '__switchStartedAtVisible'),
        finished: Reflect.get(window, '__switchFinishedAtVisible'),
        selected: document.querySelector('.project-agent-row.active')?.getAttribute('aria-label'),
      }));
      console.log('ACP switch with delayed OpenCode setup', result);
      expect(result.started).toBe(target);
      expect(result.finished).toBeNull();
      expect(result.selected).toContain('Switch target');
      expect(result.elapsed).toBeLessThan(1_500);
      await browser.waitUntil(async () =>
        browser.execute(
          (path) => sessionStorage.getItem('sai-e2e-browser-setup-finished') === path,
          target,
        ),
      );
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Switch target'));
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    } finally {
      await browser.execute(() => {
        sessionStorage.removeItem('sai-e2e-browser-setup-delay');
        sessionStorage.removeItem('sai-e2e-browser-setup-started');
        sessionStorage.removeItem('sai-e2e-browser-setup-finished');
      });
    }

    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('New thread'));
    await $('.agent-menu-launch').click();
    const search = $('[aria-label="Search command palette"]');
    await search.setValue('Claude');
    await browser.keys('Enter');
    await search.setValue('Switch target');
    await browser.keys('Enter');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Switch target'));
  });

  it('rejects a saved thread after its selected worktree is removed outside Sail', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('New thread'));
    rmSync(targetRepository, { recursive: true, force: true });

    await $('.agent-menu-launch').click();
    const search = $('[aria-label="Search command palette"]');
    await search.setValue('Claude');
    await browser.keys('Enter');
    await search.setValue('Switch target');
    await browser.keys('Enter');
    await expect($('.palette-error')).toHaveText('This session is no longer available.');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('New thread'));
  });
});

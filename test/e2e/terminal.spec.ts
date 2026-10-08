import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSettings, returnToWorkspace } from './settings-window';

async function sendCommand(command: string) {
  await browser.execute(async (value) => {
    const id = document
      .querySelector('.terminal-screen')
      ?.closest('.pane-leaf')
      ?.getAttribute('data-pane-id');
    if (!id) throw new Error('No terminal pane');
    const bridge: unknown = Reflect.get(window, '__TAURI__');
    if (!bridge || typeof bridge !== 'object' || !('core' in bridge))
      throw new Error('Tauri bridge unavailable');
    const core = bridge.core;
    if (
      !core ||
      typeof core !== 'object' ||
      !('invoke' in core) ||
      typeof core.invoke !== 'function'
    )
      throw new Error('Tauri invoke unavailable');
    await core.invoke('terminal_write', {
      id,
      data: [...new TextEncoder().encode(`${value}\n`)],
    });
  }, command);
}

const colors = () =>
  browser.execute(() => {
    const pane = document.querySelector('.terminal-pane')!;
    const viewport = document.querySelector('.terminal-screen .xterm-viewport')!;
    return {
      theme: document.documentElement.dataset.suiTheme,
      pane: getComputedStyle(pane).backgroundColor,
      viewport: getComputedStyle(viewport).backgroundColor,
    };
  });

describe('shell terminal panes', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-terminal-repo-'));
  const other = mkdtempSync(join(tmpdir(), 'sail-terminal-other-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', other]);
  });
  after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('matches both app themes and updates an open terminal', async () => {
    const path = realpathSync(repository);
    await browser.execute((selected) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.removeItem('sai-pane-layouts');
      localStorage.setItem('sai-directory', selected);
      localStorage.setItem('sai-theme', 'light');
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [selected], groups: [], worktrees: {} }),
      );
    }, path);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await browser.keys(['Meta', 't']);
    await expect($('.terminal-screen .xterm')).toBeDisplayed();

    expect(await colors()).toEqual({
      theme: 'light',
      pane: 'rgb(255, 255, 255)',
      viewport: 'rgb(255, 255, 255)',
    });

    await openSettings();
    await $('[aria-label^="Theme:"]').click();
    await $('.option-menu [role="option"]:nth-child(3)').click();
    await returnToWorkspace();
    await browser.waitUntil(async () => (await colors()).theme === 'dark');
    expect(await colors()).toEqual({
      theme: 'dark',
      pane: 'rgb(21, 26, 33)',
      viewport: 'rgb(21, 26, 33)',
    });
    await expect($('.terminal-screen .xterm')).toBeDisplayed();
  });

  it('opens the worktree dialog on Cmd+N without writing to the focused terminal', async () => {
    await browser.keys(['Meta', 't']);
    await browser.waitUntil(() =>
      browser.execute(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
    );
    await browser.keys(['Meta', 'n']);
    await expect($('.worktree-dialog[open]')).toBeDisplayed();
    await $('.worktree-cancel').click();
    await expect($('.worktree-dialog[open]')).not.toExist();
  });

  it('starts in the project, retains scrollback across project switches, and restarts after exit', async () => {
    const paths = [realpathSync(repository), realpathSync(other)];
    await browser.execute(([first, second]) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.removeItem('sai-pane-layouts');
      localStorage.setItem('sai-directory', first);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [first, second], groups: [], worktrees: {} }),
      );
    }, paths);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await browser.keys(['Meta', 't']);
    await expect($('.terminal-screen .xterm')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
    );
    await sendCommand('pwd');
    await browser.waitUntil(() =>
      browser.execute(
        (path) =>
          document
            .querySelector('.terminal-screen .xterm-accessibility-tree')
            ?.textContent?.includes(path) ?? false,
        paths[0],
      ),
    );
    await $(`.project-default-worktree-select[title="${paths[1]}"]`).click();
    await browser.keys(['Meta', 't']);
    await expect($('.terminal-screen .xterm')).toBeDisplayed();
    await sendCommand('pwd');
    await browser.waitUntil(() =>
      browser.execute(
        (path) =>
          document
            .querySelector('.terminal-screen .xterm-accessibility-tree')
            ?.textContent?.includes(path) ?? false,
        paths[1],
      ),
    );
    await $(`.project-default-worktree-select[title="${paths[0]}"]`).click();
    await expect($('.terminal-screen .xterm')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(
        (path) =>
          document
            .querySelector('.terminal-screen .xterm-accessibility-tree')
            ?.textContent?.includes(path) ?? false,
        paths[0],
      ),
    );
    await $(`.project-default-worktree-select[title="${paths[1]}"]`).click();
    await browser.waitUntil(() =>
      browser.execute(
        (path) =>
          document
            .querySelector('.terminal-screen .xterm-accessibility-tree')
            ?.textContent?.includes(path) ?? false,
        paths[1],
      ),
    );
    await $(`.project-default-worktree-select[title="${paths[0]}"]`).click();
    await sendCommand('exit 7');
    await expect($('.terminal-exit')).toHaveText(expect.stringContaining('code 7'));
    await $('.terminal-exit button').click();
    await expect($('.terminal-exit')).not.toExist();
    await sendCommand('echo restarted');
    await browser.waitUntil(() =>
      browser.execute(() =>
        document
          .querySelector('.terminal-screen .xterm-accessibility-tree')
          ?.textContent?.includes('restarted'),
      ),
    );
    await browser.execute(() =>
      document.querySelector<HTMLElement>('.terminal-screen .xterm-helper-textarea')?.focus(),
    );
    await browser.keys(['Meta', 'w']);
    await expect($('.terminal-screen')).not.toExist();
  });
});

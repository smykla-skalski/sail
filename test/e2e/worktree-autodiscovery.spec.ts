import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSettings, returnToWorkspace } from './settings-window';

const setting = 'sai-worktree-autodiscovery-enabled';
const externalWorktree = () => $('button[aria-label="Open external worktree external-discovery"]');

const forceAppearance = (theme: 'light' | 'dark', label: string) =>
  browser.tauri.execute(
    async ({ core }, window, value) =>
      core.invoke('plugin:window|set_theme', { label: window, value }),
    label,
    theme,
  );

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

describe('worktree autodiscovery', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sail-worktree-autodiscovery-'));
  const repository = join(fixture, 'repository');
  const external = join(fixture, 'external');

  before(() => {
    mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(join(repository, 'README.md'), 'fixture\n');
    execFileSync('git', ['-C', repository, 'add', 'README.md']);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    execFileSync('git', [
      '-C',
      repository,
      'worktree',
      'add',
      '-q',
      '-b',
      'external-discovery',
      external,
    ]);
  });

  after(async () => {
    if ((await browser.tauri.listWindows()).includes('settings')) await returnToWorkspace();
    await browser.tauri.execute(async ({ core }) => core.invoke('reset_test_settings'));
    await browser.execute(() => {
      localStorage.clear();
      sessionStorage.removeItem('sail-e2e-settings');
    });
    execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', external]);
    rmSync(fixture, { recursive: true, force: true });
  });

  it('keeps external worktrees hidden until discovery is enabled', async () => {
    const selected = realpathSync(repository);
    const externalPath = realpathSync(external);
    await browser.tauri.execute(async ({ core }) => core.invoke('reset_test_settings'));
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem('sail-settings-migrated-v1', '1');
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    });
    await browser.tauri.execute(async ({ core }, path) => {
      await core.invoke('save_setting', { key: 'sai-directory', value: path });
      await core.invoke('save_setting', {
        key: 'sai-project-catalog',
        value: JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      });
    }, selected);
    await browser.refresh();
    await expect($(`.project-repository-select[title="${selected}"]`)).toBeDisplayed();
    await expect(externalWorktree()).not.toExist();

    await openSettings();
    const toggle = $('#worktree-autodiscovery');
    await expect(toggle).not.toBeChecked();
    await toggle.scrollIntoView();
    await toggle.click();
    await expect(toggle).toBeFocused();
    await expect(toggle).toBeChecked();
    await returnToWorkspace();

    await expect(externalWorktree()).toBeDisplayed();
    expect(await externalWorktree().getAttribute('title')).toBe(externalPath);
    await browser.waitUntil(
      async () =>
        (
          await browser.tauri.execute(async ({ core }) =>
            core.invoke<Record<string, string>>('load_settings'),
          )
        )[setting] === 'true',
      { timeoutMsg: 'The enabled worktree discovery setting was not saved' },
    );
    await browser.refresh();
    await expect(externalWorktree()).toBeDisplayed();

    await openSettings();
    await browser.setWindowSize(2560, 1440);
    const viewport = await browser.execute(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.width).toBe(2560);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    await forceAppearance('light', 'settings');
    await capture('worktree-autodiscovery-light-2560');
    await forceAppearance('dark', 'settings');
    await capture('worktree-autodiscovery-dark-2560');

    await browser.setWindowSize(1920, 1200);
    expect(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await browser.setWindowSize(390, 844);
    const narrow = await browser.execute(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    console.log(`Worktree discovery settings narrow viewport: ${narrow.width} px`);
    expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.width);

    await browser.execute(() => document.documentElement.style.setProperty('zoom', '2'));
    const enabledToggle = $('#worktree-autodiscovery');
    await enabledToggle.scrollIntoView();
    await browser.execute(() =>
      document.querySelector<HTMLInputElement>('#worktree-autodiscovery')?.focus(),
    );
    await expect(enabledToggle).toBeFocused();
    await enabledToggle.click();
    await expect(enabledToggle).not.toBeChecked();
    await browser.execute(() => document.documentElement.style.removeProperty('zoom'));
    await returnToWorkspace();

    await expect(externalWorktree()).not.toExist();
    await browser.waitUntil(
      async () =>
        (
          await browser.tauri.execute(async ({ core }) =>
            core.invoke<Record<string, string>>('load_settings'),
          )
        )[setting] === 'false',
      { timeoutMsg: 'The disabled worktree discovery setting was not saved' },
    );
    await browser.refresh();
    await expect(externalWorktree()).not.toExist();
  });
});

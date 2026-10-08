import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { returnToWorkspace, openSettings } from './settings-window';

const read = () =>
  browser.tauri.execute(async ({ core }) => core.invoke<Record<string, string>>('load_settings'));

describe('disk-backed settings', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-settings-'));
  const secondRepository = mkdtempSync(join(tmpdir(), 'sail-settings-second-'));

  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', secondRepository]);
    await browser.setWindowSize(1280, 850);
  });

  after(async () => {
    await browser.execute(() => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
    });
    rmSync(repository, { recursive: true, force: true });
    rmSync(secondRepository, { recursive: true, force: true });
  });

  it('migrates existing repositories and restores new preferences after reload', async () => {
    const path = realpathSync(repository);
    await browser.execute((selected) => {
      localStorage.clear();
      localStorage.setItem('sai-directory', selected);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [selected], groups: [] }),
      );
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    }, path);
    await browser.refresh();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
    await browser.waitUntil(async () => (await read())['sai-directory'] === path);
    expect(existsSync(join(process.env.SAIL_E2E_CONFIG_DIR!, 'settings.json'))).toBe(true);

    const other = realpathSync(secondRepository);
    await browser.execute((selected) => {
      localStorage.removeItem('sail-settings-migrated-v1');
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({
          repositories: [selected],
          groups: [{ id: 'second', name: 'Second', collapsed: false, repositories: [selected] }],
        }),
      );
    }, other);
    await browser.refresh();
    await expect($(`.project-repository-select[title="${other}"]`)).toBeDisplayed();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();

    await openSettings();
    await $('[aria-label^="Theme:"]').click();
    await $('.option-menu [role="option"]:nth-child(2)').click();
    await returnToWorkspace();
    try {
      await browser.waitUntil(async () => (await read())['sai-theme'] === 'dark');
    } catch (cause) {
      console.error('Settings theme sync diagnostic', {
        disk: await read(),
        main: await browser.execute(() => ({ theme: document.documentElement.dataset.suiTheme })),
      });
      throw cause;
    }
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const button = document.querySelector('.welcome-agents .sui-button');
          if (!button) return null;
          const style = getComputedStyle(button);
          return `${style.backgroundColor} ${style.color}`;
        })) === 'rgb(21, 26, 33) rgb(243, 246, 247)',
      {
        timeout: 5000,
        timeoutMsg: 'Secondary buttons kept light-theme colors after switching to dark',
      },
    );
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
    try {
      await browser.waitUntil(
        async () => (await browser.execute(() => localStorage.getItem('sai-theme'))) === 'dark',
      );
      expect(await browser.execute(() => localStorage.getItem('sai-directory'))).toBe(path);
      expect(await browser.execute(() => localStorage.getItem('sai-theme'))).toBe('dark');
    } catch (cause) {
      console.error('Settings reload diagnostic', {
        disk: await read(),
        browser: await browser.execute(() => ({
          directory: localStorage.getItem('sai-directory'),
          theme: localStorage.getItem('sai-theme'),
          enabled: sessionStorage.getItem('sail-e2e-settings'),
          keys: Object.keys(localStorage),
        })),
      });
      throw cause;
    }
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
    await expect($(`.project-repository-select[title="${other}"]`)).toBeDisplayed();
    expect(await browser.execute(() => document.documentElement.dataset.suiTheme)).toBe('dark');
  });

  it('opens one native settings window with the gear and Command comma', async () => {
    await openSettings();
    await expect($('.settings-window')).toBeDisplayed();
    await expect($('.settings-navigation button:nth-child(1)')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await $('.settings-navigation button:nth-child(3)').click();
    await expect($('.settings-navigation button:nth-child(3)')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect($('.settings-card')).toHaveText(expect.stringContaining('Detected agents'));
    await browser.tauri.switchWindow('main');
    await browser.keys(['Meta', ',']);
    expect(
      (await browser.tauri.listWindows()).filter((label) => label === 'settings'),
    ).toHaveLength(1);
    await browser.tauri.switchWindow('settings');
    await returnToWorkspace();
    await browser.keys(['Meta', ',']);
    await browser.waitUntil(async () => (await browser.tauri.listWindows()).includes('settings'));
    await browser.tauri.switchWindow('settings');
    await expect($('.settings-window')).toBeDisplayed();
    await returnToWorkspace();
  });
});

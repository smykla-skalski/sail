import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { returnToWorkspace, openSettings } from './settings-window';

const read = () =>
  browser.tauri.execute(async ({ core }) => core.invoke<Record<string, string>>('load_settings'));

/** Overrides the window's appearance, which WebKit reports as the OS color scheme. */
const forceAppearance = (theme: 'light' | 'dark' | null, label = 'main') =>
  browser.tauri.execute(
    async ({ core }, window, value) =>
      core.invoke('plugin:window|set_theme', { label: window, value }),
    label,
    theme,
  );

const shownTheme = () => browser.execute(() => document.documentElement.dataset.suiTheme);

async function expectTheme(theme: 'light' | 'dark') {
  await browser.waitUntil(async () => (await shownTheme()) === theme, {
    timeout: 5000,
    timeoutMsg: `Expected the ${theme} theme`,
  });
}

/** Saves an explicit choice, flips the OS appearance the other way, and checks it survives reload. */
async function expectStoredTheme(
  path: string,
  stored: 'light' | 'dark',
  appearance: 'light' | 'dark',
) {
  await browser.tauri.execute(
    async ({ core }, value) => core.invoke('save_setting', { key: 'sai-theme', value }),
    stored,
  );
  await forceAppearance(appearance);
  await browser.refresh();
  await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
  await expectTheme(stored);
  expect((await read())['sai-theme']).toBe(stored);
  expect(await browser.execute(() => localStorage.getItem('sai-theme'))).toBe(stored);
}

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

async function auditContextViewport(width: number, height: number, name: string) {
  await browser.setWindowSize(width, height);
  const viewport = await browser.execute(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  console.log(`Context viewport ${name}: ${viewport.width}×${viewport.height}`);
  await capture(`${viewport.width}x${viewport.height}-context-provider-${name}`);
  return viewport;
}

async function auditContextTheme(width: number, height: number, theme: 'light' | 'dark') {
  await forceAppearance(theme, 'settings');
  await expectTheme(theme);
  await auditContextViewport(width, height, theme);
}

describe('disk-backed settings', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-settings-'));
  const secondRepository = mkdtempSync(join(tmpdir(), 'sail-settings-second-'));
  const contextRepository = mkdtempSync(join(tmpdir(), 'sail-settings-context-'));

  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', secondRepository]);
    execFileSync('git', ['init', '-q', contextRepository]);
    await browser.setWindowSize(1280, 850);
  });

  after(async () => {
    await forceAppearance(null);
    await browser.execute(() => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
    });
    rmSync(repository, { recursive: true, force: true });
    rmSync(secondRepository, { recursive: true, force: true });
    rmSync(contextRepository, { recursive: true, force: true });
  });

  it('starts new profiles on System and keeps stored Light and Dark choices', async () => {
    const path = realpathSync(repository);
    await forceAppearance('dark');
    await browser.execute((selected) => {
      localStorage.clear();
      localStorage.setItem('sai-directory', selected);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [selected], groups: [] }),
      );
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    }, path);
    await browser.tauri.execute(async ({ core }) =>
      core.invoke('save_setting', { key: 'sai-theme', value: 'system' }),
    );
    await browser.refresh();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();
    await browser.waitUntil(async () => (await read())['sai-theme'] === 'system', {
      timeoutMsg: 'A new profile did not store the System theme',
    });
    await expectTheme('dark');

    await expectStoredTheme(path, 'light', 'dark');
    await expectStoredTheme(path, 'dark', 'light');
    await forceAppearance(null);
    await browser.tauri.execute(async ({ core }) =>
      core.invoke('save_setting', { key: 'sai-theme', value: 'light' }),
    );
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
    await $('.option-menu [role="option"]:nth-child(3)').click();
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

  it('follows the OS appearance live after choosing System', async () => {
    await forceAppearance('light');
    await openSettings();
    await $('[aria-label^="Theme:"]').click();
    await $('.option-menu [role="option"]:nth-child(1)').click();
    await expect($('[aria-label^="Theme:"]')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('System'),
    );
    await capture('settings-theme-system');
    await returnToWorkspace();
    await browser.waitUntil(async () => (await read())['sai-theme'] === 'system');
    await expectTheme('light');
    await capture('desktop-system-theme-light');
    await forceAppearance('dark');
    await expectTheme('dark');
    await capture('desktop-system-theme-dark');
    await forceAppearance('light');
    await expectTheme('light');
    await forceAppearance(null);
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

  it('guides first-time context setup', async () => {
    await browser.tauri.switchWindow('main');
    const path = realpathSync(contextRepository);
    execFileSync('git', [
      '-C',
      path,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'empty context fixture',
    ]);
    await browser.execute((selected) => {
      localStorage.setItem('sai-directory', selected);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [selected], groups: [] }),
      );
    }, path);
    await browser.tauri.execute(async ({ core }, selected) => {
      await core.invoke('save_setting', { key: 'sai-directory', value: selected });
      await core.invoke('save_setting', {
        key: 'sai-project-catalog',
        value: JSON.stringify({ repositories: [selected], groups: [] }),
      });
    }, path);
    await browser.refresh();
    await openSettings();
    await $('.settings-navigation nav button:nth-child(5)').click();
    await expect($('.settings-card')).toHaveText(
      expect.stringContaining('This project has no committed context provider selection.'),
    );
    await expect($('.settings-card')).toHaveText(
      expect.stringContaining('commit the configuration, then refresh this view'),
    );
    await expect($('button=Approve for this project')).not.toExist();
    await returnToWorkspace();
  });

  it('reviews a committed provider before approval and revokes it', async () => {
    await browser.tauri.switchWindow('main');
    if ((await browser.tauri.listWindows()).includes('settings')) {
      await browser.tauri.execute(async ({ core }) => {
        await core.invoke('plugin:window|close', { label: 'settings' });
      });
    }
    const path = realpathSync(contextRepository);
    const config = join(path, '.sail');
    const executable = join(path, 'fixture-provider');
    mkdirSync(config);
    writeFileSync(join(config, 'worktree.json'), '{"context":{"manifest":".sail/context.json"}}');
    writeFileSync(
      join(config, 'context.json'),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'project-files',
            type: 'stdio',
            command: 'fixture-provider',
            capabilities: ['search', 'get'],
          },
        ],
      }),
    );
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o700);
    execFileSync('git', ['-C', path, 'add', '.sail']);
    execFileSync('git', [
      '-C',
      path,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      'commit',
      '-qm',
      'context fixture',
    ]);
    await browser.execute((selected) => {
      localStorage.setItem('sai-directory', selected);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [selected], groups: [] }),
      );
    }, path);
    await browser.tauri.execute(async ({ core }, selected) => {
      await core.invoke('save_setting', { key: 'sai-directory', value: selected });
      await core.invoke('save_setting', {
        key: 'sai-project-catalog',
        value: JSON.stringify({ repositories: [selected], groups: [] }),
      });
    }, path);
    await browser.refresh();
    await expect($(`.project-repository-select[title="${path}"]`)).toBeDisplayed();

    await openSettings();
    await $('.settings-navigation nav button:nth-child(5)').click();
    await expect($('.context-provider-details')).toHaveText(
      expect.stringContaining('project-files'),
    );
    await expect($('.context-provider-details')).toHaveText(
      expect.stringContaining('Not selected'),
    );
    await expect($('.context-provider-details')).toHaveText(expect.stringContaining('Unavailable'));
    await expect($('.settings-card')).toHaveText(
      expect.stringContaining('Select an available executable for this registry command'),
    );
    await expect($('button=Approve for this project')).not.toExist();

    await $('#context-executable').setValue(executable);
    await $('button=Select executable').click();
    await expect($('.context-provider-details')).toHaveText(expect.stringContaining(executable));
    await expect($('.context-provider-details')).toHaveText(expect.stringContaining('search, get'));
    await expect($('button=Approve for this project')).toBeDisplayed();
    await auditContextTheme(2560, 1440, 'light');
    await auditContextTheme(2560, 1440, 'dark');
    await auditContextTheme(1920, 1200, 'light');
    await auditContextTheme(1920, 1200, 'dark');
    await auditContextViewport(390, 600, 'mobile');
    await browser.setWindowSize(1920, 1200);
    await browser.execute(() => (document.documentElement.style.zoom = '2'));
    await auditContextViewport(1920, 1200, 'zoom-200');
    await browser.execute(() => (document.documentElement.style.zoom = ''));
    await $('#context-executable').click();
    await browser.keys(['Tab']);
    await browser.keys(['Tab']);
    const approvalFocus = await browser.execute(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (item) => item.textContent?.trim() === 'Approve for this project',
      );
      if (!button) return null;
      const style = getComputedStyle(button);
      return {
        focused: document.activeElement === button,
        tabIndex: button.tabIndex,
        outline: style.outlineStyle,
        boxShadow: style.boxShadow,
      };
    });
    expect(approvalFocus?.focused).toBe(true);
    expect(approvalFocus?.tabIndex).toBeGreaterThanOrEqual(0);
    expect(approvalFocus?.outline !== 'none' || approvalFocus?.boxShadow !== 'none').toBe(true);
    await $('button=Approve for this project').click();
    await expect($('.context-provider-details')).toHaveText(expect.stringContaining('Approved'));
    expect(await $('.settings-card').getText()).toMatch(
      /It does not show live connection\s+health/,
    );

    writeFileSync(
      join(config, 'context.json'),
      '{"version":1,"providers":[{"id":"changed","type":"stdio","command":"fixture-provider","capabilities":["execute"]}]}',
    );
    await $('button=Refresh').click();
    await expect($('.context-provider-details')).toHaveText(expect.stringContaining('Approved'));

    await $('button=Revoke approval').click();
    await expect($('.context-provider-details')).toHaveText(
      expect.stringContaining('Approval required'),
    );
    await $('button=Approve for this project').click();
    await expect($('.context-provider-details')).toHaveText(expect.stringContaining('Approved'));
    writeFileSync(executable, '#!/bin/sh\nexit 1\n');
    await $('button=Refresh').click();
    await expect($('.context-provider-details')).toHaveText(
      expect.stringContaining('Approval required'),
    );
    writeFileSync(
      join(config, 'context.json'),
      '{"version":1,"providers":[{"id":"changed","type":"stdio","command":"fixture-provider","capabilities":["unknown"]}]}',
    );
    execFileSync('git', ['-C', path, 'add', '.sail/context.json']);
    execFileSync('git', [
      '-C',
      path,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      'commit',
      '-qm',
      'invalid context fixture',
    ]);
    await $('button=Refresh').click();
    await expect($('.settings-card')).toHaveText(
      expect.stringContaining('Fix and commit the project context configuration'),
    );
    await expect($('button=Approve for this project')).not.toExist();
    await returnToWorkspace();
  });
});

import { browser, $, expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openSettings, returnToWorkspace } from './settings-window';

const cardSelector =
  "//section[contains(@class,'settings-card')][.//h2[normalize-space()='Reef canary']]";

async function chooseTheme(theme: 'light' | 'dark') {
  await $('button=General').click();
  await $('[aria-label^="Theme:"]').click();
  await $(`.option-menu [role="option"]:nth-child(${theme === 'light' ? 2 : 3})`).click();
  await $('button=Agents').click();
  await browser.waitUntil(
    async () => (await browser.execute(() => document.documentElement.dataset.suiTheme)) === theme,
  );
}

async function captureViewport(theme: 'light' | 'dark', width: number, height: number) {
  await browser.setWindowSize(width, height);
  const actual = await browser.execute(() => ({ width: innerWidth, height: innerHeight }));
  expect(actual.width).toBeGreaterThan(0);
  expect(actual.height).toBeGreaterThan(0);
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (output) {
    mkdirSync(output, { recursive: true });
    await browser.saveScreenshot(
      join(output, `reef-canary-${theme}-${actual.width}x${actual.height}.png`),
    );
  }
}

async function captureTheme(theme: 'light' | 'dark') {
  await chooseTheme(theme);
  await captureViewport(theme, 2560, 1440);
  await captureViewport(theme, 1920, 1200);
}

describe('Reef canary settings', () => {
  before(async () => {
    if ((await browser.tauri.listWindows()).includes('settings')) await returnToWorkspace();
    await openSettings();
    await $('button=Agents').click();
  });

  after(async () => {
    const card = await $(cardSelector);
    const toggle = await card.$('input[type="checkbox"]');
    if (await toggle.isSelected()) await toggle.click();
    await chooseTheme('light');
    await returnToWorkspace();
  });

  it('defaults off, persists a zero-percent control, and fits narrow and large windows', async () => {
    const card = await $(cardSelector);
    const toggle = await card.$('input[type="checkbox"]');
    await expect(toggle).not.toBeSelected();
    await expect($('#reef-canary-percent')).not.toExist();

    await toggle.click();
    await expect($('#reef-canary-percent')).toHaveValue('10');
    await browser.execute(() => {
      const input = document.getElementById('reef-canary-percent');
      if (!(input instanceof HTMLInputElement)) throw new Error('Missing Reef canary input');
      input.value = '0';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect($('#reef-canary-percent')).toHaveValue('0');

    await returnToWorkspace();
    await browser.execute(() => sessionStorage.setItem('sail-e2e-settings', 'enabled'));
    await browser.refresh();
    await $('[aria-label="Settings"]').waitForDisplayed();
    await openSettings();
    await $('button=Agents').click();
    await expect($(cardSelector).$('input[type="checkbox"]')).toBeSelected();
    await expect($('#reef-canary-percent')).toHaveValue('0');

    await captureTheme('light');
    await captureTheme('dark');
    await browser.setWindowSize(390, 700);
    const overflow = await browser.execute(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await expect($('#reef-canary-percent')).toBeDisplayed();
  });
});

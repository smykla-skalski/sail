import { browser, $, expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openSettings, returnToWorkspace } from './settings-window';

async function chooseTheme(theme: 'light' | 'dark') {
  await $('button=General').click();
  await $('[aria-label^="Theme:"]').click();
  await $(`.option-menu [role="option"]:nth-child(${theme === 'light' ? 2 : 3})`).click();
  await $('button=Agents').click();
  await browser.waitUntil(
    async () => (await browser.execute(() => document.documentElement.dataset.suiTheme)) === theme,
  );
}

async function setLimit(kind: 'agent' | 'browser' | 'e2e', value: number) {
  const input = await $(`#resource-limit-${kind}`);
  await browser.execute(
    (id, nextValue) => {
      const element = document.getElementById(id);
      if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input ${id}`);
      element.value = String(nextValue);
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    `resource-limit-${kind}`,
    value,
  );
  await expect(input).toHaveValue(String(value));
}

async function captureViewport(
  theme: 'light' | 'dark',
  width: number,
  height: number,
  output: string | undefined,
) {
  await browser.setWindowSize(width, height);
  const actual = await browser.execute(() => innerWidth);
  expect(actual).toBeGreaterThan(0);
  if (output) {
    mkdirSync(output, { recursive: true });
    await browser.saveScreenshot(
      join(output, `resource-settings-${theme}-${actual}x${height}.png`),
    );
  }
}

async function captureTheme(theme: 'light' | 'dark', output: string | undefined) {
  await chooseTheme(theme);
  await captureViewport(theme, 2560, 1440, output);
  await captureViewport(theme, 1920, 1200, output);
}

describe('concurrent job settings', () => {
  before(async () => {
    if ((await browser.tauri.listWindows()).includes('settings')) {
      await returnToWorkspace();
    }
    await openSettings();
    await $('button=Agents').click();
  });

  after(async () => {
    await setLimit('agent', 4);
    await setLimit('browser', 2);
    await setLimit('e2e', 1);
    await chooseTheme('light');
    await returnToWorkspace();
  });

  it('saves each limit and keeps the settings view usable at large and narrow sizes', async () => {
    await setLimit('agent', 0);
    await setLimit('browser', 3);
    await setLimit('e2e', 2);
    await returnToWorkspace();
    await openSettings();
    await $('button=Agents').click();
    await expect($('#resource-limit-agent')).toHaveValue('0');
    await expect($('#resource-limit-browser')).toHaveValue('3');
    await expect($('#resource-limit-e2e')).toHaveValue('2');
    const output = process.env.SAIL_VISUAL_AUDIT_DIR;
    await captureTheme('light', output);
    await captureTheme('dark', output);
    await browser.setWindowSize(390, 700);
    const overflow = await browser.execute(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await expect($('#resource-limit-e2e')).toBeDisplayed();
  });
});

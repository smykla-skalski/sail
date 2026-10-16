import assert from 'node:assert/strict';
import { browser, $, expect } from '@wdio/globals';
import { nativeTab } from './native-keyboard';
import { openSettings, returnToWorkspace } from './settings-window';

describe('selected WebDriver command behavior', () => {
  it('keeps returned error properties as data', async () => {
    const data = { error: 'Fixture paused', stacktrace: 'ordinary data', success: false };
    expect(await browser.execute((value) => value, data)).toEqual(data);
    expect(await browser.execute(async (value) => value, data)).toEqual(data);
    expect(await browser.execute('return {error: arguments[0]}', 'string body')).toEqual({
      error: 'string body',
    });
    await assert.rejects(
      browser.execute(() => {
        throw new Error('genuine script failure');
      }),
      /genuine script failure/,
    );
    await assert.rejects(
      browser.execute(async () => {
        throw new Error('genuine promise failure');
      }),
      /genuine promise failure/,
    );
  });

  it('resets main fixtures while Settings remains selected', async () => {
    await openSettings();
    await expect($('.settings-window')).toBeDisplayed();
    // The config's afterTest and next beforeTest must reset main without changing this selection.
  });

  it('preserves Settings selection and its main-command permission boundary', async () => {
    await expect($('.settings-window')).toBeDisplayed();
    const denied = await browser.execute(async () => {
      const tauri: unknown = Reflect.get(window, '__TAURI__');
      const core: unknown = tauri && typeof tauri === 'object' ? Reflect.get(tauri, 'core') : null;
      const invoke: unknown = core && typeof core === 'object' ? Reflect.get(core, 'invoke') : null;
      if (typeof invoke !== 'function') throw new Error('Missing Tauri API');
      try {
        await invoke('acp_pending_inbox');
        return '';
      } catch (error) {
        return String(error);
      }
    });
    expect(denied).toContain('not allowed on window "settings"');
    await returnToWorkspace();
  });

  it('traverses native Tab and Shift+Tab and honors cancelled key events', async () => {
    await browser.execute(() => {
      const fixture = document.createElement('div');
      fixture.id = 'native-tab-fixture';
      fixture.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:white';
      fixture.innerHTML =
        '<input id="native-tab-first"><input disabled><input hidden><input id="native-tab-last">';
      document.body.append(fixture);
      document.getElementById('native-tab-first')?.focus();
    });
    try {
      await nativeTab();
      await expect($('#native-tab-last')).toBeFocused();
      expect(await browser.execute(() => document.activeElement?.matches(':focus-visible'))).toBe(
        true,
      );
      await nativeTab(true);
      await expect($('#native-tab-first')).toBeFocused();
      await browser.execute(() => {
        document.getElementById('native-tab-first')?.addEventListener(
          'keydown',
          (event) => {
            if (event.key === 'Tab') event.preventDefault();
          },
          { once: true },
        );
      });
      await nativeTab();
      await expect($('#native-tab-first')).toBeFocused();
    } finally {
      await browser.execute(() => document.getElementById('native-tab-fixture')?.remove());
    }
  });
});

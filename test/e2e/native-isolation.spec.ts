import { browser, $, expect } from '@wdio/globals';
import process from 'node:process';
import { openSettings, returnToWorkspace } from './settings-window';

describe('native runner isolation', () => {
  it('uses clean private state and navigates both native webviews', async () => {
    await browser.tauri.switchWindow('main');
    await expect($('[aria-label="Settings"]')).toBeDisplayed();
    const previous = await browser.execute(() => localStorage.getItem('sai-native-run-sentinel'));
    expect(previous).toBeNull();
    await openSettings();
    await expect($('.settings-window')).toBeDisplayed();
    await returnToWorkspace();
    await browser.execute((runId) => {
      localStorage.setItem('sai-native-run-sentinel', runId);
    }, process.env.SAIL_NATIVE_RUN_ID ?? 'direct-e2e');
    await browser.tauri.execute(async ({ core }, runId) => {
      await core.invoke('save_setting', { key: 'sai-native-run-sentinel', value: runId });
      const persisted = await core.invoke<Record<string, unknown>>('load_settings');
      if (persisted['sai-native-run-sentinel'] !== runId)
        throw new Error('Native fixture settings were not persisted');
    }, process.env.SAIL_NATIVE_RUN_ID ?? 'direct-e2e');
  });
});

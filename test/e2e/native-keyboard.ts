import { browser } from '@wdio/globals';

export async function nativeTab(reverse = false): Promise<void> {
  await browser.execute(async (backwards) => {
    const tauri: unknown = Reflect.get(window, '__TAURI__');
    const core: unknown = tauri && typeof tauri === 'object' ? Reflect.get(tauri, 'core') : null;
    const invoke: unknown = core && typeof core === 'object' ? Reflect.get(core, 'invoke') : null;
    if (typeof invoke !== 'function') throw new Error('Tauri API missing for native Tab');
    await invoke('send_test_tab', { reverse: backwards });
  }, reverse);
}

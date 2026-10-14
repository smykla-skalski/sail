import { browser } from '@wdio/globals';
import { BaseDirectory } from '@tauri-apps/api/path';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { openSettings, returnToWorkspace } from './settings-window';

export async function assertNativeWebviews() {
  const temporary = realpathSync(process.env.TMPDIR);
  await browser.tauri.switchWindow('main');
  const check = async (label: string) => {
    const actual = await browser.tauri.execute(
      async ({ core }, expected, temporaryDirectory) => {
        if ((new URL(location.href).searchParams.get('window') ?? 'main') !== expected)
          throw new Error(`Native precondition: wrong webview for ${expected}`);
        await core.invoke('plugin:wdio|list_windows');
        const visible = await core.invoke('plugin:window|is_visible', { label: expected });
        if (!visible) throw new Error(`Native precondition: ${expected} is hidden`);
        return core.invoke<string>('plugin:path|resolve_directory', {
          directory: temporaryDirectory,
        });
      },
      label,
      BaseDirectory.Temp,
    );
    if (realpathSync(actual) !== temporary)
      throw new Error(`Native precondition: ${label} temporary directory mismatch`);
  };
  await check('main');
  await openSettings();
  await check('settings');
  await returnToWorkspace();
}

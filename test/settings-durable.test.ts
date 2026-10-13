import assert from 'node:assert/strict';
import test from 'node:test';
import { getSetting, initializeSettings, commitSetting } from '../src/lib/settings.ts';

await test('durable settings publish only after storage succeeds and preserve the previous value on failure', async () => {
  const local = new Map<string, string>([['sail-settings-migrated-v1', '1']]);
  let fail = false;
  let release!: () => void;
  let diskValue = 'previous';
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { value: string }) => {
          if (command === 'load_settings') return { 'sai-session-tasks': diskValue };
          if (command !== 'save_setting') throw new Error(`Unexpected command: ${command}`);
          if (fail) throw new Error('disk full');
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          diskValue = args.value;
          return undefined;
        },
      },
    },
  });
  await initializeSettings();
  const pending = commitSetting('sai-session-tasks', 'next');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getSetting('sai-session-tasks'), 'previous');
  assert.equal(local.get('sai-session-tasks'), 'previous');
  release();
  await pending;
  assert.equal(getSetting('sai-session-tasks'), 'next');
  assert.equal(diskValue, 'next');

  fail = true;
  await assert.rejects(commitSetting('sai-session-tasks', 'rejected'), /disk full/);
  assert.equal(getSetting('sai-session-tasks'), 'next');
  assert.equal(local.get('sai-session-tasks'), 'next');
  assert.equal(diskValue, 'next');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commitSetting,
  getSetting,
  initializeSettings,
  setSettingDurable,
} from '../src/lib/settings.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const globals = ['isTauri', 'window', 'localStorage'] as const;

function restoreGlobals(originals: (PropertyDescriptor | undefined)[]): void {
  globals.forEach((key, index) => {
    const original = originals[index];
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  });
}

await test('a durable catalog retry persists the same value after a failed write', async () => {
  const storage = new MemoryStorage();
  storage.setItem('sail-settings-migrated-v1', '1');
  const writes: string[] = [];
  let fail = true;
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { key: string; value: string }) => {
          if (command === 'load_settings') return {};
          if (command !== 'save_setting' || !args)
            throw new Error(`Unexpected settings command: ${command}`);
          writes.push(`${args.key}:${args.value}`);
          if (fail) {
            fail = false;
            throw new Error('disk write failed');
          }
          return undefined;
        },
      },
    },
  });

  try {
    await initializeSettings();
    await assert.rejects(setSettingDurable('sai-project-catalog', 'pending'), /disk write failed/);
    await setSettingDurable('sai-project-catalog', 'pending');
    assert.deepEqual(writes, ['sai-project-catalog:pending', 'sai-project-catalog:pending']);
    assert.equal(storage.getItem('sai-project-catalog'), 'pending');
  } finally {
    restoreGlobals(originals);
  }
});

await test('durable settings publish only after storage succeeds and preserve the previous value on failure', async () => {
  const storage = new MemoryStorage();
  storage.setItem('sail-settings-migrated-v1', '1');
  let fail = false;
  let release!: () => void;
  let diskValue = 'previous';
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { value: string }) => {
          if (command === 'load_settings') return { 'sai-session-tasks': diskValue };
          if (command !== 'save_setting' || !args)
            throw new Error(`Unexpected command: ${command}`);
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

  try {
    await initializeSettings();
    const pending = commitSetting('sai-session-tasks', 'next');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getSetting('sai-session-tasks'), 'previous');
    assert.equal(storage.getItem('sai-session-tasks'), 'previous');
    release();
    await pending;
    assert.equal(getSetting('sai-session-tasks'), 'next');
    assert.equal(diskValue, 'next');

    fail = true;
    await assert.rejects(commitSetting('sai-session-tasks', 'rejected'), /disk full/);
    assert.equal(getSetting('sai-session-tasks'), 'next');
    assert.equal(storage.getItem('sai-session-tasks'), 'next');
    assert.equal(diskValue, 'next');
  } finally {
    restoreGlobals(originals);
  }
});

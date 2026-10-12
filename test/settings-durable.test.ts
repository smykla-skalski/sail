import assert from 'node:assert/strict';
import { test } from 'node:test';

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

void test('a durable catalog retry persists the same value after a failed write', async () => {
  const storage = new MemoryStorage();
  storage.setItem('sail-settings-migrated-v1', '1');
  const writes: string[] = [];
  let fail = true;
  const globals = ['isTauri', 'window', 'localStorage'] as const;
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
    const { initializeSettings, setSettingDurable } = await import('../src/lib/settings.ts');
    await initializeSettings();
    await assert.rejects(setSettingDurable('sai-project-catalog', 'pending'), /disk write failed/);
    await setSettingDurable('sai-project-catalog', 'pending');
    assert.deepEqual(writes, ['sai-project-catalog:pending', 'sai-project-catalog:pending']);
    assert.equal(storage.getItem('sai-project-catalog'), 'pending');
  } finally {
    globals.forEach((key, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

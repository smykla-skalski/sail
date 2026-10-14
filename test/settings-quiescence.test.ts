import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getSetting,
  initializeSettings,
  quiesceSettingsWrites,
  removeSetting,
  setSetting,
  setSettingDurable,
  trackSettingsMutation,
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

void test('quiescence rejects a settings load that finishes after its write barrier', async () => {
  const storage = new MemoryStorage();
  storage.setItem('sail-settings-migrated-v1', '1');
  const commands: string[] = [];
  let resolveLoad!: (settings: Record<string, string>) => void;
  const loading = new Promise<Record<string, string>>((resolve) => {
    resolveLoad = resolve;
  });
  const globals = ['isTauri', 'window', 'localStorage'] as const;
  const original = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          commands.push(command);
          if (command === 'load_settings') return loading;
          if (command === 'save_setting') return Promise.resolve();
          throw new Error(`Unexpected settings command: ${command}`);
        },
      },
    },
  });

  try {
    const initializing = initializeSettings();
    assert.deepEqual(commands, ['load_settings']);
    let releaseMutation!: () => void;
    const mutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    void trackSettingsMutation(() => mutation);
    let quiesced = false;
    const quiescing = (async () => {
      await quiesceSettingsWrites();
      quiesced = true;
    })();
    await Promise.resolve();
    assert.equal(quiesced, false);
    releaseMutation();
    await mutation;
    await Promise.resolve();
    assert.equal(quiesced, false);
    resolveLoad({ 'sai-quiescence-probe': 'stale' });
    await quiescing;
    await initializing;

    assert.equal(getSetting('sai-quiescence-probe'), null);
    storage.clear(); // The second E2E reset phase clears browser storage before native reset.
    const staleShipRefresh = Promise.resolve().then(() =>
      setSettingDurable('sai-ship-runs', 'stale run'),
    );
    await assert.rejects(staleShipRefresh, /quiesced/);
    assert.equal(storage.getItem('sai-ship-runs'), null);
    setSetting('sai-quiescence-probe', 'new');
    assert.equal(storage.getItem('sai-quiescence-probe'), null);
    storage.setItem('sai-quiescence-probe', 'current');
    removeSetting('sai-quiescence-probe');
    assert.equal(storage.getItem('sai-quiescence-probe'), 'current');
    await Promise.resolve();
    assert.deepEqual(commands, ['load_settings']);
    let invoked = false;
    await assert.rejects(
      trackSettingsMutation(() => {
        invoked = true;
        return Promise.resolve();
      }),
      /quiesced/,
    );
    assert.equal(invoked, false);
  } finally {
    globals.forEach((key, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  flushTranscriptWrite,
  getSetting,
  initializeSettings,
  quiesceSettingsWrites,
  setTranscriptSetting,
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

void test('unfinished transcript writes survive restart and overlapping native acknowledgements', async () => {
  const transcriptKey = 'sai-agent-transcript-cache';
  const pendingKey = 'sail-transcript-cache-pending-v1';
  const storage = new MemoryStorage();
  storage.setItem('sail-settings-migrated-v1', '1');
  storage.setItem(transcriptKey, 'newer local transcript');
  storage.setItem(pendingKey, '1');

  const saves: Array<{ value: string; resolve: () => void }> = [];
  const globals = ['isTauri', 'window', 'localStorage'] as const;
  const original = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: { value: string }) => {
          if (command === 'load_settings')
            return Promise.resolve({ [transcriptKey]: 'older native transcript' });
          if (command === 'save_setting')
            return new Promise<void>((resolve) =>
              saves.push({ value: args?.value ?? '', resolve }),
            );
          throw new Error(`Unexpected settings command: ${command}`);
        },
      },
    },
  });

  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await initializeSettings();
    assert.equal(getSetting(transcriptKey), 'newer local transcript');
    assert.equal(storage.getItem(transcriptKey), 'newer local transcript');
    await Promise.resolve();
    assert.equal(saves[0]?.value, 'newer local transcript');
    assert.equal(storage.getItem(pendingKey), '1');

    saves[0].resolve();
    await new Promise(setImmediate);
    assert.equal(storage.getItem(pendingKey), null);

    setTranscriptSetting('repeated transcript');
    setTranscriptSetting('intermediate transcript');
    setTranscriptSetting('repeated transcript');
    const latestToken = storage.getItem(pendingKey);
    assert.ok(latestToken);
    await new Promise(setImmediate);
    assert.equal(saves.length, 1, 'a second transcript write inside the interval is deferred');
    assert.equal(getSetting(transcriptKey), 'repeated transcript');
    mock.timers.tick(10_000);
    await new Promise(setImmediate);
    assert.equal(saves.length, 2, 'queued writes collapse into the newest transcript');
    assert.equal(saves[1]?.value, 'repeated transcript');
    assert.equal(storage.getItem(pendingKey), latestToken);
    saves[1].resolve();
    await new Promise(setImmediate);
    assert.equal(storage.getItem(pendingKey), null);

    setTranscriptSetting('other window is active');
    storage.setItem(pendingKey, 'newer-window-token');
    mock.timers.tick(10_000);
    await new Promise(setImmediate);
    assert.equal(saves[2]?.value, 'other window is active');
    saves[2].resolve();
    await new Promise(setImmediate);
    assert.equal(storage.getItem(pendingKey), 'newer-window-token');
    setTranscriptSetting('flushed on demand');
    flushTranscriptWrite();
    await new Promise(setImmediate);
    assert.equal(saves[3]?.value, 'flushed on demand');
    saves[3].resolve();
    await quiesceSettingsWrites();
  } finally {
    mock.timers.reset();
    for (const save of saves) save.resolve();
    globals.forEach((key, index) => {
      const descriptor = original[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

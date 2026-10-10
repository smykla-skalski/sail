import { invoke, isTauri } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';

export const settingsError = writable('');
const migrationKey = 'sail-settings-migrated-v1';

export function isSetting(key: string): boolean {
  return (
    (key.startsWith('sai-') && !key.startsWith('sai-e2e-')) ||
    key === 'sai-e2e-job-limit' ||
    key === 'sail-agent-threads'
  );
}

function snapshot(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(localStorage)
      .filter(isSetting)
      .map((key) => [key, localStorage.getItem(key)!]),
  );
}

let ready = false;
let e2eSettingsDisabled = false;
let values: Record<string, string> = {};
let writes = Promise.resolve();

export async function initializeSettings(): Promise<void> {
  if (!isTauri()) return;
  e2eSettingsDisabled =
    import.meta.env.MODE === 'e2e' && sessionStorage.getItem('sail-e2e-settings') !== 'enabled';
  if (e2eSettingsDisabled) return;
  try {
    const saved =
      localStorage.getItem(migrationKey) === '1'
        ? await invoke<Record<string, string>>('load_settings')
        : await invoke<Record<string, string>>('migrate_settings', {
            legacy: snapshot(),
            preferLegacy: location.protocol === 'tauri:' || location.hostname === 'tauri.localhost',
          });
    values = Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, string] => isSetting(entry[0]) && typeof entry[1] === 'string',
      ),
    );
    for (const key of Object.keys(localStorage).filter(isSetting)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    localStorage.setItem(migrationKey, '1');
    ready = true;
  } catch (cause) {
    settingsError.set(`Could not load Sail settings: ${String(cause)}`);
  }
}

function persist(key: string, value: string | null): void {
  if (!ready) return;
  writes = writes.catch(() => undefined).then(() => invoke<void>('save_setting', { key, value }));
  void writes.catch((cause: unknown) =>
    settingsError.set(`Could not save Sail settings: ${String(cause)}`),
  );
}

export function settingKeys(): string[] {
  return Object.keys(localStorage).filter(isSetting);
}

export function getSetting(key: string): string | null {
  return ready ? (values[key] ?? null) : localStorage.getItem(key);
}

export function setSetting(key: string, value: string): void {
  localStorage.setItem(key, value);
  if (ready && values[key] === value) return;
  if (ready) values[key] = value;
  persist(key, value);
}

export async function setSettingDurable(key: string, value: string): Promise<void> {
  if (isTauri() && !ready && !e2eSettingsDisabled)
    throw new Error('Sail settings are unavailable.');
  setSetting(key, value);
  await writes;
}

export function removeSetting(key: string): void {
  localStorage.removeItem(key);
  if (ready && !(key in values)) return;
  if (ready) delete values[key];
  persist(key, null);
}

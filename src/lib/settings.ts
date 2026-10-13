import { invoke, isTauri } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';

export const settingsError = writable('');
const migrationKey = 'sail-settings-migrated-v1';
const transcriptKey = 'sai-agent-transcript-cache';
const transcriptPendingKey = 'sail-transcript-cache-pending-v1';

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
const pendingLoads = new Set<Promise<unknown>>();
const pendingMutations = new Set<Promise<unknown>>();
let e2eQuiesced = false;

export async function quiesceSettingsWrites(): Promise<void> {
  e2eQuiesced = true;
  ready = false;
  e2eSettingsDisabled = true;
  const settled = await Promise.allSettled([...pendingLoads, ...pendingMutations, writes]);
  const persisted = settled.at(-1);
  if (persisted?.status === 'rejected') throw persisted.reason;
}

export function trackSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (e2eQuiesced) return Promise.reject(new Error('E2E settings writes are quiesced'));
  const pending = operation();
  pendingMutations.add(pending);
  void pending.finally(() => pendingMutations.delete(pending)).catch(() => undefined);
  return pending;
}

if (typeof window !== 'undefined' && import.meta.env?.MODE === 'e2e')
  Reflect.set(window, '__SAIL_E2E_QUIESCE_SETTINGS__', quiesceSettingsWrites);

export async function initializeSettings(): Promise<void> {
  if (e2eQuiesced) return;
  if (!isTauri()) return;
  e2eSettingsDisabled =
    import.meta.env?.MODE === 'e2e' && sessionStorage.getItem('sail-e2e-settings') !== 'enabled';
  if (e2eSettingsDisabled) return;
  try {
    const loading =
      localStorage.getItem(migrationKey) === '1'
        ? invoke<Record<string, string>>('load_settings')
        : invoke<Record<string, string>>('migrate_settings', {
            legacy: snapshot(),
            preferLegacy: location.protocol === 'tauri:' || location.hostname === 'tauri.localhost',
          });
    pendingLoads.add(loading);
    const saved = await loading.finally(() => pendingLoads.delete(loading));
    if (e2eQuiesced) return;
    const pendingToken = localStorage.getItem(transcriptPendingKey);
    const pendingTranscript = pendingToken === null ? null : localStorage.getItem(transcriptKey);
    values = Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, string] => isSetting(entry[0]) && typeof entry[1] === 'string',
      ),
    );
    if (pendingTranscript !== null) values[transcriptKey] = pendingTranscript;
    for (const key of Object.keys(localStorage).filter(isSetting)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    localStorage.setItem(migrationKey, '1');
    ready = true;
    if (pendingTranscript !== null && pendingToken !== null) {
      persist(transcriptKey, pendingTranscript);
      clearTranscriptPendingAfterWrite(pendingToken);
    }
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

function clearTranscriptPendingAfterWrite(token: string): void {
  const write = writes;
  void write
    .then(() => {
      if (localStorage.getItem(transcriptPendingKey) === token)
        localStorage.removeItem(transcriptPendingKey);
      return undefined;
    })
    .catch(() => undefined);
}

export function settingKeys(): string[] {
  return Object.keys(localStorage).filter(isSetting);
}

export function getSetting(key: string): string | null {
  return ready ? (values[key] ?? null) : localStorage.getItem(key);
}

export function setSetting(key: string, value: string): void {
  if (e2eQuiesced) return;
  localStorage.setItem(key, value);
  if (ready && values[key] === value) return;
  if (ready) values[key] = value;
  persist(key, value);
}

export function setTranscriptSetting(value: string): void {
  if (e2eQuiesced) return;
  setSetting(transcriptKey, value);
  const token = crypto.randomUUID();
  localStorage.setItem(transcriptPendingKey, token);
  if (ready) clearTranscriptPendingAfterWrite(token);
}

export async function setSettingDurable(key: string, value: string): Promise<void> {
  if (e2eQuiesced) throw new Error('E2E settings writes are quiesced');
  if (isTauri() && !ready && !e2eSettingsDisabled)
    throw new Error('Sail settings are unavailable.');
  setSetting(key, value);
  await writes;
}

export async function commitSetting(key: string, value: string): Promise<void> {
  if (e2eQuiesced) throw new Error('E2E settings writes are quiesced');
  if (isTauri() && !ready && !e2eSettingsDisabled)
    throw new Error('Sail settings are unavailable.');
  const nativeWrite = ready;
  const mutation = writes
    .catch(() => undefined)
    .then(async () => {
      if (nativeWrite) {
        await invoke<void>('save_setting', { key, value });
        if (!e2eQuiesced) {
          values[key] = value;
          try {
            localStorage.setItem(key, value);
          } catch (cause) {
            settingsError.set(`Could not mirror Sail settings: ${String(cause)}`);
          }
        }
      } else if (!e2eQuiesced) localStorage.setItem(key, value);
      return undefined;
    });
  writes = mutation;
  await mutation;
}

export function removeSetting(key: string): void {
  if (e2eQuiesced) return;
  localStorage.removeItem(key);
  if (ready && !(key in values)) return;
  if (ready) delete values[key];
  persist(key, null);
}

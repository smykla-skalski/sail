import type { AgentEntry } from './acp.ts';
import { acpSessionOwner } from './session-identity.ts';

const databaseName = 'sail-owned-transcripts';
const storeName = 'threads';
const pending = new Map<string, Promise<void>>();
const snapshots = new Map<string, AgentEntry[]>();
let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener('upgradeneeded', () => request.result.createObjectStore(storeName));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () =>
      reject(request.error ?? new Error('Could not open transcript storage.')),
    );
  }).catch((error: unknown): never => {
    database = null;
    throw error;
  });
  database = opening;
  return opening;
}

function transaction(
  key: string,
  mode: IDBTransactionMode,
  value?: AgentEntry[],
): Promise<AgentEntry[]> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const operation = db.transaction(storeName, mode);
        const store = operation.objectStore(storeName);
        const request =
          mode === 'readonly' ? store.get(key) : value ? store.put(value, key) : store.delete(key);
        let result: AgentEntry[] = [];
        request.addEventListener('success', () => {
          if (mode === 'readonly' && Array.isArray(request.result)) result = request.result;
        });
        operation.addEventListener('complete', () => resolve(result));
        operation.addEventListener('error', () =>
          reject(operation.error ?? new Error('Transcript storage failed.')),
        );
        operation.addEventListener('abort', () =>
          reject(operation.error ?? new Error('Transcript storage was aborted.')),
        );
      }),
  );
}

export function ownedTranscriptKey(agent: string, directory: string, sessionId: string): string {
  return JSON.stringify([agent, directory, sessionId]);
}

export function saveOwnedTranscript(key: string, entries: AgentEntry[]): void {
  const snapshot = entries.slice();
  void updateOwnedTranscript(key, (saved) =>
    snapshot.length >= saved.length ? snapshot : saved,
  ).catch(() => undefined);
}

/** Serialize changes per thread and keep failed writes in memory for the next attempt. */
export function updateOwnedTranscript(
  key: string,
  update: (entries: AgentEntry[]) => AgentEntry[],
): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  const previous = pending.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      const saved = snapshots.get(key) ?? (await transaction(key, 'readonly'));
      const entries = update(saved.slice());
      snapshots.set(key, entries);
      await transaction(key, 'readwrite', entries);
      snapshots.delete(key);
      return undefined;
    });
  pending.set(key, write);
  return write;
}

export async function loadOwnedTranscript(key: string): Promise<AgentEntry[]> {
  if (typeof indexedDB === 'undefined') return [];
  await pending.get(key);
  return snapshots.get(key)?.slice() ?? transaction(key, 'readonly');
}

export async function flushOwnedTranscriptWrites(owner: string): Promise<void> {
  await Promise.all(
    [...pending.entries()]
      .filter(([key]) => {
        try {
          const identity: unknown = JSON.parse(key);
          return (
            Array.isArray(identity) &&
            typeof identity[2] === 'string' &&
            acpSessionOwner(identity[2]) === owner
          );
        } catch {
          return false;
        }
      })
      .map(([, write]) => write),
  );
}

export function forgetOwnedTranscript(key: string): void {
  if (typeof indexedDB === 'undefined') return;
  const previous = pending.get(key) ?? Promise.resolve();
  const removal = previous
    .catch(() => undefined)
    .then(async () => {
      await transaction(key, 'readwrite');
      snapshots.delete(key);
      return undefined;
    });
  pending.set(key, removal);
  void removal.catch(() => undefined);
}

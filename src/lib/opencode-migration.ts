/** One-time move of saved native OpenCode references to the ACP `acp:opencode:<id>` form. */
export type SettingsPort = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
};

export const openCodeMigrationKey = 'sai-opencode-acp-migrated';

import { acpThreadId } from './thread-id.ts';

const legacyPrefix = 'opencode:';
const acpPrefix = 'acp:opencode:';
const sessionPrefix = 'sai-session:';
const emptyMainPrefix = 'sai-main-pane-empty:';
const threadsKey = 'sail-agent-threads';

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** Rewrites the `opencode:` segment of a `directory\0…\0opencode:<id>` key. */
export function acpScopeKey(key: string): string {
  return key.includes('\0') ? key.split('\0').map(acpThreadId).join('\0') : acpThreadId(key);
}

function parse(port: SettingsPort, key: string): unknown {
  const raw = port.get(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function write(port: SettingsPort, key: string, before: string | null, value: unknown): void {
  const next = JSON.stringify(value);
  if (next !== before) port.set(key, next);
}

function mapStringField(item: unknown, field: string): unknown {
  const value = record(item);
  if (!value || typeof value[field] !== 'string') return item;
  return { ...value, [field]: acpThreadId(value[field]) };
}

function mapArray(port: SettingsPort, key: string, map: (item: unknown) => unknown): void {
  const parsed = parse(port, key);
  if (!Array.isArray(parsed)) return;
  write(port, key, port.get(key), parsed.map(map));
}

function validNativeThread(item: unknown): item is Json {
  const value = record(item);
  return (
    !!value &&
    value.agent === 'opencode' &&
    typeof value.directory === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.updated === 'number'
  );
}

function sameThread(a: Json, b: Json): boolean {
  return a.agent === b.agent && a.directory === b.directory && a.sessionId === b.sessionId;
}

function bareSessionId(value: string): string {
  return value.startsWith(acpPrefix)
    ? value.slice(acpPrefix.length)
    : value.startsWith(legacyPrefix)
      ? value.slice(legacyPrefix.length)
      : value;
}

function migrateThreads(port: SettingsPort): Json[] {
  const native = parse(port, 'sai-recent-native-threads');
  const existingRaw = parse(port, threadsKey);
  const known: unknown[] = Array.isArray(existingRaw) ? [...existingRaw] : [];
  if (Array.isArray(native)) {
    for (const item of native.filter(validNativeThread)) {
      const index = known.findIndex((saved) => {
        const value = record(saved);
        return !!value && sameThread(value, item);
      });
      if (index < 0) known.push(item);
      else {
        const saved = record(known[index]);
        const updated = item.updated;
        if (
          saved &&
          typeof updated === 'number' &&
          (typeof saved.updated !== 'number' || updated > saved.updated)
        )
          known[index] = { ...saved, updated };
      }
    }
    if (Array.isArray(existingRaw) || port.get(threadsKey) === null) {
      write(port, threadsKey, port.get(threadsKey), known);
      port.remove('sai-recent-native-threads');
    }
  }
  return known.filter((item): item is Json => !!record(item));
}

function openCodeThread(directory: string, sessionId: string, threads: Json[]): Json {
  const saved = threads.find(
    (thread) =>
      thread.agent === 'opencode' &&
      thread.directory === directory &&
      thread.sessionId === sessionId,
  );
  return saved ?? { agent: 'opencode', directory, sessionId, title: 'OpenCode thread', updated: 0 };
}

function migratePane(
  pane: unknown,
  directory: string,
  sessionId: string | undefined,
  threads: Json[],
): unknown {
  const value = record(pane);
  if (!value) return pane;
  if ('direction' in value)
    return {
      ...value,
      first: migratePane(value.first, directory, sessionId, threads),
      second: migratePane(value.second, directory, sessionId, threads),
    };
  if (value.kind !== undefined) return value;
  if (value.agent === null && value.id === 'main')
    return {
      ...value,
      agent: 'opencode',
      thread: sessionId ? openCodeThread(directory, sessionId, threads) : (value.thread ?? null),
    };
  if (value.agent === 'opencode') {
    const thread = record(value.thread);
    return thread && thread.agent !== 'opencode'
      ? { ...value, thread: { ...thread, agent: 'opencode' } }
      : value;
  }
  return value;
}

function migrateLayouts(port: SettingsPort, threads: Json[]): void {
  const raw = port.get('sai-pane-layouts');
  const layouts = record(raw === null ? {} : parse(port, 'sai-pane-layouts'));
  if (!layouts) return;
  const next: Json = { ...layouts };
  const sessions = new Map<string, string>();
  for (const key of port.keys().filter((item) => item.startsWith(sessionPrefix))) {
    const value = port.get(key);
    if (value?.trim()) sessions.set(key.slice(sessionPrefix.length), bareSessionId(value.trim()));
  }
  for (const directory of new Set([...Object.keys(layouts), ...sessions.keys()])) {
    if (port.get(`${emptyMainPrefix}${directory}`) === 'true') continue;
    const sessionId = sessions.get(directory);
    if (layouts[directory] === undefined && !sessionId) continue;
    const layout = layouts[directory] ?? { id: 'main', agent: null, thread: null };
    next[directory] = migratePane(layout, directory, sessionId, threads);
  }
  if (raw !== null || Object.keys(next).length) write(port, 'sai-pane-layouts', raw, next);
}

function migrateReceipts(port: SettingsPort): void {
  mapArray(port, 'sai-agent-spawn-receipts', (item) =>
    mapStringField(mapStringField(item, 'targetId'), 'sourceId'),
  );
}

function migrateIssue(issue: unknown): unknown {
  const value = record(issue);
  if (!value) return issue;
  const next: Json = { ...value };
  if (typeof next.threadId === 'string') next.threadId = acpThreadId(next.threadId);
  if (Array.isArray(next.checkpointThreadIds))
    next.checkpointThreadIds = next.checkpointThreadIds.map((id) =>
      typeof id === 'string' ? acpThreadId(id) : id,
    );
  const percent = record(next.contextPercentByThread);
  if (percent)
    next.contextPercentByThread = Object.fromEntries(
      Object.entries(percent).map(([key, item]) => [acpThreadId(key), item]),
    );
  if (Array.isArray(next.contextHandoffs))
    next.contextHandoffs = next.contextHandoffs.map((handoff) =>
      mapStringField(mapStringField(handoff, 'fromThreadId'), 'toThreadId'),
    );
  return next;
}

function migrateShipRuns(port: SettingsPort): void {
  mapArray(port, 'sai-ship-runs', (run) => {
    const value = record(run);
    if (!value || !Array.isArray(value.issues)) return run;
    return { ...value, issues: value.issues.map(migrateIssue) };
  });
}

function migrateCoordination(port: SettingsPort): void {
  mapArray(port, 'sai-coordination-messages', (item) => {
    const value = record(item);
    if (!value || typeof value.target !== 'string') return item;
    return { ...value, target: acpScopeKey(value.target) };
  });
}

function migratePostTurnHistory(port: SettingsPort): void {
  mapArray(port, 'sai-post-turn-history', (item) => {
    const value = record(item);
    if (!value || typeof value.thread !== 'string' || !value.thread.startsWith(legacyPrefix))
      return item;
    const thread = acpThreadId(value.thread);
    const next: Json = { ...value, thread };
    if (typeof value.id === 'string')
      next.id = JSON.stringify([value.directory, thread, value.turn, value.source, value.command]);
    return next;
  });
}

function migrateImplementationOwners(port: SettingsPort): void {
  for (const key of port.keys()) {
    if (key.startsWith('sai-ship-it-owner:')) {
      const value = port.get(key);
      if (value !== null && acpThreadId(value) !== value) port.set(key, acpThreadId(value));
    } else if (key.startsWith('sai-implementation-pending:'))
      mapArray(port, key, (item) => mapStringField(item, 'owner'));
  }
}

/**
 * Runs once per profile and is safe to repeat: it only rewrites `opencode:` references that are
 * still in the native form. A corrupt value is left untouched and does not stop the other steps.
 */
export function migrateOpenCodeSettings(port: SettingsPort): boolean {
  if (port.get(openCodeMigrationKey) === '1') return false;
  const steps: ((target: SettingsPort) => void)[] = [
    (target) => migrateLayouts(target, migrateThreads(target)),
    migrateReceipts,
    migrateShipRuns,
    migrateCoordination,
    migratePostTurnHistory,
    migrateImplementationOwners,
  ];
  for (const step of steps) {
    try {
      step(port);
    } catch {
      continue;
    }
  }
  for (const key of port.keys().filter((item) => item.startsWith(sessionPrefix))) port.remove(key);
  port.set(openCodeMigrationKey, '1');
  return true;
}

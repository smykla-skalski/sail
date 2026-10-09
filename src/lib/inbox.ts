import type { ProjectCatalog } from './projects';
import { permissionDecisionTitle, type PermissionPolicyDecision } from './capability-profiles.ts';

export type InboxLocation = {
  directory: string;
  project: string;
  worktree: string | null;
};

export type InboxItem = InboxLocation & {
  key: string;
  kind: 'acp-permission' | 'opencode-permission' | 'question' | 'turn-completed' | 'check-failed';
  agent: string;
  agentId?: string;
  sessionId: string;
  requestId?: string | number;
  text: string;
  receivedAt: number;
  read?: boolean;
  eventId?: string;
  options?: { optionId: string; name: string; kind: string }[];
  allow?: boolean;
  policy?: PermissionPolicyDecision;
  permissionPolicies?: Record<string, PermissionPolicyDecision>;
  permissionTitle?: string;
  permissionToolCall?: unknown;
  permissionResourceTrust?: { trusted: boolean; canonicalResources: string[] };
  generation?: string | number;
  fingerprint?: string;
};

export function inboxPermissionDecisionTitle(
  item: Pick<InboxItem, 'permissionTitle' | 'policy' | 'text'>,
  outcome: 'completed' | 'rejected',
): string {
  return item.permissionTitle && item.policy
    ? permissionDecisionTitle(item.permissionTitle, item.policy, outcome)
    : item.text;
}

export type InboxOutcome = {
  key: string;
  kind: 'turn-completed' | 'check-failed';
  directory: string;
  agentId: string;
  sessionId: string;
  text: string;
  receivedAt: number;
  eventId?: string;
  read: boolean;
};

export const maxInboxOutcomes = 100;

/** Only finished work is saved. Requests and attention items are derived on every refresh. */
export const persistedInboxKinds = ['turn-completed', 'check-failed'] as const;

export type InboxCheck = {
  id: string;
  directory: string;
  thread: string;
  command: string;
  status: string;
  updated: number;
};

export function failedCheckOutcome(check: InboxCheck): InboxOutcome | null {
  if (check.status !== 'failed' && check.status !== 'timed_out') return null;
  const separator = check.thread.indexOf(':');
  if (separator < 0) return null;
  const provider = check.thread.slice(0, separator);
  if (provider !== 'acp' && provider !== 'opencode') return null;
  const remainder = check.thread.slice(separator + 1);
  const acpSeparator = provider === 'acp' ? remainder.indexOf(':') : -1;
  const agentId =
    provider === 'opencode' ? 'opencode' : acpSeparator < 0 ? '' : remainder.slice(0, acpSeparator);
  const sessionId = provider === 'opencode' ? remainder : remainder.slice(acpSeparator + 1);
  if (!agentId || !sessionId) return null;
  return {
    key: `check:${check.id}`,
    kind: 'check-failed',
    directory: check.directory,
    agentId,
    sessionId,
    text: check.command,
    receivedAt: check.updated,
    eventId: check.id,
    read: false,
  };
}

export function loadInboxOutcomes(raw: string | null): InboxOutcome[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is InboxOutcome =>
          item &&
          typeof item === 'object' &&
          typeof item.key === 'string' &&
          (persistedInboxKinds as readonly string[]).includes(item.kind) &&
          typeof item.directory === 'string' &&
          typeof item.agentId === 'string' &&
          typeof item.sessionId === 'string' &&
          typeof item.text === 'string' &&
          typeof item.receivedAt === 'number' &&
          Number.isFinite(item.receivedAt) &&
          typeof item.read === 'boolean' &&
          (item.eventId === undefined || typeof item.eventId === 'string'),
      )
      .slice(-maxInboxOutcomes);
  } catch {
    return [];
  }
}

export function recordInboxOutcome(items: InboxOutcome[], outcome: InboxOutcome): InboxOutcome[] {
  if (items.some((item) => item.key === outcome.key)) return items;
  return [...items, outcome].slice(-maxInboxOutcomes);
}

export function markInboxOutcomeRead(items: InboxOutcome[], key: string): InboxOutcome[] {
  return items.map((item) => (item.key === key ? { ...item, read: true } : item));
}

export function isInboxOutcome(item: InboxItem): boolean {
  return item.kind === 'turn-completed' || item.kind === 'check-failed';
}

export type InboxOpenRoute = 'outcome' | 'acp-request' | 'opencode-request';

/** How opening an Inbox row reaches its thread and the request or result inside it. */
export function inboxOpenRoute(item: Pick<InboxItem, 'kind'>): InboxOpenRoute {
  if (item.kind === 'turn-completed' || item.kind === 'check-failed') return 'outcome';
  return item.kind === 'acp-permission' ? 'acp-request' : 'opencode-request';
}

export function inboxTurnMessageIndex(
  messages: { kind: 'user' | 'assistant'; created: number }[],
  completedAt: number,
): number | null {
  const start = messages.findLastIndex(
    (message) => message.kind === 'user' && message.created <= completedAt,
  );
  if (start < 0) {
    const assistant = messages.findLastIndex(
      (message) => message.kind === 'assistant' && message.created <= completedAt,
    );
    return assistant < 0 ? null : assistant;
  }
  const next = messages.findIndex((message, index) => index > start && message.kind === 'user');
  for (let index = (next < 0 ? messages.length : next) - 1; index > start; index--)
    if (messages[index].kind === 'assistant') return index;
  return start;
}

export function repositoryName(path: string): string {
  return path.split(/[\\/]/).findLast((part) => !!part) ?? path;
}

export function inboxLocations(catalog: ProjectCatalog): InboxLocation[] {
  return catalog.repositories.flatMap((repository) => [
    {
      directory: repository,
      project: repositoryName(repository),
      worktree: null,
    },
    ...(catalog.worktrees[repository] ?? []).map((worktree) => ({
      directory: worktree.path,
      project: repositoryName(repository),
      worktree: worktree.branch,
    })),
  ]);
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return items.toSorted(
    (left, right) => left.receivedAt - right.receivedAt || left.key.localeCompare(right.key),
  );
}

import { receiptIsSettled, type SpawnReceipt } from './agent-results.ts';
import { activityState } from './activity-state.ts';
import { formatDuration } from './task-notification.ts';

export function providerLabel(provider: SpawnReceipt['provider']): string {
  return provider === 'opencode' ? 'OpenCode' : provider === 'codex' ? 'Codex' : 'Claude';
}

/** The agent type a child was spawned as, or the provider when the child has none. */
export function subagentType(receipt: Pick<SpawnReceipt, 'name' | 'provider'>): string {
  const name = receipt.name?.trim();
  return name && name.toLowerCase() !== 'subagent' ? name : providerLabel(receipt.provider);
}

/** How long the child ran: to its last update once settled, to `now` while it runs. Null when
 * the times are unknown or the child ran under a second, so a restored child never reads 0s. */
export function subagentDurationMs(
  receipt: Pick<SpawnReceipt, 'state' | 'created' | 'updated'>,
  now: number,
): number | null {
  const end = receiptIsSettled(receipt.state) ? receipt.updated : now;
  if (!Number.isFinite(receipt.created) || !Number.isFinite(end) || receipt.created <= 0)
    return null;
  const elapsed = end - receipt.created;
  return elapsed >= 1_000 ? elapsed : null;
}

export function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'tool use' : 'tool uses'}`;
}

/** Time since the child last reported, or null when it never did. */
export function lastSignalAge(receipt: Pick<SpawnReceipt, 'updated'>, now: number): string | null {
  if (!Number.isFinite(receipt.updated) || receipt.updated <= 0) return null;
  const age = Math.max(0, now - receipt.updated);
  return age < 1_000 ? 'just now' : `${formatDuration(age)} ago`;
}

/** What a screen reader hears when a child changes state. */
export function stateAnnouncement(receipt: SpawnReceipt): string {
  const task = receipt.prompt?.trim();
  return `${subagentType(receipt)} subagent${task ? ` ${task.slice(0, 80)}` : ''}: ${
    activityState(receipt.state).label
  }`;
}

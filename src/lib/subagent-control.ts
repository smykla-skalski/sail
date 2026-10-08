import type { InboxItem } from './inbox.ts';
import type { SpawnReceipt } from './agent-results.ts';

export type AnsweredPermission = {
  key: string;
  agentId: string;
  sessionId: string;
  title: string;
};

/** What a subagent group card needs from the app: the children's pending permissions, the ones
 * answered already, and the stop actions. */
export type SubagentControl = {
  permissions: readonly InboxItem[];
  answered: readonly AnsweredPermission[];
  /** Thread ids of Ship workers and gates, which stop through Stop run. */
  shipOwned: ReadonlySet<string>;
  ondecide: (item: InboxItem, optionId: string | null) => Promise<void>;
  onstop: (receipt: SpawnReceipt) => Promise<void>;
  onstopall: (receipts: SpawnReceipt[]) => Promise<void>;
};

/** The adapter reports a second answer to a settled request with this text. Every surface treats
 * it as "Answered" instead of an error. */
export function permissionAlreadyAnswered(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /no longer pending/i.test(text);
}

function childSession(receipt: SpawnReceipt): { agentId: string; sessionId: string } | null {
  const target = receipt.targetId;
  if (!target) return null;
  if (target.startsWith('opencode:'))
    return { agentId: 'opencode', sessionId: target.slice('opencode:'.length) };
  const match = /^acp:([^:]+):(.+)$/.exec(target);
  return match ? { agentId: match[1], sessionId: match[2] } : null;
}

export function childPermissions(
  control: Pick<SubagentControl, 'permissions' | 'answered'>,
  receipt: SpawnReceipt,
): { pending: InboxItem[]; answered: AnsweredPermission[] } {
  const child = childSession(receipt);
  if (!child) return { pending: [], answered: [] };
  return {
    pending: control.permissions.filter(
      (item) =>
        (item.kind === 'acp-permission' || item.kind === 'opencode-permission') &&
        (item.agentId ?? 'opencode') === child.agentId &&
        item.sessionId === child.sessionId &&
        item.directory === receipt.targetDirectory,
    ),
    answered: control.answered.filter(
      (item) => item.agentId === child.agentId && item.sessionId === child.sessionId,
    ),
  };
}

export type SubagentStop =
  /** Stop acts on this child alone. */
  | 'stop'
  /** Native children end only with the parent turn: the adapter ignores a child cancel. */
  | 'parent-turn'
  /** Ship gates and Ship workers stop through Stop run. */
  | 'ship-managed'
  | 'none';

export function subagentStop(
  receipt: SpawnReceipt,
  shipOwnedTargets: ReadonlySet<string> = new Set(),
): SubagentStop {
  if (receipt.receiptId.startsWith('native:')) return 'parent-turn';
  if (receipt.validation || (receipt.targetId && shipOwnedTargets.has(receipt.targetId)))
    return 'ship-managed';
  if (!receipt.targetId || !receipt.targetDirectory) return 'none';
  return childSession(receipt) ? 'stop' : 'none';
}

export const parentTurnStopHint = 'Stop the parent turn to stop Claude subagents';

export function stoppableSubagents(
  receipts: readonly SpawnReceipt[],
  shipOwnedTargets: ReadonlySet<string> = new Set(),
): SpawnReceipt[] {
  return receipts.filter(
    (receipt) =>
      subagentStop(receipt, shipOwnedTargets) === 'stop' &&
      ['queued', 'starting', 'working', 'waiting'].includes(receipt.state),
  );
}

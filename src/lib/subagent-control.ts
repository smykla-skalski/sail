import type { InboxItem } from './inbox.ts';
import type { SpawnReceipt } from './agent-results.ts';

export type PermissionResolution = 'answered' | 'cancelled';

export type AnsweredPermission = {
  key: string;
  agentId: string;
  directory: string;
  sessionId: string;
  title: string;
  outcome: PermissionResolution;
};

/** How a `sail/permission_resolved` event settled its request. Stop and turn cancel resolve
 * pending requests as cancelled, which must not read as an answer. */
export function permissionResolution(
  params: Record<string, unknown> | undefined,
): PermissionResolution {
  return params?.sailPermissionOutcome === 'cancelled' ? 'cancelled' : 'answered';
}

export function permissionResolutionLabel(outcome: PermissionResolution): string {
  return outcome === 'cancelled' ? 'Cancelled' : 'Answered';
}

/** One note per request instance: ACP request ids and generations restart with each
 * connection, so the per-request fingerprint tells reused ids apart. */
export function answeredPermissionKey(
  agentId: string,
  sessionId: string,
  requestId: string | number,
  params: Record<string, unknown> | undefined,
): string {
  const fingerprint = params?.sailPermissionFingerprint;
  const generation = params?.sailPermissionGeneration;
  const instance =
    typeof fingerprint === 'string' && fingerprint
      ? fingerprint
      : typeof generation === 'number'
        ? String(generation)
        : '';
  return `acp:${agentId}:${sessionId}:${requestId}:${instance}`;
}

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

/** The adapter reports a second answer to a settled request with this text. Surfaces drop the
 * request instead of showing an error; the resolution event says whether it was answered. */
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
        item.kind === 'acp-permission' &&
        item.agentId === child.agentId &&
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
  if (
    receipt.validation ||
    (receipt.targetId &&
      receipt.targetDirectory &&
      shipOwnedTargets.has(shipOwnedTargetKey(receipt.targetDirectory, receipt.targetId)))
  )
    return 'ship-managed';
  if (!receipt.targetId || !receipt.targetDirectory) return 'none';
  return childSession(receipt) ? 'stop' : 'none';
}

export function shipOwnedTargetKey(directory: string, targetId: string): string {
  return JSON.stringify([directory, targetId]);
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

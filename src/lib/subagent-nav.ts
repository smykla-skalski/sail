import { receiptSourceId, type SpawnReceipt } from './agent-results.ts';

export type NavTarget = { directory: string; threadId: string };

export type SubagentNavigation = {
  /** The thread that spawned the focused child. */
  parent: NavTarget;
  /** Every child of that parent, oldest first, including the focused one. */
  siblings: NavTarget[];
  index: number;
  previous: NavTarget | null;
  next: NavTarget | null;
};

function targetOf(receipt: SpawnReceipt): NavTarget | null {
  return receipt.targetId && receipt.targetDirectory
    ? { directory: receipt.targetDirectory, threadId: receipt.targetId }
    : null;
}

const identity = (target: NavTarget) => `${target.directory}\0${target.threadId}`;

/** Parent and siblings of the focused thread, or null when it is not a subagent. Works for native,
 * MCP and OpenCode children, which all share the receipt shape. */
export function subagentNavigation(
  receipts: readonly SpawnReceipt[],
  focused: { agent: string; sessionId: string; directory: string } | null,
): SubagentNavigation | null {
  if (!focused) return null;
  const self = {
    directory: focused.directory,
    threadId: receiptSourceId(focused.agent, focused.sessionId),
  };
  const own = receipts.find((receipt) => {
    const target = targetOf(receipt);
    return target && identity(target) === identity(self);
  });
  if (!own) return null;
  const parent = { directory: own.sourceDirectory, threadId: own.sourceId };
  if (identity(parent) === identity(self)) return null;
  const seen = new Set<string>();
  const siblings = receipts
    .filter(
      (receipt) =>
        receipt.sourceId === own.sourceId && receipt.sourceDirectory === own.sourceDirectory,
    )
    .toSorted((left, right) => left.created - right.created)
    .flatMap((receipt) => {
      const target = targetOf(receipt);
      if (!target || seen.has(identity(target))) return [];
      seen.add(identity(target));
      return [target];
    });
  const index = siblings.findIndex((target) => identity(target) === identity(self));
  if (index < 0) return null;
  return {
    parent,
    siblings,
    index,
    previous: siblings[index - 1] ?? null,
    next: siblings[index + 1] ?? null,
  };
}

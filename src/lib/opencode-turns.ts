const pending = new Map<string, Promise<unknown>>();
const worktreeFences = new Map<string, Promise<void>>();
const worktreeCleanups = new Set<string>();

function runOpenCodeWorktreeTransition<T>(
  directory: string,
  transition: () => Promise<T>,
): Promise<T> {
  const previous = worktreeFences.get(directory) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(transition);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  worktreeFences.set(directory, settled);
  void settled.then(() => {
    if (worktreeFences.get(directory) === settled) worktreeFences.delete(directory);
    return undefined;
  });
  return result;
}

export function runOpenCodePromptStart<T>(directory: string, start: () => Promise<T>): Promise<T> {
  if (worktreeCleanups.has(directory))
    return Promise.reject(new Error('OpenCode worktree cleanup is in progress.'));
  return runOpenCodeWorktreeTransition(directory, start);
}

export function runOpenCodeCleanup<T>(directory: string, cleanup: () => Promise<T>): Promise<T> {
  if (worktreeCleanups.has(directory))
    return Promise.reject(new Error('OpenCode worktree cleanup is already in progress.'));
  worktreeCleanups.add(directory);
  const result = runOpenCodeWorktreeTransition(directory, cleanup);
  void result.catch(() => {
    worktreeCleanups.delete(directory);
    return undefined;
  });
  return result;
}

export function runSerialOpenCodeTurn<T>(sessionId: string, turn: () => Promise<T>): Promise<T> {
  const previous = pending.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(turn);
  const settled = result.catch(() => undefined);
  pending.set(sessionId, settled);
  void settled.then(() => {
    if (pending.get(sessionId) === settled) pending.delete(sessionId);
    return undefined;
  });
  return result;
}

export function runReservedOpenCodeTurn<T>(
  sessionId: string,
  reserve: () => Promise<() => void>,
  turn: () => Promise<T>,
  settle: (accepted: T) => Promise<unknown>,
): Promise<T> {
  return runSerialOpenCodeTurn(sessionId, async () => {
    const release = await reserve();
    try {
      const accepted = await turn();
      void Promise.resolve()
        .then(() => settle(accepted))
        .finally(release)
        .catch(() => undefined);
      return accepted;
    } catch (cause) {
      release();
      throw cause;
    }
  });
}

export async function waitForAuthoritativeOpenCodeSettlement(
  wait: () => Promise<void>,
  settled: () => Promise<boolean>,
  options: {
    retry?: () => Promise<void>;
    terminal?: (cause: unknown) => boolean;
  } = {},
): Promise<void> {
  const retry = options.retry ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
  const terminal = options.terminal ?? (() => false);
  async function attempt(): Promise<void> {
    try {
      await wait();
    } catch (waitCause) {
      if (terminal(waitCause)) return;
    }
    try {
      if (await settled()) return;
    } catch (settlementCause) {
      if (terminal(settlementCause)) return;
    }
    await retry();
    return attempt();
  }
  return attempt();
}

export async function openCodeInboxSettled(
  inboxID: string,
  list: (cursor?: string) => Promise<{
    data: readonly { id: string; type: string }[];
    cursor: { next?: string | null };
  }>,
): Promise<boolean> {
  async function visit(
    cursor: string | undefined,
    idleAfterInbox: boolean,
    seen: Set<string>,
  ): Promise<boolean> {
    const page = await list(cursor);
    for (const message of page.data) {
      if (message.id === inboxID) return idleAfterInbox;
      if (message.type === 'idle') idleAfterInbox = true;
    }
    const next = page.cursor.next ?? undefined;
    if (!next || seen.has(next)) return false;
    seen.add(next);
    return visit(next, idleAfterInbox, seen);
  }
  return visit(undefined, false, new Set());
}

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

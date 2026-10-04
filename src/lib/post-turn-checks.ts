export type PostTurnCheck = {
  id: string;
  updated: number;
  directory: string;
  thread: string;
  turn: string;
  source: 'repository' | 'personal';
  command: string;
  status: 'running' | 'passed' | 'failed' | 'timed_out' | 'canceled';
  output: string;
  code: number | null;
};

export function personalChecks(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : [];
  } catch {
    return [];
  }
}

export function upsertCheck(checks: PostTurnCheck[], next: PostTurnCheck): PostTurnCheck[] {
  return [...checks.filter((item) => checkKey(item) !== checkKey(next)), next];
}

export function checkKey(
  item: Pick<PostTurnCheck, 'directory' | 'thread' | 'turn' | 'source' | 'command'>,
): string {
  return JSON.stringify([item.directory, item.thread, item.turn, item.source, item.command]);
}

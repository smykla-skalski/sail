import type { ShipItIssue } from './implementation-models.ts';
import type { ShipRun } from './issue-shipping.ts';

export function parseSpawnShipIssue(value: unknown, role: unknown): ShipItIssue | undefined {
  if (value === undefined) return undefined;
  if (role !== 'implementation')
    throw new Error('Ship assignment requires the implementation routing role.');
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('repository' in value) ||
    typeof value.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    !('number' in value) ||
    !Number.isSafeInteger(value.number) ||
    Number(value.number) <= 0 ||
    Object.keys(value).some((key) => !['repository', 'number'].includes(key))
  )
    throw new Error('Ship assignment requires a repository and positive issue number.');
  return { repository: value.repository.toLowerCase(), number: Number(value.number) };
}

export function requireSpawnShipIssueAvailable(
  runs: ShipRun[],
  project: string,
  issue: ShipItIssue,
  directory?: string,
): void {
  if (
    runs.some(
      (run) =>
        run.repository === project &&
        run.remote.toLowerCase() === issue.repository.toLowerCase() &&
        run.issues.some((candidate) => candidate.number === issue.number),
    )
  )
    throw new Error(
      'This Ship issue already has a tracked assignment; resume its assigned worker.',
    );
  if (directory && runs.some((run) => run.issues.some((candidate) => candidate.path === directory)))
    throw new Error('This worktree already has a Ship assignment; choose a fresh worktree.');
}

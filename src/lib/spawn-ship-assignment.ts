import type { ShipItIssue } from './implementation-models.ts';
import type { ShipRun } from './issue-shipping.ts';
import type { SpawnReceipt } from './agent-results.ts';

export async function finishSpawnShipRetry(
  retry: () => Promise<string>,
  record: (result: Pick<SpawnReceipt, 'state' | 'result' | 'error'>) => Promise<void>,
): Promise<void> {
  let result: Pick<SpawnReceipt, 'state' | 'result' | 'error'>;
  try {
    const message = await retry();
    result = {
      state: message ? 'completed' : 'interrupted',
      result: message || 'Retry cancelled.',
      error: null,
    };
  } catch (cause) {
    result = {
      state: 'failed',
      result: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  await record(result);
}

export function spawnShipRetry(
  runs: ShipRun[],
  receipts: SpawnReceipt[],
  project: string,
  issue: ShipItIssue,
  sourceId: string,
  sourceDirectory: string,
) {
  const run = runs.find(
    (candidate) =>
      candidate.repository === project &&
      candidate.remote.toLowerCase() === issue.repository.toLowerCase() &&
      candidate.issues.some((item) => item.number === issue.number),
  );
  const assigned = run?.issues.find((item) => item.number === issue.number);
  const receipt = receipts.find((item) => item.receiptId === assigned?.receiptId);
  if (
    !run ||
    !assigned ||
    !receipt ||
    receipt.project !== project ||
    receipt.sourceId !== sourceId ||
    receipt.sourceDirectory !== sourceDirectory ||
    receipt.targetId !== assigned.threadId ||
    receipt.targetDirectory !== assigned.path
  )
    throw new Error('Only the original coordinator can retry this tracked Ship assignment.');
  if (!['interrupted', 'unavailable', 'failed'].includes(receipt.state))
    throw new Error('The assigned worker has not stopped; inspect its launch receipt first.');
  return { run, issue: assigned, receipt };
}

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
      'This Ship issue already has a tracked assignment. Inspect its receipt; if interrupted, retry agent_spawn with the same shipIssue and retry: true.',
    );
  if (directory && runs.some((run) => run.issues.some((candidate) => candidate.path === directory)))
    throw new Error('This worktree already has a Ship assignment; choose a fresh worktree.');
}

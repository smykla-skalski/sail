import type { TaskEconomics } from './task-economics.ts';

export const ciFailureClassifications = ['code', 'flaky', 'infrastructure', 'unknown'] as const;
export type CiFailureClassification = (typeof ciFailureClassifications)[number];

export type CiFailureIdentity = {
  revision: string;
  workflow: string;
  job: string;
  attempt: number;
};

export type CiRerunPolicy = {
  allowed: readonly CiFailureClassification[];
  maxAttempts: number;
};

export type CiFailureTriage = CiFailureIdentity & {
  id: string;
  classification: CiFailureClassification;
  excerpt: string;
  url: string;
  routedAt: number;
  resolvedAt: number | null;
  recurrence: number;
  rerunAllowed: boolean;
  rerunReason: string;
};

const maxExcerptLines = 80;
const maxExcerptCharacters = 12_000;
const contextLines = 3;

const patterns: Record<Exclude<CiFailureClassification, 'unknown'>, RegExp[]> = {
  code: [
    /\b(?:assert(?:ion)?|compile|syntax|typecheck|test) (?:error|fail(?:ed|ure)?)\b/i,
    /\berror(?:\[[A-Z0-9]+\])?:/i,
    /\b(?:expected|received):\s/i,
    /\b(?:FAIL|FAILED)\b.*\.(?:rs|ts|tsx|js|jsx|py|go):?\d*/,
  ],
  flaky: [
    /\bflak(?:e|ey|y)\b/i,
    /\b(?:race condition|intermittent|timed? out waiting)\b/i,
    /\btest.*(?:retry|passed on retry)\b/i,
  ],
  infrastructure: [
    /\b(?:runner|service|network|registry|artifact|cache|rate limit)\b.*\b(?:unavailable|error|failed|timeout|timed out)\b/i,
    /\b(?:ECONNRESET|ENOSPC|EAI_AGAIN|connection reset|no space left|temporary failure|503 Service Unavailable)\b/i,
    /\bThe hosted runner lost communication\b/i,
  ],
};

function stableIdentity(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

export function ciFailureId(identity: CiFailureIdentity): string {
  return `ci-failure:${stableIdentity(
    `${identity.revision}\0${identity.workflow}\0${identity.job}\0${identity.attempt}`,
  )}`;
}

export function classifyCiFailure(log: string): CiFailureClassification {
  const known = ['code', 'flaky', 'infrastructure'] as const;
  const scores = known.map((classification) => ({
    classification,
    score: patterns[classification].reduce(
      (total, pattern) => total + (pattern.test(log) ? 1 : 0),
      0,
    ),
  }));
  const ranked = scores.toSorted((left, right) => right.score - left.score);
  return ranked[0].score === 0 ? 'unknown' : ranked[0].classification;
}

function failureLine(line: string): boolean {
  return /\b(?:error|fail(?:ed|ure)?|panic|fatal|timeout|timed out|exception|assertion)\b/i.test(
    line,
  );
}

export function boundedFailureExcerpt(log: string): string {
  const lines = log.replaceAll('\r\n', '\n').split('\n');
  const selected = new Set<number>();
  lines.forEach((line, index) => {
    if (!failureLine(line)) return;
    for (
      let context = Math.max(0, index - contextLines);
      context <= Math.min(lines.length - 1, index + contextLines);
      context += 1
    )
      selected.add(context);
  });
  const candidates = selected.size
    ? [...selected].toSorted((left, right) => left - right).map((index) => lines[index])
    : lines.slice(-maxExcerptLines);
  const excerpt = candidates.slice(-maxExcerptLines).join('\n').trim();
  if (excerpt.length <= maxExcerptCharacters) return excerpt;
  return excerpt.slice(excerpt.length - maxExcerptCharacters);
}

export function rerunDecision(
  classification: CiFailureClassification,
  attempt: number,
  policy: CiRerunPolicy,
): { allowed: boolean; reason: string } {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1)
    throw new Error('CI rerun policy requires a positive maximum attempt count.');
  if (attempt >= policy.maxAttempts)
    return { allowed: false, reason: `attempt ${attempt} reached the ${policy.maxAttempts} limit` };
  if (!policy.allowed.includes(classification))
    return { allowed: false, reason: `${classification} failures are not allowed by rerun policy` };
  return {
    allowed: true,
    reason: `${classification} failures may rerun before attempt ${policy.maxAttempts}`,
  };
}

export function triageCiFailure(
  input: CiFailureIdentity & { log: string; url: string },
  policy: CiRerunPolicy,
  now: number,
): CiFailureTriage {
  const classification = classifyCiFailure(input.log);
  const rerun = rerunDecision(classification, input.attempt, policy);
  return {
    revision: input.revision,
    workflow: input.workflow,
    job: input.job,
    attempt: input.attempt,
    id: ciFailureId(input),
    classification,
    excerpt: boundedFailureExcerpt(input.log),
    url: input.url,
    routedAt: now,
    resolvedAt: null,
    recurrence: 1,
    rerunAllowed: rerun.allowed,
    rerunReason: rerun.reason,
  };
}

export function recordCiFailureTriage(
  records: CiFailureTriage[],
  triage: CiFailureTriage,
): { records: CiFailureTriage[]; duplicate: boolean; triage: CiFailureTriage } {
  const duplicate = records.find((record) => record.id === triage.id);
  if (duplicate) return { records, duplicate: true, triage: duplicate };
  const recurrence =
    1 +
    records.filter(
      (record) =>
        record.workflow === triage.workflow &&
        record.job === triage.job &&
        record.classification === triage.classification,
    ).length;
  const recorded = { ...triage, recurrence };
  return { records: [...records, recorded], duplicate: false, triage: recorded };
}

export function resolveCiFailureTriages(
  records: CiFailureTriage[],
  revision: string,
  passingJobs: ReadonlySet<string>,
  now: number,
): CiFailureTriage[] {
  return records.map((record) =>
    record.revision === revision && record.resolvedAt === null && passingJobs.has(record.job)
      ? { ...record, resolvedAt: now }
      : record,
  );
}

export function ciTriageEconomics(triage: CiFailureTriage): TaskEconomics {
  return {
    role: 'synthetic',
    phase: 'ci',
    turns: 0,
    toolCalls: 0,
    permissionRequests: 0,
    compactions: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    elapsedMs: 0,
    retries: triage.rerunAllowed ? 1 : 0,
    findings: 1,
    checks: 0,
    humanInterventions: 0,
    failedCommands: 1,
    approvalLatencyMs: 0,
    repeatedWork: Math.max(0, triage.recurrence - 1),
  };
}

export function ciFailurePrompt(triage: CiFailureTriage): string {
  return [
    `Investigate ${triage.classification} CI failure in ${triage.workflow} / ${triage.job}.`,
    `Revision: ${triage.revision}`,
    `Attempt: ${triage.attempt}`,
    `Recurrence: ${triage.recurrence}`,
    `Rerun policy: ${triage.rerunAllowed ? 'allowed' : 'not allowed'} (${triage.rerunReason}).`,
    triage.url,
    '',
    triage.excerpt || 'No failing log section was found. Open the check link for details.',
  ].join('\n');
}

import { z } from 'zod';

export const evidenceResults = ['passed', 'failed', 'pending', 'blocked'] as const;
export type EvidenceResult = (typeof evidenceResults)[number];

export const taskEvidenceSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(['command', 'gate']),
    name: z.string().min(1).max(1000),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(500).nullable(),
    result: z.enum(evidenceResults),
    timestamp: z.number().int().nonnegative(),
    sequence: z.number().int().positive().optional(),
    outputReference: z.string().min(1).max(2000),
    criteria: z.array(z.string().min(1).max(2000)).max(100),
  })
  .strict();

export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;

export const evidenceManifestSchema = z
  .object({
    revision: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).max(100),
    evidence: z.array(taskEvidenceSchema).max(100),
    stale: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine((manifest) => manifest.updatedAt >= manifest.createdAt, {
    message: 'Evidence manifest time cannot move backwards.',
  })
  .transform((manifest) => ({
    ...manifest,
    evidence: manifest.evidence.toSorted(compareEvidence),
  }));

export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;

export const evidenceManifestsSchema = z
  .array(evidenceManifestSchema)
  .max(2000)
  .transform((manifests) => {
    const byRevision = new Map<string, EvidenceManifest>();
    for (const manifest of manifests) {
      const previous = byRevision.get(manifest.revision);
      if (!previous || manifest.updatedAt >= previous.updatedAt)
        byRevision.set(manifest.revision, manifest);
    }
    return [...byRevision.values()];
  })
  .refine((manifests) => manifests.length <= 20, {
    message: 'Evidence manifests cannot exceed 20 unique revisions.',
  });

export type EvidenceReadiness = {
  ready: boolean;
  stale: boolean;
  missingGates: string[];
  failedGates: string[];
  pendingGates: string[];
  failedCommands: string[];
  pendingCommands: string[];
  unverifiedCriteria: string[];
  reason: string | null;
};

const manifestLimit = 20;
const evidenceLimit = 100;

function evidenceIsNewer(candidate: TaskEvidence, previous: TaskEvidence): boolean {
  if (candidate.sequence !== undefined || previous.sequence !== undefined) {
    if (candidate.sequence === undefined) return false;
    if (previous.sequence === undefined) return true;
    if (candidate.sequence !== previous.sequence) return candidate.sequence > previous.sequence;
  }
  return candidate.timestamp >= previous.timestamp;
}

function compareEvidence(left: TaskEvidence, right: TaskEvidence): number {
  if (left.sequence !== undefined || right.sequence !== undefined) {
    if (left.sequence === undefined) return -1;
    if (right.sequence === undefined) return 1;
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  }
  return left.timestamp - right.timestamp;
}

function boundEvidenceManifests(manifests: EvidenceManifest[]): EvidenceManifest[] {
  const sorted = manifests.toSorted((left, right) => left.createdAt - right.createdAt);
  if (sorted.length <= manifestLimit) return sorted;
  const current = sorted.filter((manifest) => !manifest.stale).slice(-manifestLimit);
  const historyLimit = manifestLimit - current.length;
  const history = historyLimit
    ? sorted.filter((manifest) => manifest.stale).slice(-historyLimit)
    : [];
  return [...history, ...current].toSorted((left, right) => left.createdAt - right.createdAt);
}

export function mergeEvidenceManifests(
  current: EvidenceManifest[],
  incoming: EvidenceManifest[],
): EvidenceManifest[] {
  const merged = new Map(
    evidenceManifestsSchema.parse(current).map((manifest) => [manifest.revision, manifest]),
  );
  for (const candidate of evidenceManifestsSchema.parse(incoming)) {
    const existing = merged.get(candidate.revision);
    if (!existing) {
      merged.set(candidate.revision, candidate);
      continue;
    }
    const latest = candidate.updatedAt >= existing.updatedAt ? candidate : existing;
    const evidence = new Map(existing.evidence.map((entry) => [entry.id, entry]));
    for (const entry of candidate.evidence) {
      const previous = evidence.get(entry.id);
      if (!previous || evidenceIsNewer(entry, previous)) evidence.set(entry.id, entry);
    }
    merged.set(candidate.revision, {
      ...latest,
      evidence: [...evidence.values()].toSorted(compareEvidence).slice(-evidenceLimit),
      createdAt: Math.min(existing.createdAt, candidate.createdAt),
      updatedAt: Math.max(existing.updatedAt, candidate.updatedAt),
    });
  }
  return evidenceManifestsSchema.parse(boundEvidenceManifests([...merged.values()]));
}

export function requireEvidenceRevision(expected: unknown, current: string): void {
  if (typeof expected !== 'string' || !expected)
    throw new Error('Evidence needs the revision captured before execution.');
  if (expected !== current)
    throw new Error('The worktree changed after execution started. Rerun the evidence.');
}

export function requireEvidenceBaseRevision(recorded: string, current: string | undefined): void {
  if (current !== undefined && recorded !== current)
    throw new Error('Newer revision evidence was recorded concurrently. Rerun the gate.');
}

export function syncEvidenceManifest(
  manifests: EvidenceManifest[],
  revision: string,
  acceptanceCriteria: string[],
  now: number,
): EvidenceManifest[] {
  if (!revision) throw new Error('Evidence needs a source revision.');
  const criteria = z.array(z.string().min(1).max(2000)).min(1).max(100).parse(acceptanceCriteria);
  let found = false;
  const synced: EvidenceManifest[] = [];
  for (const manifest of evidenceManifestsSchema.parse(manifests)) {
    const current = manifest.revision === revision;
    if (!current) {
      synced.push(
        manifest.stale
          ? manifest
          : { ...manifest, stale: true, updatedAt: Math.max(manifest.updatedAt, now) },
      );
      continue;
    }
    found = true;
    const criteriaChanged =
      JSON.stringify(manifest.acceptanceCriteria) !== JSON.stringify(criteria);
    synced.push(
      !manifest.stale && !criteriaChanged
        ? manifest
        : {
            ...manifest,
            acceptanceCriteria: criteria,
            stale: false,
            updatedAt: Math.max(manifest.updatedAt, now),
          },
    );
  }
  if (!found)
    synced.push({
      revision,
      acceptanceCriteria: criteria,
      evidence: [],
      stale: false,
      createdAt: now,
      updatedAt: now,
    });
  return boundEvidenceManifests(synced);
}

export function recordTaskEvidence(
  manifests: EvidenceManifest[],
  revision: string,
  acceptanceCriteria: string[],
  evidence: TaskEvidence,
): EvidenceManifest[] {
  const parsedEntry = taskEvidenceSchema.parse(evidence);
  const nextSequence =
    Math.max(
      0,
      ...manifests.flatMap((manifest) =>
        manifest.evidence.map((candidate) => candidate.sequence ?? 0),
      ),
    ) + 1;
  const entry = { ...parsedEntry, sequence: nextSequence };
  const unknown = entry.criteria.filter((criterion) => !acceptanceCriteria.includes(criterion));
  if (unknown.length)
    throw new Error(`Evidence references unknown acceptance criteria: ${unknown.join(', ')}`);
  const synced = syncEvidenceManifest(manifests, revision, acceptanceCriteria, entry.timestamp);
  const index = synced.findIndex((manifest) => manifest.revision === revision);
  const manifest = synced[index];
  const previous = manifest.evidence.findLast(
    (candidate) => candidate.kind === entry.kind && candidate.name === entry.name,
  );
  if (
    previous &&
    previous.provider === entry.provider &&
    previous.model === entry.model &&
    previous.result === entry.result &&
    previous.outputReference === entry.outputReference &&
    JSON.stringify(previous.criteria) === JSON.stringify(entry.criteria)
  )
    return synced;
  return synced.with(index, {
    ...manifest,
    evidence: [...manifest.evidence, entry].slice(-evidenceLimit),
    updatedAt: Math.max(manifest.createdAt, manifest.updatedAt, entry.timestamp),
  });
}

export function evidenceReadiness(
  manifests: EvidenceManifest[],
  revision: string | null | undefined,
  requiredGates: string[],
  acceptanceCriteria: string[],
): EvidenceReadiness {
  const manifest = revision
    ? manifests.find((candidate) => candidate.revision === revision && !candidate.stale)
    : undefined;
  if (!manifest)
    return {
      ready: false,
      stale: manifests.some((candidate) => candidate.evidence.length > 0),
      missingGates: [...requiredGates],
      failedGates: [],
      pendingGates: [],
      failedCommands: [],
      pendingCommands: [],
      unverifiedCriteria: [...acceptanceCriteria],
      reason: revision
        ? 'Evidence for the current revision is missing or stale.'
        : 'Revision unknown.',
    };
  const latest = new Map<string, TaskEvidence>();
  for (const entry of manifest.evidence) {
    const key = `${entry.kind}:${entry.name}`;
    const previous = latest.get(key);
    if (!previous || evidenceIsNewer(entry, previous)) latest.set(key, entry);
  }
  const missingGates: string[] = [];
  const failedGates: string[] = [];
  const pendingGates: string[] = [];
  for (const gate of requiredGates) {
    const entry = latest.get(`gate:${gate}`);
    if (!entry) missingGates.push(gate);
    else if (['failed', 'blocked'].includes(entry.result)) failedGates.push(gate);
    else if (entry.result !== 'passed') pendingGates.push(gate);
  }
  const failedCommands = [...latest.values()]
    .filter((entry) => entry.kind === 'command' && ['failed', 'blocked'].includes(entry.result))
    .map((entry) => entry.name);
  const pendingCommands = [...latest.values()]
    .filter((entry) => entry.kind === 'command' && entry.result === 'pending')
    .map((entry) => entry.name);
  const verified = new Set(
    [...latest.values()]
      .filter((entry) => entry.result === 'passed')
      .flatMap((entry) => entry.criteria),
  );
  const unverifiedCriteria = acceptanceCriteria.filter((criterion) => !verified.has(criterion));
  const reason = failedCommands.length
    ? `Command evidence failed: ${failedCommands.join(', ')}.`
    : failedGates.length
      ? `Required evidence failed: ${failedGates.join(', ')}.`
      : missingGates.length
        ? `Required evidence missing: ${missingGates.join(', ')}.`
        : pendingGates.length
          ? `Required evidence pending: ${pendingGates.join(', ')}.`
          : pendingCommands.length
            ? `Command evidence pending: ${pendingCommands.join(', ')}.`
            : unverifiedCriteria.length
              ? `${unverifiedCriteria.length} acceptance criteria remain unverified.`
              : null;
  return {
    ready: reason === null,
    stale: false,
    missingGates,
    failedGates,
    pendingGates,
    failedCommands,
    pendingCommands,
    unverifiedCriteria,
    reason,
  };
}

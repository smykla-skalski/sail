import { z } from 'zod';
import {
  economicsRollupSchema,
  evidenceContentDigest,
  evidenceIdentityDigest,
  evidenceReferenceDigest,
  maxEconomicsCounter,
  mergeEconomicsRollups,
  reconcileArchivedEconomicsEvidence,
  rekeyArchivedEconomicsEvidence,
  rollUpEconomics,
  taskEconomicsSchema,
  updateArchivedEconomicsEvidence,
  type EconomicsRollup,
} from './task-economics.ts';

const evidenceHistoryLimit = 100;
const evidenceStorageLimit = 200;

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
    timestamp: z.number().int().nonnegative().max(maxEconomicsCounter),
    sequence: z.number().int().positive().max(maxEconomicsCounter).optional(),
    outputReference: z.string().min(1).max(2000),
    criteria: z.array(z.string().min(1).max(2000)).max(100),
    economics: taskEconomicsSchema.optional(),
    identityUncertain: z.boolean().optional(),
    reconciliationKey: z.string().length(16).optional(),
    executionOrder: z
      .tuple([z.number().int().nonnegative(), z.number().int().positive()])
      .optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.kind === 'command' &&
      evidence.result === 'failed' &&
      evidence.economics !== undefined &&
      evidence.economics.failedCommands === 0
    )
      context.addIssue({
        code: 'custom',
        path: ['economics', 'failedCommands'],
        message: 'Failed command evidence must record at least one failed command.',
      });
  });

export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;

export const evidenceManifestSchema = z
  .object({
    revision: z.string().min(1),
    baseRevision: z.string().min(1).nullable().default(null),
    acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).max(100),
    evidence: z.array(taskEvidenceSchema).max(evidenceStorageLimit),
    stale: z.boolean(),
    createdAt: z.number().int().nonnegative().max(maxEconomicsCounter),
    updatedAt: z.number().int().nonnegative().max(maxEconomicsCounter),
    economicsRollup: economicsRollupSchema.optional(),
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
      const key = manifestIdentity(manifest.revision, manifest.baseRevision);
      const previous = byRevision.get(key);
      if (!previous || manifest.updatedAt >= previous.updatedAt) byRevision.set(key, manifest);
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
function evidenceIsNewer(candidate: TaskEvidence, previous: TaskEvidence): boolean {
  if (candidate.executionOrder && previous.executionOrder) {
    const executionOrder =
      candidate.executionOrder[0] - previous.executionOrder[0] ||
      candidate.executionOrder[1] - previous.executionOrder[1];
    if (executionOrder !== 0) return executionOrder > 0;
  }
  if (candidate.sequence !== undefined || previous.sequence !== undefined) {
    if (candidate.sequence === undefined) return false;
    if (previous.sequence === undefined) return true;
    if (candidate.sequence !== previous.sequence) return candidate.sequence > previous.sequence;
  }
  if (candidate.timestamp !== previous.timestamp) return candidate.timestamp > previous.timestamp;
  const resultRank: Record<EvidenceResult, number> = {
    passed: 0,
    pending: 1,
    blocked: 2,
    failed: 3,
  };
  if (candidate.result !== previous.result)
    return resultRank[candidate.result] > resultRank[previous.result];
  return evidenceIdentityContent(candidate).localeCompare(evidenceIdentityContent(previous)) > 0;
}

function compareEvidence(left: TaskEvidence, right: TaskEvidence): number {
  if (left.sequence !== undefined || right.sequence !== undefined) {
    if (left.sequence === undefined) return -1;
    if (right.sequence === undefined) return 1;
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  }
  return left.timestamp - right.timestamp;
}

function manifestIdentity(revision: string, baseRevision: string | null | undefined): string {
  return `${revision}\0${baseRevision ?? ''}`;
}

function boundEvidence(evidence: TaskEvidence[]): TaskEvidence[] {
  const sorted = evidence.toSorted(compareEvidence);
  if (sorted.length <= evidenceHistoryLimit) return sorted;
  const latest = latestOutcomeEvidence(sorted);
  const latestGates = new Map<string, TaskEvidence>();
  for (const entry of sorted) {
    if (entry.kind !== 'gate') continue;
    const previous = latestGates.get(entry.name);
    if (!previous || evidenceIsNewer(entry, previous)) latestGates.set(entry.name, entry);
  }
  const latestCriteria = new Map<string, TaskEvidence>();
  for (const entry of latest) {
    if (entry.result !== 'passed') continue;
    for (const criterion of entry.criteria) {
      const previous = latestCriteria.get(criterion);
      if (!previous || evidenceIsNewer(entry, previous)) latestCriteria.set(criterion, entry);
    }
  }
  const protectedIds = new Set<string>();
  for (const entry of [...latestGates.values()].toSorted(compareEvidence).toReversed()) {
    protectedIds.add(entry.id);
  }
  for (const entry of [...latestCriteria.values()].toSorted(compareEvidence).toReversed()) {
    protectedIds.add(entry.id);
  }
  for (const entry of latest.filter(isCiObservation).toSorted(compareEvidence).toReversed()) {
    if (protectedIds.size >= evidenceHistoryLimit) break;
    protectedIds.add(entry.id);
  }
  if (protectedIds.size > evidenceStorageLimit)
    throw new Error('Readiness evidence exceeds the evidence storage limit.');
  const remainingCapacity = Math.max(0, evidenceHistoryLimit - protectedIds.size);
  const retained = remainingCapacity
    ? sorted.filter((entry) => !protectedIds.has(entry.id)).slice(-remainingCapacity)
    : [];
  const protectedEvidence = sorted.filter((entry) => protectedIds.has(entry.id));
  return [...retained, ...protectedEvidence].toSorted(compareEvidence);
}

function boundEvidenceManifests(manifests: EvidenceManifest[]): EvidenceManifest[] {
  const sorted = manifests.toSorted((left, right) => left.createdAt - right.createdAt);
  if (sorted.length <= manifestLimit) return sorted;
  const current = sorted.filter((manifest) => !manifest.stale).slice(-manifestLimit);
  const historyLimit = manifestLimit - current.length;
  const history = historyLimit
    ? sorted.filter((manifest) => manifest.stale).slice(-historyLimit)
    : [];
  const retained = [...history, ...current].toSorted(
    (left, right) => left.createdAt - right.createdAt,
  );
  const retainedRevisions = new Set(
    retained.map((manifest) => manifestIdentity(manifest.revision, manifest.baseRevision)),
  );
  const evicted = sorted.filter(
    (manifest) =>
      !retainedRevisions.has(manifestIdentity(manifest.revision, manifest.baseRevision)),
  );
  const existingRollup = combinedRollup(sorted);
  const rollup = rollUpEconomics(
    existingRollup,
    evicted.flatMap((manifest) => manifest.evidence),
  );
  return moveRollup(retained, rollup);
}

function combinedRollup(manifests: EvidenceManifest[]): EconomicsRollup | undefined {
  return mergeEconomicsRollups(manifests.map((manifest) => manifest.economicsRollup));
}

function archivedSequenceHighWater(manifests: EvidenceManifest[]): number {
  return Math.max(
    0,
    ...manifests.flatMap((manifest) =>
      (manifest.economicsRollup?.archivedSequenceRanges ?? []).map((range) => range[1]),
    ),
  );
}

function sequenceIsArchived(manifests: EvidenceManifest[], sequence: number): boolean {
  return manifests.some((manifest) =>
    manifest.economicsRollup?.archivedSequenceRanges.some(
      ([start, end]) => sequence >= start && sequence <= end,
    ),
  );
}

function evidenceIdentityContent(entry: TaskEvidence): string {
  return JSON.stringify({ ...entry, sequence: undefined });
}

function ciObservationContent(entry: TaskEvidence): string {
  return JSON.stringify({
    ...entry,
    result: undefined,
    timestamp: undefined,
    sequence: undefined,
    outputReference: undefined,
    executionOrder: undefined,
    economics: entry.economics ? { ...entry.economics, failedCommands: undefined } : undefined,
  });
}

function isCiObservation(entry: TaskEvidence): boolean {
  return entry.id.startsWith('ci:') && entry.provider === 'github' && entry.kind === 'command';
}

function matchingStableCiObservation(
  entries: TaskEvidence[],
  fallback: TaskEvidence,
): TaskEvidence | undefined {
  if (
    !isCiObservation(fallback) ||
    fallback.identityUncertain !== true ||
    !fallback.reconciliationKey
  )
    return undefined;
  const matches = entries.filter(
    (candidate) =>
      isCiObservation(candidate) &&
      candidate.identityUncertain !== true &&
      candidate.reconciliationKey === fallback.reconciliationKey &&
      candidate.outputReference === fallback.outputReference,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function archivedEvidenceContentMatches(entry: TaskEvidence, contentDigest: string): boolean {
  if (evidenceContentDigest(entry) === contentDigest) return true;
  if (!isCiObservation(entry)) return false;
  return [true, false, undefined].some(
    (identityUncertain) => evidenceContentDigest({ ...entry, identityUncertain }) === contentDigest,
  );
}

function latestOutcomeEvidence(entries: TaskEvidence[]): TaskEvidence[] {
  const grouped = new Map<string, TaskEvidence[]>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.name}`;
    const group = grouped.get(key);
    if (group) group.push(entry);
    else grouped.set(key, [entry]);
  }
  const selected: TaskEvidence[] = [];
  for (const group of grouped.values()) {
    const orderedCi = group.filter(
      (entry) => isCiObservation(entry) && entry.executionOrder !== undefined,
    );
    if (orderedCi.length) {
      const latestAttemptByLineage = new Map<number, number>();
      for (const entry of orderedCi) {
        const [lineage, attempt] = entry.executionOrder!;
        latestAttemptByLineage.set(
          lineage,
          Math.max(latestAttemptByLineage.get(lineage) ?? 0, attempt),
        );
      }
      const latestOrdered = orderedCi.filter((entry) => {
        const [lineage, attempt] = entry.executionOrder!;
        return latestAttemptByLineage.get(lineage) === attempt;
      });
      const unorderedCi = group.filter(
        (entry) => isCiObservation(entry) && entry.executionOrder === undefined,
      );
      const other = group.filter((entry) => !isCiObservation(entry));
      selected.push(...latestOrdered, ...unorderedCi);
      if (other.length)
        selected.push(
          other.reduce((latest, entry) => (evidenceIsNewer(entry, latest) ? entry : latest)),
        );
      continue;
    }
    selected.push(
      group.reduce((latest, entry) => (evidenceIsNewer(entry, latest) ? entry : latest)),
    );
  }
  return selected;
}

function archivedIdentityContent(
  entry: EconomicsRollup['archivedEvidence'][number],
  identityDigest: string,
): string | undefined {
  if (entry.identityDigest === identityDigest) return entry.contentDigest;
  return entry.identityAliases.find((alias) => alias.identityDigest === identityDigest)
    ?.contentDigest;
}

function evidenceArchivedBy(entry: TaskEvidence, rollup: EconomicsRollup | undefined): boolean {
  const identityDigest = evidenceIdentityDigest(entry.id);
  const archived = [
    ...(rollup?.archivedTombstones ?? []),
    ...(rollup?.archivedEvidence ?? []),
  ].find((candidate) => archivedIdentityContent(candidate, identityDigest) !== undefined);
  if (!archived) return false;
  if (!archivedEvidenceContentMatches(entry, archivedIdentityContent(archived, identityDigest)!))
    throw new Error(`Evidence identity ${entry.id} was reused with different content.`);
  return (
    archived.sequence === undefined ||
    entry.sequence === undefined ||
    archived.sequence >= entry.sequence
  );
}

function ciExecutionArchived(entry: TaskEvidence, rollup: EconomicsRollup | undefined): boolean {
  return (
    isCiObservation(entry) &&
    rollup?.archivedEvidence.some((candidate) => {
      const contentDigest = archivedIdentityContent(candidate, evidenceIdentityDigest(entry.id));
      return contentDigest !== undefined && archivedEvidenceContentMatches(entry, contentDigest);
    }) === true
  );
}

function mergeCiEconomics(
  newest: TaskEvidence['economics'],
  left: TaskEvidence['economics'],
  right: TaskEvidence['economics'],
  result: TaskEvidence['result'],
): TaskEvidence['economics'] {
  const base = newest ?? left ?? right;
  if (!base) return undefined;
  return {
    ...base,
    failedCommands: Math.max(
      result === 'failed' ? 1 : 0,
      left?.failedCommands ?? 0,
      right?.failedCommands ?? 0,
    ),
  };
}

function normalizeGateEconomics(entry: TaskEvidence): TaskEvidence {
  if (entry.kind !== 'gate' || !entry.economics) return entry;
  const phase =
    entry.name === 'test-adversary'
      ? 'test'
      : ['code-adversary', 'findings-adversary'].includes(entry.name)
        ? 'review'
        : undefined;
  return phase ? { ...entry, economics: { ...entry.economics, role: 'validator', phase } } : entry;
}

function normalizeEvidenceSequences(manifests: EvidenceManifest[]): EvidenceManifest[] {
  const rollup = combinedRollup(manifests);
  let highWater = Math.max(
    archivedSequenceHighWater(manifests),
    ...manifests.flatMap((manifest) => manifest.evidence.map((entry) => entry.sequence ?? 0)),
  );
  const identities = new Map<string, string>();
  const unique = new Map<string, TaskEvidence>();
  for (const manifest of manifests)
    for (const entry of manifest.evidence) {
      const content = evidenceIdentityContent(entry);
      const existing = identities.get(entry.id);
      if (existing !== undefined) {
        if (existing !== content)
          throw new Error(`Evidence identity ${entry.id} was reused with different content.`);
        const previous = unique.get(entry.id)!;
        if (evidenceIsNewer(entry, previous)) unique.set(entry.id, entry);
        continue;
      }
      identities.set(entry.id, content);
      unique.set(entry.id, entry);
    }
  const assigned = new Map<string, number>();
  const collisions = new Map<number, TaskEvidence[]>();
  const unassigned: TaskEvidence[] = [];
  for (const entry of unique.values()) {
    if (
      entry.sequence === undefined ||
      (sequenceIsArchived(manifests, entry.sequence) && !ciExecutionArchived(entry, rollup))
    ) {
      unassigned.push(entry);
      continue;
    }
    const group = collisions.get(entry.sequence) ?? [];
    group.push(entry);
    collisions.set(entry.sequence, group);
  }
  const order = (left: TaskEvidence, right: TaskEvidence) =>
    left.timestamp - right.timestamp || left.id.localeCompare(right.id);
  for (const [sequence, entries] of [...collisions.entries()].toSorted(
    ([left], [right]) => left - right,
  )) {
    const ordered = entries.toSorted(order);
    assigned.set(ordered[0].id, sequence);
    unassigned.push(...ordered.slice(1));
  }
  for (const entry of unassigned.toSorted(order)) {
    if (highWater >= maxEconomicsCounter) throw new Error('Evidence sequence limit reached.');
    assigned.set(entry.id, ++highWater);
  }
  const emitted = new Set<string>();
  return manifests.map((manifest) => ({
    ...manifest,
    evidence: manifest.evidence.flatMap((entry) => {
      if (emitted.has(entry.id)) return [];
      emitted.add(entry.id);
      const selected = unique.get(entry.id)!;
      return [{ ...selected, sequence: assigned.get(entry.id)! }];
    }),
  }));
}

function moveRollup(
  manifests: EvidenceManifest[],
  rollup: EconomicsRollup | undefined,
  hostIndex = 0,
): EvidenceManifest[] {
  if (!manifests.length) return manifests;
  return manifests.map((manifest, index) => {
    const next = { ...manifest };
    delete next.economicsRollup;
    return rollup && index === hostIndex ? { ...next, economicsRollup: rollup } : next;
  });
}

function withBoundedEvidence(
  manifest: EvidenceManifest,
  evidence: TaskEvidence[],
): EvidenceManifest {
  const sorted = evidence.toSorted(compareEvidence);
  if (sorted.length <= evidenceHistoryLimit) return { ...manifest, evidence: sorted };
  const retained = boundEvidence(sorted);
  const retainedIds = new Set(retained.map((entry) => entry.id));
  const evicted = sorted.filter((entry) => !retainedIds.has(entry.id));
  return {
    ...manifest,
    evidence: retained,
    economicsRollup: rollUpEconomics(manifest.economicsRollup, evicted),
  };
}

export function nextTaskEvidenceSequence(manifests: EvidenceManifest[], offset = 0): number {
  return (
    Math.max(
      0,
      ...manifests.flatMap((manifest) =>
        manifest.evidence.map((candidate) => candidate.sequence ?? 0),
      ),
    ) +
    offset +
    1
  );
}

export function mergeEvidenceManifests(
  current: EvidenceManifest[],
  incoming: EvidenceManifest[],
): EvidenceManifest[] {
  const parsedCurrent = evidenceManifestsSchema.parse(current);
  const parsedIncoming = evidenceManifestsSchema.parse(incoming);
  const currentRollup = combinedRollup(parsedCurrent);
  const incomingRollup = combinedRollup(parsedIncoming);
  const merged = new Map(
    parsedCurrent.map((manifest) => [
      manifestIdentity(manifest.revision, manifest.baseRevision),
      {
        ...manifest,
        evidence: manifest.evidence.filter((entry) => !evidenceArchivedBy(entry, incomingRollup)),
      },
    ]),
  );
  for (const candidate of parsedIncoming) {
    const key = manifestIdentity(candidate.revision, candidate.baseRevision);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...candidate,
        evidence: candidate.evidence.filter((entry) => !evidenceArchivedBy(entry, currentRollup)),
      });
      continue;
    }
    const latest = candidate.updatedAt >= existing.updatedAt ? candidate : existing;
    const economicsRollup = combinedRollup([existing, candidate]);
    const evidence = new Map(
      existing.evidence
        .filter((entry) => !evidenceArchivedBy(entry, incomingRollup))
        .map((entry) => [entry.id, entry]),
    );
    for (const entry of candidate.evidence) {
      if (evidenceArchivedBy(entry, currentRollup)) continue;
      const previous = evidence.get(entry.id);
      if (!previous) evidence.set(entry.id, entry);
      else if (
        isCiObservation(entry) &&
        isCiObservation(previous) &&
        ciObservationContent(entry) === ciObservationContent(previous)
      ) {
        const newest = evidenceIsNewer(entry, previous) ? entry : previous;
        evidence.set(entry.id, {
          ...newest,
          economics: mergeCiEconomics(
            newest.economics,
            entry.economics,
            previous.economics,
            newest.result,
          ),
        });
      } else if (evidenceIdentityContent(entry) !== evidenceIdentityContent(previous))
        throw new Error(`Evidence identity ${entry.id} was reused with different content.`);
    }
    merged.set(key, {
      ...latest,
      evidence: [...evidence.values()].toSorted(compareEvidence),
      economicsRollup,
      createdAt: Math.min(existing.createdAt, candidate.createdAt),
      updatedAt: Math.max(existing.updatedAt, candidate.updatedAt),
    });
  }
  const normalized = normalizeEvidenceSequences([...merged.values()]).map((manifest) =>
    withBoundedEvidence(manifest, manifest.evidence),
  );
  return evidenceManifestsSchema.parse(boundEvidenceManifests(normalized));
}

export function requireEvidenceRevision(expected: unknown, current: string): void {
  if (typeof expected !== 'string' || !expected)
    throw new Error('Evidence needs the revision captured before execution.');
  if (expected !== current)
    throw new Error('The worktree changed after execution started. Rerun the evidence.');
}

export type EvidenceExecutionBoundary = {
  revision: string;
  mutationGeneration: string;
  baseRevision: string;
};

export function requireEvidenceExecutionBoundary(
  expected: {
    revision: unknown;
    mutationGeneration: unknown;
    baseRevision: unknown;
  },
  current: EvidenceExecutionBoundary,
): void {
  requireEvidenceRevision(expected.revision, current.revision);
  if (typeof expected.mutationGeneration !== 'string' || !expected.mutationGeneration)
    throw new Error('Evidence needs the mutation generation captured before execution.');
  if (expected.mutationGeneration !== current.mutationGeneration)
    throw new Error('The worktree was modified after execution started. Rerun the evidence.');
  if (typeof expected.baseRevision !== 'string' || !expected.baseRevision)
    throw new Error('Evidence needs the shipping base captured before execution.');
  if (expected.baseRevision !== current.baseRevision)
    throw new Error('The shipping base changed after execution started. Rerun the evidence.');
}

export async function readStableEvidenceBoundary(
  readRevision: () => Promise<string>,
  readMutationGeneration: () => Promise<string>,
  readBaseRevision: () => Promise<string>,
  maxAttempts = 3,
): Promise<EvidenceExecutionBoundary> {
  async function readAttempt(attemptsRemaining: number): Promise<EvidenceExecutionBoundary> {
    const mutationGeneration = await readMutationGeneration();
    const [revision, baseRevision] = await Promise.all([readRevision(), readBaseRevision()]);
    const [currentRevision, currentMutationGeneration, currentBaseRevision] = await Promise.all([
      readRevision(),
      readMutationGeneration(),
      readBaseRevision(),
    ]);
    if (
      revision === currentRevision &&
      mutationGeneration === currentMutationGeneration &&
      baseRevision === currentBaseRevision
    )
      return { revision, mutationGeneration, baseRevision };
    if (attemptsRemaining > 1) return readAttempt(attemptsRemaining - 1);
    throw new Error('The worktree kept changing while capturing evidence. Retry when stable.');
  }

  return readAttempt(Math.max(1, maxAttempts));
}

export async function commitRevisionBoundEvidence({
  expected,
  readBoundary,
  commit,
}: {
  expected: EvidenceExecutionBoundary;
  readBoundary: () => Promise<EvidenceExecutionBoundary>;
  commit: (registerRollback: (rollback: () => Promise<void>) => void) => Promise<void>;
}): Promise<void> {
  const verify = async () => requireEvidenceExecutionBoundary(expected, await readBoundary());
  await verify();
  let rollback: (() => Promise<void>) | undefined;
  try {
    await commit((candidate) => (rollback = candidate));
    await verify();
  } catch (cause) {
    try {
      await rollback?.();
    } catch (rollbackCause) {
      throw new Error(`Evidence commit failed (${String(cause)}) and rollback failed.`, {
        cause: rollbackCause,
      });
    }
    throw cause;
  }
}

function canonicalEvidenceValue(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );
}

function sameEvidenceValue(left: unknown, right: unknown): boolean {
  return canonicalEvidenceValue(left) === canonicalEvidenceValue(right);
}

export function rollbackTaskEvidenceRecord(
  current: { evidenceRevision?: string; evidenceManifests?: EvidenceManifest[] },
  previous: { evidenceRevision?: string; evidenceManifests?: EvidenceManifest[] },
  committed: { evidenceRevision?: string; evidenceManifests?: EvidenceManifest[] },
  evidenceId: string,
): { evidenceRevision?: string; evidenceManifests: EvidenceManifest[] } {
  const previousByIdentity = new Map(
    (previous.evidenceManifests ?? []).map((manifest) => [
      manifestIdentity(manifest.revision, manifest.baseRevision),
      manifest,
    ]),
  );
  const committedByIdentity = new Map(
    (committed.evidenceManifests ?? []).map((manifest) => [
      manifestIdentity(manifest.revision, manifest.baseRevision),
      manifest,
    ]),
  );
  const evidenceManifests = (current.evidenceManifests ?? []).flatMap((manifest) => {
    const key = manifestIdentity(manifest.revision, manifest.baseRevision);
    const prior = previousByIdentity.get(key);
    const saved = committedByIdentity.get(key);
    if (!saved) return [manifest];
    const savedEntry = saved.evidence.find((entry) => entry.id === evidenceId);
    const evidence = savedEntry
      ? manifest.evidence.filter(
          (entry) => entry.id !== evidenceId || !sameEvidenceValue(entry, savedEntry),
        )
      : manifest.evidence;
    const evicted = (prior?.evidence ?? []).filter(
      (entry) =>
        !saved.evidence.some((candidate) => candidate.id === entry.id) &&
        !evidence.some((candidate) => candidate.id === entry.id),
    );
    const withoutRecord = { ...manifest, evidence: boundEvidence([...evidence, ...evicted]) };
    if (
      prior &&
      sameEvidenceValue(withoutRecord.evidence, prior.evidence) &&
      sameEvidenceValue({ ...manifest, evidence: saved.evidence }, saved)
    )
      return [prior];
    if (!prior && !evidence.length && sameEvidenceValue(withoutRecord, { ...saved, evidence: [] }))
      return [];
    return [withoutRecord];
  });
  return {
    evidenceManifests,
    evidenceRevision:
      current.evidenceRevision === committed.evidenceRevision &&
      sameEvidenceValue(evidenceManifests, previous.evidenceManifests ?? [])
        ? previous.evidenceRevision
        : current.evidenceRevision,
  };
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
  baseRevision?: string,
): EvidenceManifest[] {
  if (!revision) throw new Error('Evidence needs a source revision.');
  const criteria = z.array(z.string().min(1).max(2000)).min(1).max(100).parse(acceptanceCriteria);
  let found = false;
  const synced: EvidenceManifest[] = [];
  for (const manifest of evidenceManifestsSchema.parse(manifests)) {
    const current =
      manifest.revision === revision && manifest.baseRevision === (baseRevision ?? null);
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
      baseRevision: baseRevision ?? null,
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
  baseRevision?: string,
): EvidenceManifest[] {
  const parsedEntry = normalizeGateEconomics(taskEvidenceSchema.parse(evidence));
  const synced = syncEvidenceManifest(
    manifests,
    revision,
    acceptanceCriteria,
    parsedEntry.timestamp,
    baseRevision,
  );
  const existingIdentity = synced
    .flatMap((manifest) => manifest.evidence)
    .find((candidate) => candidate.id === parsedEntry.id);
  if (existingIdentity) {
    if (evidenceIdentityContent(existingIdentity) === evidenceIdentityContent(parsedEntry))
      return synced;
    throw new Error(`Evidence identity ${parsedEntry.id} was reused with different content.`);
  }
  const rollup = combinedRollup(synced);
  const archivedIdentity = [
    ...(rollup?.archivedTombstones ?? []),
    ...(rollup?.archivedEvidence ?? []),
  ].find(
    (candidate) =>
      archivedIdentityContent(candidate, evidenceIdentityDigest(parsedEntry.id)) !== undefined,
  );
  if (
    archivedIdentity &&
    !archivedEvidenceContentMatches(
      parsedEntry,
      archivedIdentityContent(archivedIdentity, evidenceIdentityDigest(parsedEntry.id))!,
    )
  )
    throw new Error(`Evidence identity ${parsedEntry.id} was reused with different content.`);
  if (
    archivedIdentity &&
    (!isCiObservation(parsedEntry) ||
      archivedIdentity.identityDigest !== evidenceIdentityDigest(parsedEntry.id))
  )
    return synced;
  const highWater = Math.max(
    archivedSequenceHighWater(synced),
    ...synced.flatMap((manifest) => manifest.evidence.map((candidate) => candidate.sequence ?? 0)),
  );
  if (highWater >= maxEconomicsCounter && parsedEntry.sequence === undefined)
    throw new Error('Evidence sequence limit reached.');
  const entry = { ...parsedEntry, sequence: parsedEntry.sequence ?? highWater + 1 };
  const unknown = entry.criteria.filter((criterion) => !acceptanceCriteria.includes(criterion));
  if (unknown.length)
    throw new Error(`Evidence references unknown acceptance criteria: ${unknown.join(', ')}`);
  const index = synced.findIndex(
    (manifest) =>
      manifest.revision === revision && manifest.baseRevision === (baseRevision ?? null),
  );
  const normalized = moveRollup(synced, combinedRollup(synced), index);
  const manifest = normalized[index];
  return normalized.with(
    index,
    withBoundedEvidence(
      {
        ...manifest,
        updatedAt: Math.max(manifest.createdAt, manifest.updatedAt, entry.timestamp),
      },
      [...manifest.evidence, entry],
    ),
  );
}

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

export type CiEvidenceIdentityInput = {
  name: string;
  url: string;
  databaseId?: number;
  runId?: number;
  attempt?: number;
  statusContextId?: string;
  identityUncertain?: boolean;
};

export function ciEvidenceIdentity(
  revision: string,
  check: CiEvidenceIdentityInput,
): {
  id: string;
  uncertain: boolean;
  reconciliationKey: string;
  executionOrder?: [number, number];
} {
  const stableRun = check.runId ?? check.databaseId;
  const stableStatus = check.statusContextId;
  const uncertain =
    check.identityUncertain === true || (stableRun === undefined && stableStatus === undefined);
  const execution =
    stableRun !== undefined
      ? `${revision}\u0000${check.name}\u0000${check.runId ?? 'no-run'}\u0000${
          check.databaseId ?? 'no-check'
        }\u0000${check.attempt ?? 1}`
      : stableStatus !== undefined
        ? `${revision}\u0000${check.name}\u0000status\u0000${stableStatus}`
        : `${revision}\u0000${check.name}\u0000legacy\u0000${check.url}`;
  return {
    id: `ci:${stableIdentity(execution)}`,
    uncertain,
    reconciliationKey: stableIdentity(`${revision}\u0000${check.name}`),
    executionOrder:
      stableRun === undefined ? undefined : [check.runId ?? check.databaseId!, check.attempt ?? 1],
  };
}

export function recordCiEvidenceObservation(
  manifests: EvidenceManifest[],
  revision: string,
  acceptanceCriteria: string[],
  evidence: TaskEvidence,
  baseRevision?: string,
): EvidenceManifest[] {
  const parsedEntry = taskEvidenceSchema.parse(evidence);
  if (!isCiObservation(parsedEntry))
    throw new Error('CI observations require a stable CI identity and GitHub command evidence.');
  let synced = syncEvidenceManifest(
    manifests,
    revision,
    acceptanceCriteria,
    parsedEntry.timestamp,
    baseRevision,
  );
  let rollup = combinedRollup(synced);
  const mutableArchive = [
    ...(rollup?.stateVersion !== undefined && rollup.stateVersion >= 3
      ? rollup.archivedTombstones.filter((candidate) => candidate.metadataComplete)
      : []),
    ...(rollup?.archivedEvidence ?? []),
  ];
  const archivedExecution = mutableArchive.some(
    (candidate) =>
      archivedIdentityContent(candidate, evidenceIdentityDigest(parsedEntry.id)) !== undefined,
  );
  if (rollup && archivedExecution) {
    const updated = updateArchivedEconomicsEvidence(rollup, parsedEntry);
    const index = synced.findIndex(
      (manifest) =>
        manifest.revision === revision && manifest.baseRevision === (baseRevision ?? null),
    );
    synced = moveRollup(synced, updated, index);
    rollup = updated;
  }
  if (parsedEntry.identityUncertain === true) {
    const index = synced.findIndex(
      (manifest) =>
        manifest.revision === revision &&
        manifest.baseRevision === (baseRevision ?? null) &&
        !manifest.stale,
    );
    const manifest = synced[index];
    const stable = matchingStableCiObservation(manifest?.evidence ?? [], parsedEntry);
    if (stable) {
      if (parsedEntry.timestamp < stable.timestamp) return synced;
      return synced.with(index, {
        ...manifest,
        evidence: manifest.evidence.flatMap((candidate) => {
          if (candidate.id === parsedEntry.id && candidate !== stable) return [];
          if (candidate !== stable) return [candidate];
          return [
            {
              ...stable,
              result: parsedEntry.result,
              timestamp: parsedEntry.timestamp,
              outputReference: parsedEntry.outputReference,
              criteria: parsedEntry.criteria,
              economics: mergeCiEconomics(
                parsedEntry.economics,
                stable.economics,
                parsedEntry.economics,
                parsedEntry.result,
              ),
            },
          ];
        }),
        updatedAt: Math.max(manifest.updatedAt, parsedEntry.timestamp),
      });
    }
    if (rollup) {
      const exact = manifest?.evidence.find((candidate) => candidate.id === parsedEntry.id);
      if (exact) {
        if (ciObservationContent(exact) !== ciObservationContent(parsedEntry))
          throw new Error(`Evidence identity ${parsedEntry.id} was reused with different content.`);
      } else {
        const reconciled = reconcileArchivedEconomicsEvidence(
          rollup,
          parsedEntry.reconciliationKey!,
          parsedEntry,
        );
        if (reconciled !== rollup) {
          const moved = moveRollup(synced, reconciled, index);
          const highWater = Math.max(
            archivedSequenceHighWater(moved),
            ...moved.flatMap((candidate) => candidate.evidence.map((entry) => entry.sequence ?? 0)),
          );
          if (highWater >= maxEconomicsCounter) throw new Error('Evidence sequence limit reached.');
          const restored = { ...parsedEntry, sequence: highWater + 1 };
          return moved.with(
            index,
            withBoundedEvidence(
              {
                ...moved[index],
                updatedAt: Math.max(moved[index].updatedAt, parsedEntry.timestamp),
              },
              [...moved[index].evidence, restored],
            ),
          );
        }
      }
    }
  }
  if (parsedEntry.identityUncertain !== true && parsedEntry.reconciliationKey) {
    const retained = synced.flatMap((manifest, manifestIndex) =>
      manifest.evidence.map((candidate, evidenceIndex) => ({
        candidate,
        manifestIndex,
        evidenceIndex,
      })),
    );
    const legacy = retained.filter(
      ({ candidate }) =>
        isCiObservation(candidate) &&
        candidate.identityUncertain === true &&
        candidate.reconciliationKey === parsedEntry.reconciliationKey,
    );
    const matchingLegacy = legacy.filter(
      ({ candidate }) => candidate.outputReference === parsedEntry.outputReference,
    );
    if (matchingLegacy.length === 1) {
      const previous = matchingLegacy[0];
      const exact = retained.find(
        ({ candidate }) => candidate.id === parsedEntry.id && candidate !== previous.candidate,
      );
      const competing = retained.some(
        ({ candidate }) =>
          isCiObservation(candidate) &&
          candidate !== exact?.candidate &&
          candidate.identityUncertain !== true &&
          candidate.reconciliationKey === parsedEntry.reconciliationKey &&
          candidate.outputReference === parsedEntry.outputReference,
      );
      const ambiguous =
        competing || previous.candidate.outputReference !== parsedEntry.outputReference;
      if (exact)
        return synced.map((manifest) => ({
          ...manifest,
          evidence: manifest.evidence.flatMap((candidate) => {
            if (candidate === previous.candidate) return [];
            if (candidate !== exact.candidate) return [candidate];
            return [
              {
                ...parsedEntry,
                sequence: candidate.sequence,
                economics: mergeCiEconomics(
                  parsedEntry.economics,
                  candidate.economics,
                  previous.candidate.economics,
                  parsedEntry.result,
                ),
                identityUncertain: ambiguous,
              },
            ];
          }),
          updatedAt: Math.max(manifest.updatedAt, parsedEntry.timestamp),
        }));
      return synced.with(previous.manifestIndex, {
        ...synced[previous.manifestIndex],
        evidence: synced[previous.manifestIndex].evidence.with(previous.evidenceIndex, {
          ...parsedEntry,
          sequence: previous.candidate.sequence,
          economics: mergeCiEconomics(
            parsedEntry.economics,
            previous.candidate.economics,
            parsedEntry.economics,
            parsedEntry.result,
          ),
          identityUncertain: ambiguous,
        }),
        updatedAt: Math.max(synced[previous.manifestIndex].updatedAt, parsedEntry.timestamp),
      });
    }
    const archivedEntries = [
      ...(rollup?.stateVersion !== undefined && rollup.stateVersion >= 3
        ? rollup.archivedTombstones.filter((candidate) => candidate.metadataComplete)
        : []),
      ...(rollup?.archivedEvidence ?? []),
    ];
    const archivedLegacy = archivedEntries.filter(
      (candidate) =>
        candidate.metadataComplete &&
        candidate.reconciliationDigest === parsedEntry.reconciliationKey &&
        candidate.identityUncertain &&
        candidate.referenceDigest === evidenceReferenceDigest(parsedEntry),
    );
    if (rollup && archivedLegacy?.length === 1) {
      const stableCollision = archivedEntries.some(
        (candidate) =>
          candidate.identityDigest === evidenceIdentityDigest(parsedEntry.id) &&
          !candidate.identityUncertain,
      );
      const competing =
        (!stableCollision &&
          archivedEntries.some(
            (candidate) =>
              candidate.reconciliationDigest === parsedEntry.reconciliationKey &&
              !candidate.identityUncertain &&
              candidate.referenceDigest === evidenceReferenceDigest(parsedEntry),
          )) ||
        retained.some(
          ({ candidate }) =>
            candidate.reconciliationKey === parsedEntry.reconciliationKey &&
            candidate.identityUncertain !== true,
        );
      const ambiguous =
        !stableCollision &&
        (competing || archivedLegacy[0].referenceDigest !== evidenceReferenceDigest(parsedEntry));
      const reconciledEntry = { ...parsedEntry, identityUncertain: ambiguous };
      const reconciled = rekeyArchivedEconomicsEvidence(
        rollup,
        parsedEntry.reconciliationKey,
        reconciledEntry,
        ambiguous,
      );
      const index = synced.findIndex(
        (manifest) =>
          manifest.revision === revision && manifest.baseRevision === (baseRevision ?? null),
      );
      return recordTaskEvidence(
        moveRollup(synced, reconciled, index),
        revision,
        acceptanceCriteria,
        reconciledEntry,
        baseRevision,
      );
    }
  }
  for (let manifestIndex = 0; manifestIndex < synced.length; manifestIndex += 1) {
    const evidenceIndex = synced[manifestIndex].evidence.findIndex(
      (candidate) => candidate.id === parsedEntry.id,
    );
    if (evidenceIndex < 0) continue;
    const previous = synced[manifestIndex].evidence[evidenceIndex];
    if (ciObservationContent(previous) !== ciObservationContent(parsedEntry))
      throw new Error(`Evidence identity ${parsedEntry.id} was reused with different content.`);
    if (parsedEntry.timestamp < previous.timestamp) return synced;
    if (previous.result === parsedEntry.result && previous.timestamp === parsedEntry.timestamp)
      return synced;
    const replacement = {
      ...parsedEntry,
      sequence: previous.sequence,
      economics:
        parsedEntry.economics && previous.economics
          ? {
              ...parsedEntry.economics,
              failedCommands: Math.max(
                parsedEntry.economics.failedCommands,
                previous.economics.failedCommands,
              ),
            }
          : parsedEntry.economics,
    };
    return synced.with(manifestIndex, {
      ...synced[manifestIndex],
      evidence: synced[manifestIndex].evidence.with(evidenceIndex, replacement),
      updatedAt: Math.max(synced[manifestIndex].updatedAt, parsedEntry.timestamp),
    });
  }
  return recordTaskEvidence(synced, revision, acceptanceCriteria, parsedEntry, baseRevision);
}

export function reconcileCiEvidenceSnapshot(
  manifests: EvidenceManifest[],
  revision: string,
  observations: TaskEvidence[],
  baseRevision?: string,
): EvidenceManifest[] {
  const parsed = evidenceManifestsSchema.parse(manifests);
  const snapshot = observations.map((entry) => taskEvidenceSchema.parse(entry));
  if (snapshot.some((entry) => !isCiObservation(entry)))
    throw new Error('CI snapshots require GitHub command evidence.');
  const index = parsed.findIndex(
    (manifest) =>
      manifest.revision === revision &&
      manifest.baseRevision === (baseRevision ?? null) &&
      !manifest.stale,
  );
  if (index < 0) return parsed;
  const active = new Set(snapshot.map((entry) => entry.id));
  for (const observation of snapshot) {
    const stable = matchingStableCiObservation(parsed[index].evidence, observation);
    if (stable) active.add(stable.id);
  }
  const evicted = parsed[index].evidence.filter(
    (entry) => isCiObservation(entry) && !active.has(entry.id),
  );
  if (!evicted.length) return parsed;
  const rollup = rollUpEconomics(combinedRollup(parsed), evicted);
  const moved = moveRollup(parsed, rollup, index);
  return moved.with(index, {
    ...moved[index],
    evidence: moved[index].evidence.filter(
      (entry) => !isCiObservation(entry) || active.has(entry.id),
    ),
    updatedAt: Math.max(moved[index].updatedAt, ...snapshot.map((entry) => entry.timestamp)),
  });
}

export function evidenceReadiness(
  manifests: EvidenceManifest[],
  revision: string | null | undefined,
  requiredGates: string[],
  acceptanceCriteria: string[],
  baseRevision?: string,
): EvidenceReadiness {
  const manifest = revision
    ? manifests.find(
        (candidate) =>
          candidate.revision === revision &&
          candidate.baseRevision === (baseRevision ?? null) &&
          !candidate.stale,
      )
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
  const latest = latestOutcomeEvidence(manifest.evidence);
  const missingGates: string[] = [];
  const failedGates: string[] = [];
  const pendingGates: string[] = [];
  for (const gate of requiredGates) {
    const entry = latest.find((candidate) => candidate.kind === 'gate' && candidate.name === gate);
    if (!entry) missingGates.push(gate);
    else if (['failed', 'blocked'].includes(entry.result)) failedGates.push(gate);
    else if (entry.result !== 'passed') pendingGates.push(gate);
  }
  const failedCommands = [
    ...new Set(
      latest
        .filter((entry) => entry.kind === 'command' && ['failed', 'blocked'].includes(entry.result))
        .map((entry) => entry.name),
    ),
  ];
  const pendingCommands = [
    ...new Set(
      latest
        .filter((entry) => entry.kind === 'command' && entry.result === 'pending')
        .map((entry) => entry.name),
    ),
  ];
  const verified = new Set(
    latest.filter((entry) => entry.result === 'passed').flatMap((entry) => entry.criteria),
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

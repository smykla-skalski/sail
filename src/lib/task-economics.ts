import { z } from 'zod';
import type { EvidenceManifest, EvidenceReadiness, TaskEvidence } from './task-evidence.ts';

export const taskActivityRoles = [
  'primary',
  'subagent',
  'validator',
  'guardian',
  'synthetic',
  'probe',
] as const;

export const taskActivityPhases = [
  'resolve',
  'orchestrate',
  'explore',
  'branch',
  'implement',
  'review',
  'test',
  'ci',
  'pr',
  'complete',
] as const;

export const archivedEvidenceIdentityLimit = 1_024;
const archivedEvidenceAliasLimit = archivedEvidenceIdentityLimit;
export const maxEconomicsCounter = Number.MAX_SAFE_INTEGER;
const counter = z.number().int().nonnegative().max(maxEconomicsCounter);

export const economicsTotalsSchema = z
  .object({
    turns: counter,
    toolCalls: counter,
    permissionRequests: counter,
    compactions: counter,
    tokens: z
      .object({
        input: counter,
        output: counter,
        reasoning: counter,
        cacheRead: counter,
        cacheWrite: counter,
      })
      .strict(),
    elapsedMs: counter,
    retries: counter,
    findings: counter,
    checks: counter,
    humanInterventions: counter,
    failedCommands: counter,
    approvalLatencyMs: counter,
    repeatedWork: counter,
  })
  .strict();

export const taskEconomicsSchema = z
  .object({
    role: z.enum(taskActivityRoles),
    phase: z.enum(taskActivityPhases),
    ...economicsTotalsSchema.shape,
  })
  .strict()
  .refine(
    (economics) =>
      economics.turns > 0 ||
      economics.toolCalls > 0 ||
      economics.permissionRequests > 0 ||
      economics.compactions > 0 ||
      Object.values(economics.tokens).some((tokens) => tokens > 0) ||
      economics.elapsedMs > 0 ||
      economics.retries > 0 ||
      economics.findings > 0 ||
      economics.checks > 0 ||
      economics.humanInterventions > 0 ||
      economics.failedCommands > 0 ||
      economics.approvalLatencyMs > 0 ||
      economics.repeatedWork > 0,
    'Economics must record at least one unit of measured activity.',
  );

const economicsAttributionSchema = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(500).nullable(),
    role: z.enum(taskActivityRoles),
    phase: z.enum(taskActivityPhases),
    bucket: z.boolean().default(false),
    samples: counter,
    totals: economicsTotalsSchema,
  })
  .strict();

const archivedEconomicsEvidenceSchema = z
  .object({
    identityDigest: z.string().length(32),
    contentDigest: z.string().length(32),
    sequence: counter.optional(),
    economics: taskEconomicsSchema.nullable().default(null),
    provider: z.string().min(1).max(200).default('unknown'),
    model: z.string().min(1).max(500).nullable().default(null),
    reconciliationDigest: z.string().length(16).optional(),
    identityUncertain: z.boolean().default(false),
    referenceDigest: z.string().length(32).default('0'.repeat(32)),
    metadataComplete: z.boolean().default(true),
    identityAliases: z
      .array(
        z
          .object({
            identityDigest: z.string().length(32),
            contentDigest: z.string().length(32),
          })
          .strict(),
      )
      .max(archivedEvidenceAliasLimit)
      .default([]),
  })
  .strict();

export type TaskEconomics = z.infer<typeof taskEconomicsSchema>;
export type TaskActivityRole = TaskEconomics['role'];
export type EconomicsTotals = z.infer<typeof economicsTotalsSchema>;

export const economicsRollupSchema = z
  .object({
    archivedSequenceRanges: z.array(z.tuple([counter, counter])).max(100),
    archivedEntries: counter,
    samples: counter,
    missingSamples: counter,
    totals: economicsTotalsSchema,
    byRole: z
      .array(z.object({ role: z.enum(taskActivityRoles), totals: economicsTotalsSchema }).strict())
      .max(taskActivityRoles.length),
    byAttribution: z
      .array(economicsAttributionSchema)
      .max(archivedEvidenceIdentityLimit)
      .default([]),
    overflowed: z.boolean(),
    identityCoverageComplete: z.boolean().default(true),
    attributionCoverageComplete: z.boolean().default(true),
    identityHorizonTruncated: z.boolean().default(false),
    causalDigest: z.string().length(32).default('0'.repeat(32)),
    causalPrefixDigest: z.string().length(32).default('0'.repeat(32)),
    causalAncestors: z.array(z.string().length(32)).max(1_024).default([]),
    causalProofComplete: z.boolean().default(false),
    causalProofVersion: z.number().int().min(0).max(2).default(0),
    incompleteCausalLineage: z.string().length(32).nullable().default(null),
    incompleteCausalGeneration: counter.default(0),
    incompleteCausalAncestors: z.array(z.string().length(32)).max(1_024).default([]),
    stateVersion: z.number().int().min(0).max(4).default(0),
    stateDigest: z.string().length(32).nullable().default(null),
    archivedTombstones: z
      .array(archivedEconomicsEvidenceSchema)
      .max(archivedEvidenceIdentityLimit)
      .default([]),
    archivedEvidence: z
      .array(archivedEconomicsEvidenceSchema)
      .max(archivedEvidenceIdentityLimit)
      .default([]),
  })
  .strict();

export type EconomicsRollup = z.infer<typeof economicsRollupSchema>;

export const emptyTaskEconomics = (role: TaskActivityRole, phase: TaskEconomics['phase']) => ({
  role,
  phase,
  turns: 0,
  toolCalls: 0,
  permissionRequests: 0,
  compactions: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  elapsedMs: 0,
  retries: 0,
  findings: 0,
  checks: 0,
  humanInterventions: 0,
  failedCommands: 0,
  approvalLatencyMs: 0,
  repeatedWork: 0,
});

export function syntheticCiEconomics(): TaskEconomics {
  return { ...emptyTaskEconomics('synthetic', 'ci'), checks: 1 };
}

export type TaskEconomicsSummary = {
  outcomeAccepted: boolean;
  accepted: boolean;
  economicsComplete: boolean;
  lifetimeEconomicsComplete: boolean;
  lifetimeTruncated: boolean;
  identityCoverageComplete: boolean;
  attributionCoverageComplete: boolean;
  overflowed: boolean;
  samples: number;
  missingSamples: number;
  totals: EconomicsTotals;
  byRole: Partial<Record<TaskActivityRole, EconomicsTotals>>;
};

function safeAdd(left: number, right: number): [number, boolean] {
  const sum = left + right;
  return sum > maxEconomicsCounter ? [maxEconomicsCounter, true] : [sum, false];
}

export function addEconomicsTotals(
  total: EconomicsTotals,
  sample: EconomicsTotals,
): { totals: EconomicsTotals; overflowed: boolean } {
  let overflowed = false;
  const add = (left: number, right: number) => {
    const [value, overflow] = safeAdd(left, right);
    overflowed ||= overflow;
    return value;
  };
  const totals = {
    turns: add(total.turns, sample.turns),
    toolCalls: add(total.toolCalls, sample.toolCalls),
    permissionRequests: add(total.permissionRequests, sample.permissionRequests),
    compactions: add(total.compactions, sample.compactions),
    tokens: {
      input: add(total.tokens.input, sample.tokens.input),
      output: add(total.tokens.output, sample.tokens.output),
      reasoning: add(total.tokens.reasoning, sample.tokens.reasoning),
      cacheRead: add(total.tokens.cacheRead, sample.tokens.cacheRead),
      cacheWrite: add(total.tokens.cacheWrite, sample.tokens.cacheWrite),
    },
    elapsedMs: add(total.elapsedMs, sample.elapsedMs),
    retries: add(total.retries, sample.retries),
    findings: add(total.findings, sample.findings),
    checks: add(total.checks, sample.checks),
    humanInterventions: add(total.humanInterventions, sample.humanInterventions),
    failedCommands: add(total.failedCommands, sample.failedCommands),
    approvalLatencyMs: add(total.approvalLatencyMs, sample.approvalLatencyMs),
    repeatedWork: add(total.repeatedWork, sample.repeatedWork),
  };
  return { totals, overflowed };
}

export function totalEconomicsTokens(tokens: EconomicsTotals['tokens']): bigint {
  return Object.values(tokens).reduce((total, value) => total + BigInt(value), BigInt(0));
}

function zeroTotals(): EconomicsTotals {
  return {
    turns: 0,
    toolCalls: 0,
    permissionRequests: 0,
    compactions: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    elapsedMs: 0,
    retries: 0,
    findings: 0,
    checks: 0,
    humanInterventions: 0,
    failedCommands: 0,
    approvalLatencyMs: 0,
    repeatedWork: 0,
  };
}

function subtractEconomicsTotals(
  total: EconomicsTotals,
  sample: EconomicsTotals,
  overflowed = false,
): EconomicsTotals {
  const subtract = (value: number, removed: number) =>
    overflowed && value === maxEconomicsCounter ? value : value - removed;
  return {
    turns: subtract(total.turns, sample.turns),
    toolCalls: subtract(total.toolCalls, sample.toolCalls),
    permissionRequests: subtract(total.permissionRequests, sample.permissionRequests),
    compactions: subtract(total.compactions, sample.compactions),
    tokens: {
      input: subtract(total.tokens.input, sample.tokens.input),
      output: subtract(total.tokens.output, sample.tokens.output),
      reasoning: subtract(total.tokens.reasoning, sample.tokens.reasoning),
      cacheRead: subtract(total.tokens.cacheRead, sample.tokens.cacheRead),
      cacheWrite: subtract(total.tokens.cacheWrite, sample.tokens.cacheWrite),
    },
    elapsedMs: subtract(total.elapsedMs, sample.elapsedMs),
    retries: subtract(total.retries, sample.retries),
    findings: subtract(total.findings, sample.findings),
    checks: subtract(total.checks, sample.checks),
    humanInterventions: subtract(total.humanInterventions, sample.humanInterventions),
    failedCommands: subtract(total.failedCommands, sample.failedCommands),
    approvalLatencyMs: subtract(total.approvalLatencyMs, sample.approvalLatencyMs),
    repeatedWork: subtract(total.repeatedWork, sample.repeatedWork),
  };
}

function decrementEconomicsCounter(value: number, overflowed: boolean): number {
  return overflowed && value === maxEconomicsCounter ? value : value - 1;
}

type EconomicsAttribution = EconomicsRollup['byAttribution'][number];

function attributionKey(
  attribution: Pick<EconomicsAttribution, 'provider' | 'model' | 'role' | 'phase' | 'bucket'>,
): string {
  return attribution.bucket
    ? JSON.stringify(['bucket', attribution.role, attribution.phase])
    : JSON.stringify([
        attribution.provider,
        attribution.model,
        attribution.role,
        attribution.phase,
      ]);
}

function normalizeAttributions(values: EconomicsAttribution[]): {
  attributions: EconomicsAttribution[];
  overflowed: boolean;
  coverageComplete: boolean;
} {
  const ordered = values.toSorted((left, right) =>
    attributionKey(left).localeCompare(attributionKey(right)),
  );
  if (
    ordered.length <= archivedEvidenceIdentityLimit &&
    ordered.every((attribution) => !attribution.bucket)
  )
    return { attributions: ordered, overflowed: false, coverageComplete: true };
  let overflowed = false;
  const buckets = new Map<string, EconomicsAttribution>();
  for (const attribution of ordered) {
    const key = JSON.stringify([attribution.role, attribution.phase]);
    const previous = buckets.get(key);
    const samples = safeAdd(previous?.samples ?? 0, attribution.samples);
    const totals = addEconomicsTotals(previous?.totals ?? zeroTotals(), attribution.totals);
    buckets.set(key, {
      provider: 'overflow',
      model: null,
      role: attribution.role,
      phase: attribution.phase,
      bucket: true,
      samples: samples[0],
      totals: totals.totals,
    });
    overflowed ||= samples[1] || totals.overflowed;
  }
  return {
    attributions: [...buckets.values()].toSorted((left, right) =>
      attributionKey(left).localeCompare(attributionKey(right)),
    ),
    overflowed,
    coverageComplete: false,
  };
}

function findAttribution(
  attributions: EconomicsAttribution[],
  provider: string,
  model: string | null,
  role: TaskEconomics['role'],
  phase: TaskEconomics['phase'],
): EconomicsAttribution | undefined {
  return attributions.find(
    (item) =>
      item.role === role &&
      item.phase === phase &&
      (item.bucket || (item.provider === provider && item.model === model)),
  );
}

export function emptyEconomicsRollup(): EconomicsRollup {
  const rollup: EconomicsRollup = {
    archivedSequenceRanges: [],
    archivedEntries: 0,
    samples: 0,
    missingSamples: 0,
    totals: zeroTotals(),
    byRole: [],
    byAttribution: [],
    overflowed: false,
    identityCoverageComplete: true,
    attributionCoverageComplete: true,
    identityHorizonTruncated: false,
    causalDigest: '0'.repeat(32),
    causalPrefixDigest: '0'.repeat(32),
    causalAncestors: [],
    causalProofComplete: true,
    causalProofVersion: 2,
    incompleteCausalLineage: null,
    incompleteCausalGeneration: 0,
    incompleteCausalAncestors: [],
    stateVersion: 4,
    stateDigest: null,
    archivedTombstones: [],
    archivedEvidence: [],
  };
  sealRollupState(rollup);
  return rollup;
}

function stableDigest(value: string): string {
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < value.length; index += 1)
    for (let hash = 0; hash < hashes.length; hash += 1)
      hashes[hash] = Math.imul(hashes[hash] ^ value.charCodeAt(index), 0x01000193 + hash * 2);
  return hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, '0')).join('');
}

export function evidenceIdentityDigest(id: string): string {
  return stableDigest(id);
}

function evidenceDigestContent(entry: TaskEvidence): unknown {
  const mutableCiObservation =
    entry.id.startsWith('ci:') && entry.provider === 'github' && entry.kind === 'command';
  return {
    ...entry,
    sequence: undefined,
    ...(mutableCiObservation
      ? {
          result: undefined,
          timestamp: undefined,
          outputReference: undefined,
          executionOrder: undefined,
          economics: entry.economics
            ? { ...entry.economics, failedCommands: undefined }
            : undefined,
        }
      : {}),
  };
}

export function evidenceContentDigest(entry: TaskEvidence): string {
  return stableDigest(JSON.stringify(evidenceDigestContent(entry)));
}

function evidenceContentMatches(entry: TaskEvidence, contentDigest: string): boolean {
  if (evidenceContentDigest(entry) === contentDigest) return true;
  if (!(entry.id.startsWith('ci:') && entry.provider === 'github' && entry.kind === 'command'))
    return false;
  return [true, false, undefined].some(
    (identityUncertain) => evidenceContentDigest({ ...entry, identityUncertain }) === contentDigest,
  );
}

export function evidenceReferenceDigest(entry: TaskEvidence): string {
  return stableDigest(entry.outputReference);
}

function mergeSequenceRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const merged = ranges
    .toSorted((left, right) => left[0] - right[0])
    .reduce<Array<[number, number]>>((result, range) => {
      const previous = result.at(-1);
      if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
      else result.push([...range]);
      return result;
    }, []);
  if (merged.length > 100) throw new Error('Economics archive range limit reached.');
  return merged;
}

function removeSequenceFromRanges(
  ranges: Array<[number, number]>,
  sequence: number,
): Array<[number, number]> {
  return ranges.flatMap(([start, end]) => {
    if (sequence < start || sequence > end) return [[start, end]];
    if (start === end) return [];
    if (sequence === start) return [[start + 1, end]];
    if (sequence === end) return [[start, end - 1]];
    return [
      [start, sequence - 1],
      [sequence + 1, end],
    ];
  });
}

type ArchivedOrderKey = { identityDigest: string; sequence?: number };

function archivedEvidenceOrder(left: ArchivedOrderKey, right: ArchivedOrderKey): number {
  return (
    (left.sequence ?? 0) - (right.sequence ?? 0) ||
    left.identityDigest.localeCompare(right.identityDigest)
  );
}

type ArchivedTombstone = EconomicsRollup['archivedTombstones'][number];
type ArchivedCollection = 'archivedEvidence' | 'archivedTombstones';
type ArchivedLocation = { collection: ArchivedCollection; index: number };
type ArchivedIdentityAlias = ArchivedTombstone['identityAliases'][number];

function mergeIdentityAliases(
  primary: ArchivedIdentityAlias,
  aliasGroups: ArchivedTombstone['identityAliases'][],
): ArchivedTombstone['identityAliases'] {
  const contents = new Map([[primary.identityDigest, primary.contentDigest]]);
  const aliases: ArchivedTombstone['identityAliases'] = [];
  for (const alias of aliasGroups.flat()) {
    const existing = contents.get(alias.identityDigest);
    if (existing !== undefined) {
      if (existing !== alias.contentDigest)
        throw new Error('Archived evidence identity has conflicting content.');
      continue;
    }
    if (aliases.length >= archivedEvidenceAliasLimit)
      throw new Error('Archived evidence alias limit reached.');
    contents.set(alias.identityDigest, alias.contentDigest);
    aliases.push(alias);
  }
  return aliases.toSorted(
    (left, right) =>
      left.identityDigest.localeCompare(right.identityDigest) ||
      left.contentDigest.localeCompare(right.contentDigest),
  );
}

function archivedIdentityContents(entry: ArchivedTombstone): Map<string, string> {
  return new Map([
    [entry.identityDigest, entry.contentDigest],
    ...entry.identityAliases.map(
      (alias) => [alias.identityDigest, alias.contentDigest] as [string, string],
    ),
  ]);
}

function archivedIdentitySubset(
  subset: Map<string, string>,
  superset: Map<string, string>,
): boolean {
  return [...subset].every(([identityDigest, contentDigest]) => {
    const candidate = superset.get(identityDigest);
    if (candidate !== undefined && candidate !== contentDigest)
      throw new Error('Archived evidence identity has conflicting content.');
    return candidate === contentDigest;
  });
}

function mergeArchivedMutableCounters(
  primary: ArchivedTombstone,
  others: ArchivedTombstone[],
): ArchivedTombstone {
  const economics = primary.economics ?? others.find((entry) => entry.economics)?.economics;
  if (!economics) return primary;
  return {
    ...primary,
    economics: {
      ...economics,
      failedCommands: Math.max(
        primary.economics?.failedCommands ?? 0,
        ...others.map((entry) => entry.economics?.failedCommands ?? 0),
      ),
    },
  };
}

function archivedIdentityContent(
  entry: ArchivedTombstone,
  identityDigest: string,
): string | undefined {
  if (entry.identityDigest === identityDigest) return entry.contentDigest;
  return entry.identityAliases.find((alias) => alias.identityDigest === identityDigest)
    ?.contentDigest;
}

function archivedLocations(
  rollup: EconomicsRollup,
  predicate: (entry: ArchivedTombstone) => boolean,
): ArchivedLocation[] {
  return (['archivedEvidence', 'archivedTombstones'] as const).flatMap((collection) =>
    rollup[collection].flatMap((entry, index) => (predicate(entry) ? [{ collection, index }] : [])),
  );
}

function markTombstoneMutation(
  rollup: EconomicsRollup,
  previous: ArchivedTombstone,
  replacement: ArchivedTombstone | null,
): void {
  rollup.causalPrefixDigest = stableDigest(
    JSON.stringify([rollup.causalPrefixDigest, 'tombstone-mutation', previous, replacement]),
  );
}

function archivedTombstoneOrder(left: ArchivedOrderKey, right: ArchivedOrderKey): number {
  return (
    (left.sequence ?? 0) - (right.sequence ?? 0) ||
    left.identityDigest.localeCompare(right.identityDigest)
  );
}

function retainArchivedTombstones(
  rollup: EconomicsRollup,
  discarded: EconomicsRollup['archivedEvidence'],
): void {
  const tombstones = new Map(
    rollup.archivedTombstones.map((entry) => [entry.identityDigest, entry]),
  );
  for (const entry of discarded) {
    const previous = tombstones.get(entry.identityDigest);
    if (previous && previous.contentDigest !== entry.contentDigest)
      throw new Error('Archived evidence identity has conflicting content.');
    tombstones.set(entry.identityDigest, {
      ...entry,
    });
  }
  const ordered = [...tombstones.values()].toSorted(archivedTombstoneOrder);
  if (ordered.length > archivedEvidenceIdentityLimit) rollup.identityCoverageComplete = false;
  rollup.archivedTombstones = ordered.slice(-archivedEvidenceIdentityLimit);
}

function archivedIdentityCoverageComplete(rollup: EconomicsRollup): boolean {
  return (
    rollup.archivedEntries === rollup.archivedTombstones.length + rollup.archivedEvidence.length &&
    rollup.archivedTombstones.every(
      (entry) => entry.metadataComplete && !entry.identityUncertain,
    ) &&
    rollup.archivedEvidence.every((entry) => !entry.identityUncertain)
  );
}

function rollupStateDigest(
  rollup: EconomicsRollup,
  includeVersion = true,
  stateVersion = rollup.stateVersion,
): string {
  const archivedEvidence =
    stateVersion >= 3
      ? rollup.archivedEvidence
      : rollup.archivedEvidence.map((entry) => ({
          identityDigest: entry.identityDigest,
          contentDigest: entry.contentDigest,
          sequence: entry.sequence,
          economics: entry.economics,
          provider: entry.provider,
          model: entry.model,
          reconciliationDigest: entry.reconciliationDigest,
          identityUncertain: entry.identityUncertain,
          referenceDigest: entry.referenceDigest,
        }));
  const tombstones =
    stateVersion === 2
      ? rollup.archivedTombstones.map((entry) => ({
          identityDigest: entry.identityDigest,
          contentDigest: entry.contentDigest,
          sequence: entry.sequence,
          identityUncertain: entry.identityUncertain,
        }))
      : rollup.archivedTombstones;
  return stableDigest(
    JSON.stringify([
      ...(includeVersion ? [rollup.stateVersion] : []),
      rollup.archivedSequenceRanges,
      rollup.archivedEntries,
      rollup.samples,
      rollup.missingSamples,
      rollup.totals,
      rollup.byRole,
      includeVersion
        ? rollup.byAttribution
        : rollup.byAttribution.map((attribution) => ({
            provider: attribution.provider,
            model: attribution.model,
            role: attribution.role,
            phase: attribution.phase,
            samples: attribution.samples,
            totals: attribution.totals,
          })),
      rollup.overflowed,
      rollup.identityCoverageComplete,
      ...(stateVersion >= 4 ? [rollup.attributionCoverageComplete] : []),
      rollup.identityHorizonTruncated,
      rollup.causalDigest,
      rollup.causalPrefixDigest,
      rollup.causalAncestors,
      rollup.causalProofComplete,
      rollup.causalProofVersion,
      rollup.incompleteCausalLineage,
      rollup.incompleteCausalGeneration,
      rollup.incompleteCausalAncestors,
      ...(stateVersion >= 2 ? [tombstones.toSorted(archivedTombstoneOrder)] : []),
      archivedEvidence.toSorted(archivedEvidenceOrder),
    ]),
  );
}

function assertRollupState(rollup: EconomicsRollup): void {
  if (rollup.stateVersion === 0) {
    if (rollup.stateDigest !== null && rollup.stateDigest !== rollupStateDigest(rollup, false, 0))
      throw new Error('Economics archive state digest does not match its contents.');
    return;
  }
  if (
    rollup.stateVersion === 1 &&
    (rollup.stateDigest === null || rollup.stateDigest !== rollupStateDigest(rollup, true, 1))
  )
    throw new Error('Economics archive state digest does not match its contents.');
  if (rollup.stateVersion === 1) return;
  if (
    rollup.stateVersion === 2 &&
    (rollup.stateDigest === null || rollup.stateDigest !== rollupStateDigest(rollup, true, 2))
  )
    throw new Error('Economics archive state digest does not match its contents.');
  if (rollup.stateVersion === 2) return;
  if (
    rollup.stateVersion === 3 &&
    (rollup.stateDigest === null || rollup.stateDigest !== rollupStateDigest(rollup, true, 3))
  )
    throw new Error('Economics archive state digest does not match its contents.');
  if (rollup.stateVersion === 3) return;
  if (rollup.stateDigest === null || rollup.stateDigest !== rollupStateDigest(rollup, true, 4))
    throw new Error('Economics archive state digest does not match its contents.');
}

function sealRollupState(rollup: EconomicsRollup): void {
  rollup.stateVersion = 4;
  rollup.stateDigest = rollupStateDigest(rollup);
}

function advanceCausalProof(rollup: EconomicsRollup): void {
  rollup.causalAncestors = [...rollup.causalAncestors, rollup.causalDigest].slice(-1_024);
  rollup.causalDigest = stableDigest(
    JSON.stringify([
      rollup.causalPrefixDigest,
      rollup.archivedEvidence.toSorted(archivedEvidenceOrder),
    ]),
  );
}

function rebuildCausalProof(rollup: EconomicsRollup): void {
  const ordered = rollup.archivedEvidence.toSorted(archivedEvidenceOrder);
  rollup.causalDigest = '0'.repeat(32);
  rollup.causalPrefixDigest = '0'.repeat(32);
  rollup.causalAncestors = [];
  rollup.causalProofComplete = true;
  rollup.causalProofVersion = 2;
  const discarded = ordered.slice(0, -archivedEvidenceIdentityLimit);
  for (const entry of discarded)
    rollup.causalPrefixDigest = stableDigest(JSON.stringify([rollup.causalPrefixDigest, entry]));
  retainArchivedTombstones(rollup, discarded);
  rollup.archivedEvidence = ordered.slice(-archivedEvidenceIdentityLimit);
  advanceCausalProof(rollup);
  rollup.causalAncestors = [];
}

function migrateCausalProof(rollup: EconomicsRollup): void {
  assertRollupState(rollup);
  if (rollup.stateVersion < 4 && rollup.byAttribution.some((entry) => entry.bucket))
    rollup.attributionCoverageComplete = false;
  if (rollup.stateVersion < 3 && rollup.archivedTombstones.length) {
    rollup.archivedTombstones = rollup.archivedTombstones.map((entry) => ({
      ...entry,
      metadataComplete: false,
    }));
    rollup.identityCoverageComplete = false;
  }
  if (rollup.causalProofVersion !== 2) rollup.causalProofComplete = false;
  if (
    !rollup.causalProofComplete &&
    rollup.identityHorizonTruncated &&
    rollup.incompleteCausalLineage === null
  )
    rollup.incompleteCausalLineage = stableDigest(
      JSON.stringify([
        rollup.archivedEntries,
        rollup.samples,
        rollup.missingSamples,
        rollup.totals,
        rollup.archivedSequenceRanges,
        rollup.archivedEvidence.toSorted(archivedEvidenceOrder),
        rollup.causalDigest,
        rollup.causalProofVersion,
      ]),
    );
  if (rollup.causalProofComplete) return;
  if (!rollup.identityHorizonTruncated && rollup.archivedEntries === rollup.archivedEvidence.length)
    rebuildCausalProof(rollup);
}

function incompleteCausalStateDigest(rollup: EconomicsRollup): string {
  const lineage =
    rollup.incompleteCausalLineage ??
    stableDigest(
      JSON.stringify([
        rollup.archivedEntries,
        rollup.samples,
        rollup.missingSamples,
        rollup.totals,
        rollup.archivedSequenceRanges,
        rollup.archivedEvidence.toSorted(archivedEvidenceOrder),
        rollup.causalDigest,
        rollup.causalProofVersion,
      ]),
    );
  return stableDigest(
    JSON.stringify([
      lineage,
      rollup.incompleteCausalGeneration,
      rollup.archivedEntries,
      rollup.samples,
      rollup.missingSamples,
      rollup.totals,
      rollup.byRole,
      rollup.byAttribution,
      rollup.archivedSequenceRanges,
      rollup.archivedEvidence.toSorted(archivedEvidenceOrder),
      rollup.overflowed,
      rollup.identityCoverageComplete,
      rollup.attributionCoverageComplete,
      rollup.identityHorizonTruncated,
      rollup.causalDigest,
      rollup.causalPrefixDigest,
      rollup.causalProofComplete,
      rollup.causalProofVersion,
    ]),
  );
}

function advanceIncompleteCausalProof(rollup: EconomicsRollup, parentDigest: string): void {
  rollup.incompleteCausalAncestors = [...rollup.incompleteCausalAncestors, parentDigest].slice(
    -1_024,
  );
  rollup.incompleteCausalGeneration += 1;
}

export function rollUpEconomics(
  rollup: EconomicsRollup | undefined,
  entries: TaskEvidence[],
): EconomicsRollup {
  const next = structuredClone(rollup ?? emptyEconomicsRollup());
  migrateCausalProof(next);
  const incompleteParent = next.causalProofComplete ? null : incompleteCausalStateDigest(next);
  const roles = new Map(next.byRole.map((item) => [item.role, item.totals]));
  const attributions = new Map(next.byAttribution.map((item) => [attributionKey(item), item]));
  const attributionBucketed = next.byAttribution.some((item) => item.bucket);
  const identities = new Map<string, string>();
  for (const archived of [...next.archivedTombstones, ...next.archivedEvidence]) {
    for (const identity of [
      { identityDigest: archived.identityDigest, contentDigest: archived.contentDigest },
      ...archived.identityAliases,
    ]) {
      const existing = identities.get(identity.identityDigest);
      if (existing !== undefined && existing !== identity.contentDigest)
        throw new Error('Archived evidence identity has conflicting content.');
      identities.set(identity.identityDigest, identity.contentDigest);
    }
  }
  let causalChanged = false;
  for (const entry of entries.toSorted(
    (left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0) ||
      evidenceIdentityDigest(left.id).localeCompare(evidenceIdentityDigest(right.id)),
  )) {
    const identityDigest = evidenceIdentityDigest(entry.id);
    const contentDigest = evidenceContentDigest(entry);
    const previousDigest = identities.get(identityDigest);
    if (previousDigest !== undefined) {
      if (previousDigest !== contentDigest)
        throw new Error(`Archived evidence identity ${entry.id} has conflicting content.`);
      continue;
    }
    identities.set(identityDigest, contentDigest);
    const archivedEntry = {
      identityDigest,
      contentDigest,
      sequence: entry.sequence,
      economics: entry.economics ?? null,
      provider: entry.provider,
      model: entry.model,
      reconciliationDigest: entry.reconciliationKey,
      identityUncertain: entry.identityUncertain ?? false,
      referenceDigest: evidenceReferenceDigest(entry),
      metadataComplete: true,
      identityAliases: [],
    };
    const firstVisible = next.archivedEvidence.toSorted(archivedEvidenceOrder)[0];
    if (
      next.identityHorizonTruncated &&
      firstVisible &&
      archivedEvidenceOrder(archivedEntry, firstVisible) < 0
    )
      throw new Error('Cannot insert evidence before the causal archive prefix.');
    next.archivedEvidence.push(archivedEntry);
    causalChanged = true;
    if (entry.identityUncertain === true) next.identityCoverageComplete = false;
    if (next.archivedEvidence.length > archivedEvidenceIdentityLimit) {
      const ordered = next.archivedEvidence.toSorted(archivedEvidenceOrder);
      const discarded = ordered.slice(0, -archivedEvidenceIdentityLimit);
      for (const discardedEntry of discarded)
        next.causalPrefixDigest = stableDigest(
          JSON.stringify([next.causalPrefixDigest, discardedEntry]),
        );
      retainArchivedTombstones(next, discarded);
      next.archivedEvidence = ordered.slice(-archivedEvidenceIdentityLimit);
      next.identityHorizonTruncated = true;
    }
    if (entry.sequence !== undefined) {
      next.archivedSequenceRanges = mergeSequenceRanges([
        ...next.archivedSequenceRanges,
        [entry.sequence, entry.sequence],
      ]);
    }
    const archived = safeAdd(next.archivedEntries, 1);
    next.archivedEntries = archived[0];
    next.overflowed ||= archived[1];
    if (!entry.economics) {
      const missing = safeAdd(next.missingSamples, 1);
      next.missingSamples = missing[0];
      next.overflowed ||= missing[1];
      continue;
    }
    const samples = safeAdd(next.samples, 1);
    next.samples = samples[0];
    next.overflowed ||= samples[1];
    const total = addEconomicsTotals(next.totals, entry.economics);
    next.totals = total.totals;
    next.overflowed ||= total.overflowed;
    const role = addEconomicsTotals(
      roles.get(entry.economics.role) ?? zeroTotals(),
      entry.economics,
    );
    roles.set(entry.economics.role, role.totals);
    next.overflowed ||= role.overflowed;
    const attributionIdentity = attributionBucketed
      ? {
          provider: 'overflow',
          model: null,
          role: entry.economics.role,
          phase: entry.economics.phase,
          bucket: true,
        }
      : {
          provider: entry.provider,
          model: entry.model,
          role: entry.economics.role,
          phase: entry.economics.phase,
          bucket: false,
        };
    const key = attributionKey(attributionIdentity);
    const previousAttribution = attributions.get(key);
    const attributionSamples = safeAdd(previousAttribution?.samples ?? 0, 1);
    const attributionTotals = addEconomicsTotals(
      previousAttribution?.totals ?? zeroTotals(),
      entry.economics,
    );
    attributions.set(key, {
      ...attributionIdentity,
      samples: attributionSamples[0],
      totals: attributionTotals.totals,
    });
    next.overflowed ||= attributionSamples[1] || attributionTotals.overflowed;
  }
  if (causalChanged && next.causalProofComplete) advanceCausalProof(next);
  else if (causalChanged && incompleteParent) advanceIncompleteCausalProof(next, incompleteParent);
  next.byRole = taskActivityRoles.flatMap((role) => {
    const totals = roles.get(role);
    return totals ? [{ role, totals }] : [];
  });
  const normalizedAttributions = normalizeAttributions([...attributions.values()]);
  next.byAttribution = normalizedAttributions.attributions;
  next.overflowed ||= normalizedAttributions.overflowed;
  next.attributionCoverageComplete &&= normalizedAttributions.coverageComplete;
  sealRollupState(next);
  return economicsRollupSchema.parse(next);
}

export function mergeEconomicsRollups(
  rollups: Array<EconomicsRollup | undefined>,
): EconomicsRollup | undefined {
  const present = rollups
    .filter((rollup): rollup is EconomicsRollup => rollup !== undefined)
    .map((rollup) => {
      const migrated = structuredClone(rollup);
      migrateCausalProof(migrated);
      if (migrated.stateVersion < 4) sealRollupState(migrated);
      return economicsRollupSchema.parse(migrated);
    });
  if (!present.length) return undefined;
  const unique = new Map(present.map((rollup) => [JSON.stringify(rollup), rollup]));
  const distinct = [...unique.values()];
  if (distinct.length === 1) return distinct[0];
  const withoutAncestors = (rollup: EconomicsRollup) => ({
    ...rollup,
    causalAncestors: [] as string[],
    stateDigest: null,
  });
  if (
    distinct.every(
      (rollup) =>
        JSON.stringify(withoutAncestors(rollup)) === JSON.stringify(withoutAncestors(distinct[0])),
    )
  ) {
    const equivalent = structuredClone(distinct[0]);
    equivalent.causalAncestors = [...new Set(distinct.flatMap((rollup) => rollup.causalAncestors))]
      .toSorted()
      .slice(-1_024);
    sealRollupState(equivalent);
    return economicsRollupSchema.parse(equivalent);
  }
  if (distinct.some((rollup) => rollup.identityHorizonTruncated)) {
    const covers = (successor: EconomicsRollup, ancestor: EconomicsRollup) => {
      const completeProof =
        successor.causalProofComplete &&
        successor.causalProofVersion === 2 &&
        ancestor.causalProofComplete &&
        ancestor.causalProofVersion === 2 &&
        successor.causalAncestors.includes(ancestor.causalDigest);
      const ancestorLineage =
        ancestor.incompleteCausalLineage ??
        (ancestor.identityHorizonTruncated && ancestor.causalProofVersion !== 2
          ? stableDigest(
              JSON.stringify([
                ancestor.archivedEntries,
                ancestor.samples,
                ancestor.missingSamples,
                ancestor.totals,
                ancestor.archivedSequenceRanges,
                ancestor.archivedEvidence.toSorted(archivedEvidenceOrder),
                ancestor.causalDigest,
                ancestor.causalProofVersion,
              ]),
            )
          : null);
      const incompleteProof =
        !successor.causalProofComplete &&
        ancestorLineage !== null &&
        successor.incompleteCausalLineage === ancestorLineage &&
        successor.incompleteCausalAncestors.includes(incompleteCausalStateDigest(ancestor)) &&
        successor.archivedEntries >= ancestor.archivedEntries;
      return completeProof || incompleteProof;
    };
    const successors = distinct.filter((candidate) =>
      distinct.every((other) => candidate === other || covers(candidate, other)),
    );
    if (successors.length === 1) return successors[0];
    throw new Error('Cannot safely merge economics archives beyond the identity horizon.');
  }
  const archived = new Map<string, EconomicsRollup['archivedEvidence'][number]>();
  const identityOwners = new Map<string, string>();
  for (const rollup of distinct)
    for (const entry of rollup.archivedEvidence) {
      const previous = archived.get(entry.identityDigest);
      if (previous && previous.contentDigest !== entry.contentDigest)
        throw new Error('Archived evidence identity has conflicting content.');
      let incoming = entry;
      const incomingIdentities = archivedIdentityContents(entry);
      const overlaps = [...archived.values()].filter(
        (candidate) =>
          candidate.identityDigest !== entry.identityDigest &&
          [...archivedIdentityContents(candidate).keys()].some((identityDigest) =>
            incomingIdentities.has(identityDigest),
          ),
      );
      let subsumed = false;
      for (const candidate of overlaps) {
        const candidateIdentities = archivedIdentityContents(candidate);
        const candidateIsAncestor = archivedIdentitySubset(candidateIdentities, incomingIdentities);
        const incomingIsAncestor = archivedIdentitySubset(incomingIdentities, candidateIdentities);
        if (candidateIsAncestor === incomingIsAncestor)
          throw new Error('Cannot safely merge overlapping archived evidence identities.');
        if (incomingIsAncestor) {
          archived.set(
            candidate.identityDigest,
            mergeArchivedMutableCounters(candidate, [incoming]),
          );
          subsumed = true;
          continue;
        }
        incoming = mergeArchivedMutableCounters(incoming, [candidate]);
        archived.delete(candidate.identityDigest);
        for (const [identityDigest, owner] of identityOwners)
          if (owner === candidate.identityDigest) identityOwners.delete(identityDigest);
      }
      if (subsumed) continue;
      const aliases = mergeIdentityAliases(
        { identityDigest: incoming.identityDigest, contentDigest: incoming.contentDigest },
        [previous?.identityAliases ?? [], incoming.identityAliases],
      );
      for (const identity of [
        { identityDigest: incoming.identityDigest, contentDigest: incoming.contentDigest },
        ...aliases,
      ]) {
        const owner = identityOwners.get(identity.identityDigest);
        if (owner !== undefined && owner !== incoming.identityDigest)
          throw new Error('Cannot safely merge overlapping archived evidence identities.');
        identityOwners.set(identity.identityDigest, incoming.identityDigest);
      }
      const selected =
        !previous ||
        (incoming.sequence ?? 0) > (previous.sequence ?? 0) ||
        ((incoming.sequence ?? 0) === (previous.sequence ?? 0) &&
          JSON.stringify(incoming).localeCompare(JSON.stringify(previous)) > 0)
          ? incoming
          : previous;
      archived.set(
        incoming.identityDigest,
        mergeArchivedMutableCounters({ ...selected, identityAliases: aliases }, [
          ...(previous ? [previous] : []),
          incoming,
        ]),
      );
    }
  const merged = emptyEconomicsRollup();
  for (const entry of [...archived.values()].toSorted(archivedEvidenceOrder)) {
    merged.archivedEvidence.push(structuredClone(entry));
    merged.archivedEntries += 1;
    if (entry.identityUncertain) merged.identityCoverageComplete = false;
    if (entry.sequence !== undefined)
      merged.archivedSequenceRanges = mergeSequenceRanges([
        ...merged.archivedSequenceRanges,
        [entry.sequence, entry.sequence],
      ]);
    if (!entry.economics) {
      merged.missingSamples += 1;
      continue;
    }
    merged.samples += 1;
    const total = addEconomicsTotals(merged.totals, entry.economics);
    merged.totals = total.totals;
    merged.overflowed ||= total.overflowed;
    const role = merged.byRole.find((item) => item.role === entry.economics!.role);
    const roleTotal = addEconomicsTotals(role?.totals ?? zeroTotals(), entry.economics);
    if (role) role.totals = roleTotal.totals;
    else merged.byRole.push({ role: entry.economics.role, totals: roleTotal.totals });
    merged.overflowed ||= roleTotal.overflowed;
    const attribution = merged.byAttribution.find(
      (item) =>
        item.provider === entry.provider &&
        item.model === entry.model &&
        item.role === entry.economics!.role &&
        item.phase === entry.economics!.phase,
    );
    const attributionTotals = addEconomicsTotals(
      attribution?.totals ?? zeroTotals(),
      entry.economics,
    );
    if (attribution) {
      attribution.samples += 1;
      attribution.totals = attributionTotals.totals;
    } else
      merged.byAttribution.push({
        provider: entry.provider,
        model: entry.model,
        role: entry.economics.role,
        phase: entry.economics.phase,
        bucket: false,
        samples: 1,
        totals: attributionTotals.totals,
      });
    merged.overflowed ||= attributionTotals.overflowed;
  }
  merged.byRole = taskActivityRoles.flatMap((role) => {
    const totals = merged.byRole.find((item) => item.role === role)?.totals;
    return totals ? [{ role, totals }] : [];
  });
  const normalizedAttributions = normalizeAttributions(merged.byAttribution);
  merged.byAttribution = normalizedAttributions.attributions;
  merged.overflowed ||= normalizedAttributions.overflowed;
  merged.attributionCoverageComplete = normalizedAttributions.coverageComplete;
  if (archived.size > archivedEvidenceIdentityLimit) {
    merged.identityHorizonTruncated = true;
  }
  rebuildCausalProof(merged);
  merged.archivedSequenceRanges = mergeSequenceRanges(
    distinct.flatMap((rollup) => rollup.archivedSequenceRanges),
  );
  merged.overflowed ||= distinct.some((rollup) => rollup.overflowed);
  sealRollupState(merged);
  return economicsRollupSchema.parse(merged);
}

export function rekeyArchivedEconomicsEvidence(
  rollup: EconomicsRollup,
  reconciliationKey: string,
  entry: TaskEvidence,
  identityUncertain: boolean,
): EconomicsRollup {
  const matches = archivedLocations(
    rollup,
    (candidate) =>
      candidate.metadataComplete &&
      candidate.reconciliationDigest === reconciliationKey &&
      candidate.identityUncertain,
  ).filter(({ collection }) => collection === 'archivedEvidence' || rollup.stateVersion >= 3);
  if (matches.length !== 1) return rollup;
  const next = structuredClone(rollup);
  migrateCausalProof(next);
  const incompleteParent = next.causalProofComplete ? null : incompleteCausalStateDigest(next);
  const normalized = { ...entry, identityUncertain };
  const match = matches[0];
  const previous = next[match.collection][match.index];
  const normalizedIdentity = evidenceIdentityDigest(normalized.id);
  const collision = archivedLocations(
    next,
    (candidate) =>
      candidate !== previous &&
      (candidate.identityDigest === normalizedIdentity ||
        candidate.identityAliases.some((alias) => alias.identityDigest === normalizedIdentity)),
  )[0];
  if (collision) {
    const collisionEntry = next[collision.collection][collision.index];
    const aliases = mergeIdentityAliases(
      {
        identityDigest: collisionEntry.identityDigest,
        contentDigest: collisionEntry.contentDigest,
      },
      [
        collisionEntry.identityAliases,
        previous.identityAliases,
        [{ identityDigest: previous.identityDigest, contentDigest: previous.contentDigest }],
      ],
    );
    if (JSON.stringify(aliases) !== JSON.stringify(collisionEntry.identityAliases)) {
      const replacement = {
        ...collisionEntry,
        identityAliases: aliases,
      };
      if (collision.collection === 'archivedTombstones')
        markTombstoneMutation(next, collisionEntry, replacement);
      next[collision.collection][collision.index] = replacement;
    }
    if (match.collection === 'archivedTombstones') markTombstoneMutation(next, previous, null);
    if (previous.economics) {
      next.samples = decrementEconomicsCounter(next.samples, next.overflowed);
      next.totals = subtractEconomicsTotals(next.totals, previous.economics, next.overflowed);
      const role = next.byRole.find((item) => item.role === previous.economics!.role);
      if (role)
        role.totals = subtractEconomicsTotals(role.totals, previous.economics, next.overflowed);
      const attribution = findAttribution(
        next.byAttribution,
        previous.provider,
        previous.model,
        previous.economics.role,
        previous.economics.phase,
      );
      if (attribution) {
        attribution.samples = decrementEconomicsCounter(attribution.samples, next.overflowed);
        attribution.totals = subtractEconomicsTotals(
          attribution.totals,
          previous.economics,
          next.overflowed,
        );
      }
    } else next.missingSamples = decrementEconomicsCounter(next.missingSamples, next.overflowed);
    next.archivedEntries = decrementEconomicsCounter(next.archivedEntries, next.overflowed);
    next[match.collection].splice(match.index, 1);
    next.identityCoverageComplete = archivedIdentityCoverageComplete(next);
    if (next.identityHorizonTruncated) {
      if (next.causalProofComplete) advanceCausalProof(next);
      else if (incompleteParent) advanceIncompleteCausalProof(next, incompleteParent);
    } else rebuildCausalProof(next);
    sealRollupState(next);
    return updateArchivedEconomicsEvidence(next, { ...normalized, identityUncertain: false });
  }
  const previousEconomics = previous.economics;
  const incomingEconomics = normalized.economics;
  const baseEconomics = previousEconomics ?? incomingEconomics;
  const economics = baseEconomics
    ? {
        ...baseEconomics,
        turns: Math.max(previousEconomics?.turns ?? 0, incomingEconomics?.turns ?? 0),
        toolCalls: Math.max(previousEconomics?.toolCalls ?? 0, incomingEconomics?.toolCalls ?? 0),
        permissionRequests: Math.max(
          previousEconomics?.permissionRequests ?? 0,
          incomingEconomics?.permissionRequests ?? 0,
        ),
        compactions: Math.max(
          previousEconomics?.compactions ?? 0,
          incomingEconomics?.compactions ?? 0,
        ),
        tokens: {
          input: Math.max(
            previousEconomics?.tokens.input ?? 0,
            incomingEconomics?.tokens.input ?? 0,
          ),
          output: Math.max(
            previousEconomics?.tokens.output ?? 0,
            incomingEconomics?.tokens.output ?? 0,
          ),
          reasoning: Math.max(
            previousEconomics?.tokens.reasoning ?? 0,
            incomingEconomics?.tokens.reasoning ?? 0,
          ),
          cacheRead: Math.max(
            previousEconomics?.tokens.cacheRead ?? 0,
            incomingEconomics?.tokens.cacheRead ?? 0,
          ),
          cacheWrite: Math.max(
            previousEconomics?.tokens.cacheWrite ?? 0,
            incomingEconomics?.tokens.cacheWrite ?? 0,
          ),
        },
        elapsedMs: Math.max(previousEconomics?.elapsedMs ?? 0, incomingEconomics?.elapsedMs ?? 0),
        retries: Math.max(previousEconomics?.retries ?? 0, incomingEconomics?.retries ?? 0),
        findings: Math.max(previousEconomics?.findings ?? 0, incomingEconomics?.findings ?? 0),
        checks: Math.max(previousEconomics?.checks ?? 0, incomingEconomics?.checks ?? 0),
        humanInterventions: Math.max(
          previousEconomics?.humanInterventions ?? 0,
          incomingEconomics?.humanInterventions ?? 0,
        ),
        failedCommands: Math.max(
          normalized.result === 'failed' ? 1 : 0,
          previousEconomics?.failedCommands ?? 0,
          incomingEconomics?.failedCommands ?? 0,
        ),
        approvalLatencyMs: Math.max(
          previousEconomics?.approvalLatencyMs ?? 0,
          incomingEconomics?.approvalLatencyMs ?? 0,
        ),
        repeatedWork: Math.max(
          previousEconomics?.repeatedWork ?? 0,
          incomingEconomics?.repeatedWork ?? 0,
        ),
      }
    : null;
  const replacement = {
    identityDigest: evidenceIdentityDigest(normalized.id),
    contentDigest: evidenceContentDigest(normalized),
    sequence: previous.sequence,
    economics,
    provider: normalized.provider,
    model: normalized.model,
    reconciliationDigest: reconciliationKey,
    identityUncertain,
    referenceDigest: evidenceReferenceDigest(normalized),
    metadataComplete: true,
    identityAliases: mergeIdentityAliases(
      {
        identityDigest: evidenceIdentityDigest(normalized.id),
        contentDigest: evidenceContentDigest(normalized),
      },
      [
        previous.identityAliases,
        [{ identityDigest: previous.identityDigest, contentDigest: previous.contentDigest }],
      ],
    ),
  };
  if (match.collection === 'archivedTombstones') markTombstoneMutation(next, previous, replacement);
  next[match.collection][match.index] = replacement;
  if (economics) {
    const priorTotals = previousEconomics ?? zeroTotals();
    const delta: EconomicsTotals = {
      turns: economics.turns - priorTotals.turns,
      toolCalls: economics.toolCalls - priorTotals.toolCalls,
      permissionRequests: economics.permissionRequests - priorTotals.permissionRequests,
      compactions: economics.compactions - priorTotals.compactions,
      tokens: {
        input: economics.tokens.input - priorTotals.tokens.input,
        output: economics.tokens.output - priorTotals.tokens.output,
        reasoning: economics.tokens.reasoning - priorTotals.tokens.reasoning,
        cacheRead: economics.tokens.cacheRead - priorTotals.tokens.cacheRead,
        cacheWrite: economics.tokens.cacheWrite - priorTotals.tokens.cacheWrite,
      },
      elapsedMs: economics.elapsedMs - priorTotals.elapsedMs,
      retries: economics.retries - priorTotals.retries,
      findings: economics.findings - priorTotals.findings,
      checks: economics.checks - priorTotals.checks,
      humanInterventions: economics.humanInterventions - priorTotals.humanInterventions,
      failedCommands: economics.failedCommands - priorTotals.failedCommands,
      approvalLatencyMs: economics.approvalLatencyMs - priorTotals.approvalLatencyMs,
      repeatedWork: economics.repeatedWork - priorTotals.repeatedWork,
    };
    const total = addEconomicsTotals(next.totals, delta);
    next.totals = total.totals;
    next.overflowed ||= total.overflowed;
    const role = next.byRole.find((item) => item.role === economics.role);
    const roleTotal = addEconomicsTotals(role?.totals ?? zeroTotals(), delta);
    if (role) role.totals = roleTotal.totals;
    else next.byRole.push({ role: economics.role, totals: roleTotal.totals });
    next.overflowed ||= roleTotal.overflowed;
    let attribution = findAttribution(
      next.byAttribution,
      previous.provider,
      previous.model,
      economics.role,
      economics.phase,
    );
    if (!attribution) {
      attribution = {
        provider: previous.provider,
        model: previous.model,
        role: economics.role,
        phase: economics.phase,
        bucket: false,
        samples: 0,
        totals: zeroTotals(),
      };
      next.byAttribution.push(attribution);
    }
    const attributionTotal = addEconomicsTotals(attribution.totals, delta);
    attribution.totals = attributionTotal.totals;
    next.overflowed ||= attributionTotal.overflowed;
    if (!previousEconomics) {
      next.missingSamples -= 1;
      const sample = safeAdd(next.samples, 1);
      next.samples = sample[0];
      next.overflowed ||= sample[1];
      const attributionSample = safeAdd(attribution.samples, 1);
      attribution.samples = attributionSample[0];
      next.overflowed ||= attributionSample[1];
    }
  }
  next.identityCoverageComplete = archivedIdentityCoverageComplete(next);
  if (!next.identityHorizonTruncated) rebuildCausalProof(next);
  else if (next.causalProofComplete) advanceCausalProof(next);
  else if (incompleteParent) advanceIncompleteCausalProof(next, incompleteParent);
  sealRollupState(next);
  return economicsRollupSchema.parse(next);
}

export function removeArchivedEconomicsEvidence(
  rollup: EconomicsRollup,
  entry: TaskEvidence,
): EconomicsRollup {
  const identityDigest = evidenceIdentityDigest(entry.id);
  const matches = archivedLocations(
    rollup,
    (candidate) => candidate.metadataComplete && candidate.identityDigest === identityDigest,
  );
  if (!matches.length) return rollup;
  if (matches.length > 1)
    throw new Error(`Archived evidence identity ${entry.id} appears more than once.`);
  const match = matches[0];
  const archived = rollup[match.collection][match.index];
  if (!evidenceContentMatches(entry, archived.contentDigest))
    throw new Error(`Archived evidence identity ${entry.id} has conflicting content.`);
  const next = structuredClone(rollup);
  migrateCausalProof(next);
  const incompleteParent = next.causalProofComplete ? null : incompleteCausalStateDigest(next);
  const removed = next[match.collection][match.index];
  if (match.collection === 'archivedTombstones') markTombstoneMutation(next, removed, null);
  if (removed.economics) {
    next.samples = decrementEconomicsCounter(next.samples, next.overflowed);
    next.totals = subtractEconomicsTotals(next.totals, removed.economics, next.overflowed);
    const role = next.byRole.find((item) => item.role === removed.economics!.role);
    if (role)
      role.totals = subtractEconomicsTotals(role.totals, removed.economics, next.overflowed);
    const attribution = findAttribution(
      next.byAttribution,
      removed.provider,
      removed.model,
      removed.economics.role,
      removed.economics.phase,
    );
    if (attribution) {
      attribution.samples = decrementEconomicsCounter(attribution.samples, next.overflowed);
      attribution.totals = subtractEconomicsTotals(
        attribution.totals,
        removed.economics,
        next.overflowed,
      );
    }
  } else next.missingSamples = decrementEconomicsCounter(next.missingSamples, next.overflowed);
  next.archivedEntries = decrementEconomicsCounter(next.archivedEntries, next.overflowed);
  if (removed.sequence !== undefined)
    next.archivedSequenceRanges = removeSequenceFromRanges(
      next.archivedSequenceRanges,
      removed.sequence,
    );
  next[match.collection].splice(match.index, 1);
  next.identityCoverageComplete = archivedIdentityCoverageComplete(next);
  if (next.identityHorizonTruncated) {
    if (next.causalProofComplete) advanceCausalProof(next);
    else if (incompleteParent) advanceIncompleteCausalProof(next, incompleteParent);
  } else rebuildCausalProof(next);
  sealRollupState(next);
  return economicsRollupSchema.parse(next);
}

export function reconcileArchivedEconomicsEvidence(
  rollup: EconomicsRollup,
  reconciliationKey: string,
  entry: TaskEvidence,
): EconomicsRollup {
  const referenceDigest = evidenceReferenceDigest(entry);
  const matches = archivedLocations(
    rollup,
    (candidate) =>
      candidate.metadataComplete &&
      !candidate.identityUncertain &&
      candidate.reconciliationDigest === reconciliationKey &&
      candidate.referenceDigest === referenceDigest,
  ).filter(({ collection }) => collection === 'archivedEvidence' || rollup.stateVersion >= 3);
  if (matches.length !== 1) return rollup;
  const next = structuredClone(rollup);
  migrateCausalProof(next);
  const incompleteParent = next.causalProofComplete ? null : incompleteCausalStateDigest(next);
  const match = matches[0];
  const previous = next[match.collection][match.index];
  const replacement = {
    ...previous,
    identityAliases: mergeIdentityAliases(
      { identityDigest: previous.identityDigest, contentDigest: previous.contentDigest },
      [
        previous.identityAliases,
        [
          {
            identityDigest: evidenceIdentityDigest(entry.id),
            contentDigest: evidenceContentDigest(entry),
          },
        ],
      ],
    ),
  };
  if (match.collection === 'archivedTombstones') markTombstoneMutation(next, previous, replacement);
  next[match.collection][match.index] = replacement;
  if (!next.identityHorizonTruncated) rebuildCausalProof(next);
  else if (next.causalProofComplete) advanceCausalProof(next);
  else if (incompleteParent) advanceIncompleteCausalProof(next, incompleteParent);
  sealRollupState(next);
  return updateArchivedEconomicsEvidence(next, entry);
}

export function updateArchivedEconomicsEvidence(
  rollup: EconomicsRollup,
  entry: TaskEvidence,
): EconomicsRollup {
  const identityDigest = evidenceIdentityDigest(entry.id);
  const matches = archivedLocations(
    rollup,
    (candidate) =>
      candidate.metadataComplete &&
      archivedIdentityContent(candidate, identityDigest) !== undefined,
  ).filter(({ collection }) => collection === 'archivedEvidence' || rollup.stateVersion >= 3);
  if (matches.length !== 1) return rollup;
  const match = matches[0];
  const current = rollup[match.collection][match.index];
  if (!evidenceContentMatches(entry, archivedIdentityContent(current, identityDigest)!))
    throw new Error(`Archived evidence identity ${entry.id} has conflicting content.`);
  const next = structuredClone(rollup);
  migrateCausalProof(next);
  const incompleteParent = next.causalProofComplete ? null : incompleteCausalStateDigest(next);
  const previous = next[match.collection][match.index];
  const economics = entry.economics
    ? {
        ...entry.economics,
        failedCommands: Math.max(
          entry.result === 'failed' ? 1 : 0,
          previous.economics?.failedCommands ?? 0,
          entry.economics.failedCommands,
        ),
      }
    : previous.economics;
  if (!economics || JSON.stringify(economics) === JSON.stringify(previous.economics)) {
    sealRollupState(next);
    return economicsRollupSchema.parse(next);
  }
  const previousFailed = previous.economics?.failedCommands ?? 0;
  const failedDelta = economics.failedCommands - previousFailed;
  const replacement = { ...previous, economics };
  if (match.collection === 'archivedTombstones') markTombstoneMutation(next, previous, replacement);
  next[match.collection][match.index] = replacement;
  if (failedDelta > 0) {
    const total = safeAdd(next.totals.failedCommands, failedDelta);
    next.totals.failedCommands = total[0];
    next.overflowed ||= total[1];
    const role = next.byRole.find((item) => item.role === economics.role);
    if (role) {
      const roleTotal = safeAdd(role.totals.failedCommands, failedDelta);
      role.totals.failedCommands = roleTotal[0];
      next.overflowed ||= roleTotal[1];
    }
    const attribution = findAttribution(
      next.byAttribution,
      previous.provider,
      previous.model,
      economics.role,
      economics.phase,
    );
    if (attribution) {
      const attributionTotal = safeAdd(attribution.totals.failedCommands, failedDelta);
      attribution.totals.failedCommands = attributionTotal[0];
      next.overflowed ||= attributionTotal[1];
    }
  }
  if (next.identityHorizonTruncated) {
    if (next.causalProofComplete) advanceCausalProof(next);
    else if (incompleteParent) advanceIncompleteCausalProof(next, incompleteParent);
  } else rebuildCausalProof(next);
  sealRollupState(next);
  return economicsRollupSchema.parse(next);
}

function evidenceIsArchived(entry: TaskEvidence, rollup: EconomicsRollup | undefined): boolean {
  if (!rollup) return false;
  const identityDigest = evidenceIdentityDigest(entry.id);
  const archived = [...rollup.archivedTombstones, ...rollup.archivedEvidence].filter(
    (candidate) => archivedIdentityContent(candidate, identityDigest) !== undefined,
  );
  if (archived.length > 1)
    throw new Error(`Archived evidence identity ${entry.id} appears more than once.`);
  if (archived.length === 1) {
    if (!evidenceContentMatches(entry, archivedIdentityContent(archived[0], identityDigest)!))
      throw new Error(`Archived evidence identity ${entry.id} has conflicting content.`);
    return true;
  }
  return (
    rollup.archivedEvidence.length === 0 &&
    entry.sequence !== undefined &&
    rollup.archivedSequenceRanges.some(
      ([start, end]) => entry.sequence! >= start && entry.sequence! <= end,
    )
  );
}

function latestEvidence(manifest: EvidenceManifest | undefined): TaskEvidence[] {
  const latest = new Map<string, TaskEvidence>();
  for (const entry of manifest?.evidence ?? []) {
    const previous = latest.get(`${entry.kind}:${entry.name}`);
    const newer = (() => {
      if (!previous) return true;
      if (entry.sequence !== undefined || previous.sequence !== undefined) {
        if (entry.sequence === undefined) return false;
        if (previous.sequence === undefined) return true;
        return entry.sequence >= previous.sequence;
      }
      return entry.timestamp >= previous.timestamp;
    })();
    if (newer) latest.set(`${entry.kind}:${entry.name}`, entry);
  }
  return [...latest.values()];
}

export function summarizeTaskEconomics(
  manifests: EvidenceManifest[],
  readiness: Pick<EvidenceReadiness, 'ready'>,
  revision: string | null | undefined,
): TaskEconomicsSummary {
  const rollup = mergeEconomicsRollups(manifests.map((manifest) => manifest.economicsRollup));
  const retainedEntries = manifests.flatMap((manifest) =>
    manifest.evidence.filter((entry) => !evidenceIsArchived(entry, rollup)),
  );
  const samples = retainedEntries.flatMap((entry) => (entry.economics ? [entry.economics] : []));
  const current = revision
    ? manifests.find((manifest) => manifest.revision === revision && !manifest.stale)
    : undefined;
  const economicsComplete =
    current !== undefined &&
    latestEvidence(current).every((entry) => entry.economics !== undefined);
  const byRole: TaskEconomicsSummary['byRole'] = Object.fromEntries(
    rollup?.byRole.map((item) => [item.role, item.totals]) ?? [],
  );
  let totals = rollup?.totals ?? zeroTotals();
  let overflowed = rollup?.overflowed ?? false;
  for (const sample of samples) {
    const total = addEconomicsTotals(totals, sample);
    totals = total.totals;
    overflowed ||= total.overflowed;
    const role = addEconomicsTotals(byRole[sample.role] ?? zeroTotals(), sample);
    byRole[sample.role] = role.totals;
    overflowed ||= role.overflowed;
  }
  const missing = safeAdd(
    rollup?.missingSamples ?? 0,
    retainedEntries.filter((entry) => !entry.economics).length,
  );
  const sampleCount = safeAdd(rollup?.samples ?? 0, samples.length);
  const missingSamples = missing[0];
  const identityCoverageComplete =
    (rollup?.identityCoverageComplete ?? true) &&
    retainedEntries.every((entry) => entry.identityUncertain !== true);
  const attributionCoverageComplete = rollup?.attributionCoverageComplete ?? true;
  overflowed ||= missing[1] || sampleCount[1];
  const lifetimeEconomicsComplete =
    missingSamples === 0 && identityCoverageComplete && attributionCoverageComplete && !overflowed;
  return {
    outcomeAccepted: readiness.ready,
    accepted: readiness.ready && economicsComplete && lifetimeEconomicsComplete,
    economicsComplete,
    lifetimeEconomicsComplete,
    lifetimeTruncated: rollup !== undefined,
    identityCoverageComplete,
    attributionCoverageComplete,
    overflowed,
    samples: sampleCount[0],
    missingSamples,
    totals,
    byRole,
  };
}

export type TaskEconomicsExport = {
  schemaVersion: 3;
  exportedAt: number;
  tasks: Array<{
    task: string;
    acceptedRevision: string | null;
    outcomeAccepted: boolean;
    accepted: boolean;
    economicsComplete: boolean;
    lifetimeEconomicsComplete: boolean;
    lifetimeTruncated: boolean;
    identityCoverageComplete: boolean;
    attributionCoverageComplete: boolean;
    overflowed: boolean;
    totals: EconomicsTotals;
    byRole: TaskEconomicsSummary['byRole'];
    samplesRecorded: number;
    missingSamples: number;
    rollup:
      | (Omit<EconomicsRollup, 'archivedEvidence' | 'archivedTombstones'> & {
          archivedEvidenceCount: number;
          archivedTombstoneCount: number;
        })
      | null;
    samples: Array<{
      revision: string;
      provider: string;
      model: string | null;
      result: TaskEvidence['result'];
      timestamp: number;
      economics: TaskEconomics;
    }>;
  }>;
};

export function exportTaskEconomics(
  tasks: Array<{
    task: string;
    acceptedRevision: string | null | undefined;
    manifests: EvidenceManifest[];
    outcomeAccepted: boolean;
  }>,
  exportedAt = Date.now(),
): TaskEconomicsExport {
  return {
    schemaVersion: 3,
    exportedAt,
    tasks: tasks.map(({ task, acceptedRevision, manifests, outcomeAccepted }) => {
      const summary = summarizeTaskEconomics(
        manifests,
        { ready: outcomeAccepted },
        acceptedRevision,
      );
      const rollup = mergeEconomicsRollups(manifests.map((manifest) => manifest.economicsRollup));
      const exportedRollup = rollup
        ? {
            archivedSequenceRanges: rollup.archivedSequenceRanges,
            archivedEntries: rollup.archivedEntries,
            samples: rollup.samples,
            missingSamples: rollup.missingSamples,
            totals: rollup.totals,
            byRole: rollup.byRole,
            byAttribution: rollup.byAttribution,
            overflowed: rollup.overflowed,
            identityCoverageComplete: rollup.identityCoverageComplete,
            attributionCoverageComplete: rollup.attributionCoverageComplete,
            identityHorizonTruncated: rollup.identityHorizonTruncated,
            causalDigest: rollup.causalDigest,
            causalPrefixDigest: rollup.causalPrefixDigest,
            causalAncestors: rollup.causalAncestors,
            causalProofComplete: rollup.causalProofComplete,
            causalProofVersion: rollup.causalProofVersion,
            incompleteCausalLineage: rollup.incompleteCausalLineage,
            incompleteCausalGeneration: rollup.incompleteCausalGeneration,
            incompleteCausalAncestors: rollup.incompleteCausalAncestors,
            stateVersion: rollup.stateVersion,
            stateDigest: rollup.stateDigest,
            archivedEvidenceCount: rollup.archivedEvidence.length,
            archivedTombstoneCount: rollup.archivedTombstones.length,
          }
        : null;
      return {
        task,
        acceptedRevision: acceptedRevision ?? null,
        outcomeAccepted: summary.outcomeAccepted,
        accepted: summary.accepted,
        economicsComplete: summary.economicsComplete,
        lifetimeEconomicsComplete: summary.lifetimeEconomicsComplete,
        lifetimeTruncated: summary.lifetimeTruncated,
        identityCoverageComplete: summary.identityCoverageComplete,
        attributionCoverageComplete: summary.attributionCoverageComplete,
        overflowed: summary.overflowed,
        totals: summary.totals,
        byRole: summary.byRole,
        samplesRecorded: summary.samples,
        missingSamples: summary.missingSamples,
        rollup: exportedRollup,
        samples: manifests.flatMap((manifest) =>
          manifest.evidence.flatMap((entry) =>
            entry.economics && !evidenceIsArchived(entry, rollup)
              ? [
                  {
                    revision: manifest.revision,
                    provider: entry.provider,
                    model: entry.model,
                    result: entry.result,
                    timestamp: entry.timestamp,
                    economics: entry.economics,
                  },
                ]
              : [],
          ),
        ),
      };
    }),
  };
}

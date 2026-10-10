import { z } from 'zod';
import {
  gateNames,
  requiredValidationGatesSatisfied,
  type GateName,
  type ShipGate,
} from './ship-progress.ts';

export const shipRiskLevels = ['low', 'medium', 'high'] as const;
export type ShipRisk = (typeof shipRiskLevels)[number];

const riskRank = new Map(shipRiskLevels.map((risk, index) => [risk, index]));
const gateSchema = z.enum(gateNames);

export const shipValidationConfigSchema = z
  .object({
    defaultRisk: z.enum(shipRiskLevels).default('medium'),
    low: z.array(gateSchema),
    medium: z.array(gateSchema),
    high: z.array(gateSchema),
    paths: z
      .array(
        z.object({
          pattern: z.string().min(1),
          risk: z.enum(shipRiskLevels),
        }),
      )
      .default([]),
  })
  .superRefine((config, context) => {
    for (const risk of shipRiskLevels) {
      const gates = config[risk];
      if (new Set(gates).size !== gates.length)
        context.addIssue({ code: 'custom', message: `${risk} validation gates must be unique.` });
    }
    for (const gate of config.low) {
      const coveredAt = (risk: 'medium' | 'high') =>
        config[risk].includes(gate) ||
        (gate === 'inline-review' &&
          config[risk].includes('code-adversary') &&
          config[risk].includes('findings-adversary'));
      if (!coveredAt('medium') || !coveredAt('high'))
        context.addIssue({
          code: 'custom',
          message: 'Higher risks must retain or strengthen every low-risk gate.',
        });
    }
    for (const gate of config.medium)
      if (!config.high.includes(gate))
        context.addIssue({
          code: 'custom',
          message: 'High risk must retain every medium-risk gate.',
        });
  });

export type ShipValidationConfig = z.infer<typeof shipValidationConfigSchema>;

export type ShipRiskSelection = {
  requestedRisk: ShipRisk | null;
  selectedRisk: ShipRisk;
  sources: string[];
  at: number;
};

export type ShipValidationPolicy = {
  risk: ShipRisk;
  requiredGates: GateName[];
  sources: string[];
  revision: string;
  mutationGeneration?: string;
  baseRevision?: string;
  changedPaths: string[];
  selectedAt: number;
  history: ShipRiskSelection[];
};

export const shipValidationPolicySchema = z.object({
  risk: z.enum(shipRiskLevels),
  requiredGates: z.array(gateSchema),
  sources: z.array(z.string().min(1)).min(1),
  revision: z.string().min(1),
  mutationGeneration: z.string().min(1).optional(),
  baseRevision: z.string().min(1).optional(),
  changedPaths: z.array(z.string()),
  selectedAt: z.number().int().nonnegative(),
  history: z.array(
    z.object({
      requestedRisk: z.enum(shipRiskLevels).nullable(),
      selectedRisk: z.enum(shipRiskLevels),
      sources: z.array(z.string().min(1)).min(1),
      at: z.number().int().nonnegative(),
    }),
  ),
});

export const defaultShipValidationConfig: ShipValidationConfig = {
  defaultRisk: 'medium',
  low: ['inline-review'],
  medium: ['code-adversary', 'findings-adversary', 'test-adversary'],
  high: ['code-adversary', 'findings-adversary', 'test-adversary'],
  paths: [],
};

function higherRisk(left: ShipRisk, right: ShipRisk): ShipRisk {
  return riskRank.get(left)! >= riskRank.get(right)! ? left : right;
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`${expression}$`);
}

export function pathMatchesRiskPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeRiskPath(path);
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  return globExpression(normalizedPattern).test(normalizedPath);
}

function normalizeRiskPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function selectShipValidationPolicy(
  configValue: unknown,
  changedPaths: string[],
  explicitRisk: ShipRisk | null,
  revision: string,
  previous: ShipValidationPolicy | undefined,
  now: number,
  baseRevision?: string,
  mutationGeneration?: string,
): ShipValidationPolicy {
  const configured = configValue !== undefined && configValue !== null;
  const config = configured
    ? shipValidationConfigSchema.parse(configValue)
    : defaultShipValidationConfig;
  let selectedRisk = config.defaultRisk;
  const sources = [`${configured ? 'repository' : 'Sail'} default: ${config.defaultRisk}`];
  if (explicitRisk) {
    selectedRisk = higherRisk(selectedRisk, explicitRisk);
    sources.push(`explicit choice: ${explicitRisk}`);
  }
  const paths = [...new Set(changedPaths)].toSorted();
  for (const rule of config.paths) {
    const expression = globExpression(normalizeRiskPath(rule.pattern));
    const matches = paths.filter((path) => expression.test(normalizeRiskPath(path)));
    if (!matches.length) continue;
    selectedRisk = higherRisk(selectedRisk, rule.risk);
    const sample = matches.slice(0, 5).join(', ');
    const remainder = matches.length > 5 ? `, +${matches.length - 5} more` : '';
    sources.push(`path rule ${rule.pattern}: ${rule.risk} (${sample}${remainder})`);
  }
  if (previous && riskRank.get(previous.risk)! > riskRank.get(selectedRisk)!) {
    selectedRisk = previous.risk;
    sources.push(`retained escalation: ${previous.risk}`);
  }
  const configuredGates = config[selectedRisk];
  const requiredGates = gateNames.filter(
    (gate) => configuredGates.includes(gate) || previous?.requiredGates.includes(gate),
  );
  if (previous?.requiredGates.some((gate) => !configuredGates.includes(gate)))
    sources.push('retained earlier required gates');
  const selection = { requestedRisk: explicitRisk, selectedRisk, sources, at: now };
  return shipValidationPolicySchema.parse({
    risk: selectedRisk,
    requiredGates,
    sources,
    revision,
    ...(mutationGeneration ? { mutationGeneration } : {}),
    ...(baseRevision ? { baseRevision } : {}),
    changedPaths: paths.slice(0, 500),
    selectedAt: now,
    history: [...(previous?.history ?? []), selection].slice(-50),
  });
}

export function requiredShipGatesSatisfied(
  policy: ShipValidationPolicy | undefined,
  gates: ShipGate[],
): boolean {
  return requiredValidationGatesSatisfied(policy, gates);
}

export async function readStableShipValidationInputs<T>(
  readRevision: () => Promise<string>,
  readMutationGeneration: () => Promise<string>,
  readChangedPaths: (baseRevision?: string) => Promise<string[]>,
  readConfig: () => Promise<T>,
  maxAttempts = 3,
  readBaseRevision?: () => Promise<string>,
): Promise<{
  revision: string;
  mutationGeneration: string;
  baseRevision?: string;
  changedPaths: string[];
  config: T;
}> {
  async function readAttempt(attemptsRemaining: number): Promise<{
    revision: string;
    mutationGeneration: string;
    baseRevision?: string;
    changedPaths: string[];
    config: T;
  }> {
    const mutationGeneration = await readMutationGeneration();
    const revision = await readRevision();
    const baseRevision = await readBaseRevision?.();
    const [changedPaths, config] = await Promise.all([
      readChangedPaths(baseRevision),
      readConfig(),
    ]);
    const currentRevision = await readRevision();
    const currentGeneration = await readMutationGeneration();
    const currentBaseRevision = await readBaseRevision?.();
    if (
      currentRevision === revision &&
      currentGeneration === mutationGeneration &&
      currentBaseRevision === baseRevision
    )
      return {
        revision,
        mutationGeneration,
        ...(baseRevision ? { baseRevision } : {}),
        changedPaths,
        config,
      };
    if (attemptsRemaining > 1) return readAttempt(attemptsRemaining - 1);
    throw new Error(
      'The worktree kept changing while selecting validation risk. Retry when stable.',
    );
  }
  return readAttempt(Math.max(1, maxAttempts));
}

export function assertShipGateAllowed(
  policy: ShipValidationPolicy | undefined,
  gate: GateName,
  revision: string,
  baseRevision?: string,
): void {
  if (!policy) throw new Error('Select validation risk before starting a gate.');
  if (policy.revision !== revision)
    throw new Error('The worktree changed after risk selection. Select risk again.');
  if (baseRevision !== undefined && policy.baseRevision !== baseRevision)
    throw new Error('The shipping base changed after risk selection. Select risk again.');
  if (!policy.requiredGates.includes(gate))
    throw new Error('This gate is not required by the selected validation policy.');
}

export type RequiredGateEvidenceAdapter = (input: {
  revision: string;
  requiredGates: GateName[];
  gates: ShipGate[];
}) => void | Promise<void>;

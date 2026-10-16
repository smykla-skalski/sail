import { z } from 'zod';

export const costPhases = [
  'resolve',
  'orchestrate',
  'explore',
  'branch',
  'implement',
  'publish',
  'review',
  'test',
  'pr',
  'wait',
  'fix',
  'merge',
  'complete',
] as const;
const roles = ['primary', 'subagent', 'validator', 'guardian', 'synthetic', 'probe'] as const;
const amount = z
  .string()
  .max(100)
  .regex(/^\d+(?:\.\d+)?(?:E[+-]?\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const tokenCostGroupSchema = z
  .object({
    estimated_usd: amount.nullable(),
    known_estimated_usd: amount.nullable(),
    unknown_observations: count,
    usage_observations: count,
  })
  .strict()
  .refine(
    (group) =>
      group.estimated_usd === null ||
      (group.unknown_observations === 0 && group.usage_observations > 0),
  );

export const shipTokenCostSchema = z
  .object({
    currency: z.literal('USD'),
    basis: z.literal('host usage deltas; caller-supplied USD prices per million tokens'),
    total: tokenCostGroupSchema,
    by_phase: z.partialRecord(z.enum(costPhases), tokenCostGroupSchema),
    by_role: z.partialRecord(z.enum(roles), tokenCostGroupSchema),
  })
  .strict();

export type ShipTokenCost = z.infer<typeof shipTokenCostSchema>;
export type TokenCostGroup = z.infer<typeof tokenCostGroupSchema>;

function dollars(value: string): string {
  const number = Number(value);
  if (number > 0 && number < 0.000001) return `$${number.toExponential(2)}`;
  return `$${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

export function tokenCostLabel(group?: TokenCostGroup): string {
  if (group?.estimated_usd !== null && group?.estimated_usd !== undefined)
    return `${dollars(group.estimated_usd)} estimated USD`;
  if (group?.known_estimated_usd !== null && group?.known_estimated_usd !== undefined)
    return `unknown · ${dollars(group.known_estimated_usd)} known subtotal USD`;
  return 'unknown';
}

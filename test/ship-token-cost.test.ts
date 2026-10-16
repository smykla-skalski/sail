import assert from 'node:assert/strict';
import test from 'node:test';
import {
  tokenCostLabel,
  shipTokenCostSchema,
  type TokenCostGroup,
} from '../src/lib/ship-token-cost.ts';
import { parseShipReport, loadShipRunStore, serializeShipRuns } from '../src/lib/ship-progress.ts';
import { fixture } from './ship-fixtures.ts';

const known: TokenCostGroup = {
  estimated_usd: '1.2500',
  known_estimated_usd: '1.2500',
  unknown_observations: 0,
  usage_observations: 2,
};
const cost = {
  currency: 'USD',
  basis: 'host usage deltas; caller-supplied USD prices per million tokens',
  total: known,
  by_phase: { implement: known },
  by_role: { primary: known },
};

for (const { name, group, expected } of [
  { name: 'missing report', group: undefined, expected: 'unknown' },
  {
    name: 'missing prices',
    group: { ...known, estimated_usd: null, known_estimated_usd: null, unknown_observations: 2 },
    expected: 'unknown',
  },
  {
    name: 'partial coverage',
    group: { ...known, estimated_usd: null, unknown_observations: 1 },
    expected: 'unknown · $1.25 known subtotal USD',
  },
  { name: 'known total', group: known, expected: '$1.25 estimated USD' },
  {
    name: 'measured zero',
    group: { ...known, estimated_usd: '0' },
    expected: '$0.00 estimated USD',
  },
  {
    name: 'small cost',
    group: { ...known, estimated_usd: '1E-8' },
    expected: '$1.00e-8 estimated USD',
  },
]) {
  void test(`shows ${name} without treating missing usage as zero`, () => {
    assert.equal(tokenCostLabel(group), expected);
  });
}

void test('accepts the sai aggregate and preserves it across active and archived storage', () => {
  const report = parseShipReport({ stage: 'implementing', status: 'running', tokenCost: cost });
  assert.ok('tokenCost' in report);
  const run = fixture();
  run.issues[0].tokenCost = report.tokenCost;
  run.archivedAt = 2;

  const restored = loadShipRunStore(serializeShipRuns([run], []));

  assert.deepEqual(restored.runs[0].issues[0].tokenCost, cost);
  assert.deepEqual(restored.unparsed, []);
});

for (const { name, invalid } of [
  { name: 'prompt content', invalid: { ...cost, prompt: 'private prompt' } },
  { name: 'source phase', invalid: { ...cost, by_phase: { 'private source': known } } },
  {
    name: 'credentials in money',
    invalid: { ...cost, total: { ...known, estimated_usd: 'secret' } },
  },
  { name: 'negative cost', invalid: { ...cost, total: { ...known, estimated_usd: '-1' } } },
  { name: 'infinity', invalid: { ...cost, total: { ...known, estimated_usd: '1E999' } } },
  {
    name: 'unknown total presented as complete',
    invalid: { ...cost, total: { ...known, unknown_observations: 1 } },
  },
  {
    name: 'absent observations presented as zero',
    invalid: { ...cost, total: { ...known, estimated_usd: '0', usage_observations: 0 } },
  },
]) {
  void test(`rejects ${name} at the progress boundary`, () => {
    assert.throws(() =>
      parseShipReport({ stage: 'testing', status: 'running', tokenCost: invalid }),
    );
  });
}

void test('old workers can report progress without measured cost', () => {
  assert.deepEqual(parseShipReport({ stage: 'testing', status: 'running' }), {
    stage: 'testing',
    status: 'running',
  });
  assert.equal(
    shipTokenCostSchema.parse({
      ...cost,
      total: {
        estimated_usd: null,
        known_estimated_usd: null,
        unknown_observations: 0,
        usage_observations: 0,
      },
    }).total.estimated_usd,
    null,
  );
});

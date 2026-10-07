import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertShipGateAllowed,
  pathMatchesRiskPattern,
  readStableShipValidationInputs,
  requiredShipGatesSatisfied,
  selectShipValidationPolicy,
  shipValidationConfigSchema,
} from '../src/lib/ship-risk-policy.ts';
import type { ShipGate } from '../src/lib/ship-progress.ts';

const config = {
  defaultRisk: 'low' as const,
  low: ['test-adversary' as const],
  medium: ['code-adversary' as const, 'test-adversary' as const],
  high: ['code-adversary' as const, 'findings-adversary' as const, 'test-adversary' as const],
  paths: [
    { pattern: 'src-tauri/**', risk: 'high' as const },
    { pattern: '**/*.sql', risk: 'medium' as const },
  ],
};

function gate(name: ShipGate['gate'], verdict: ShipGate['verdict'], updated = 1): ShipGate {
  return {
    id: `${name}:${updated}`,
    gate: name,
    requestedModel: 'model',
    provider: 'codex',
    model: 'model',
    threadId: 'thread',
    directory: '/worktree',
    state: 'completed',
    created: updated,
    updated,
    error: null,
    verdict,
    revision: 'revision-a',
  };
}

void test('path matching is deterministic across separators and recursive patterns', () => {
  assert.equal(pathMatchesRiskPattern('src-tauri/src/lib.rs', 'src-tauri/**'), true);
  assert.equal(pathMatchesRiskPattern('db/migrations/new.sql', '**/*.sql'), true);
  assert.equal(pathMatchesRiskPattern('db\\migrations\\new.sql', '**/*.sql'), true);
  assert.equal(pathMatchesRiskPattern('src/App.svelte', 'src-tauri/**'), false);
});

void test('risk is the maximum of default, explicit choice, and every matching path rule', () => {
  const selected = selectShipValidationPolicy(
    config,
    ['db/migrations/new.sql', 'src-tauri/src/lib.rs'],
    'medium',
    'revision-a',
    undefined,
    10,
  );
  assert.equal(selected.risk, 'high');
  assert.deepEqual(selected.requiredGates, [
    'code-adversary',
    'findings-adversary',
    'test-adversary',
  ]);
  assert.match(selected.sources.join('\n'), /explicit choice: medium/);
  assert.match(selected.sources.join('\n'), /src-tauri\/\*\*: high/);
  assert.deepEqual(selected.changedPaths, ['db/migrations/new.sql', 'src-tauri/src/lib.rs']);
});

void test('a later request cannot silently lower an earlier escalation', () => {
  const high = selectShipValidationPolicy(config, [], 'high', 'revision-a', undefined, 10);
  const retained = selectShipValidationPolicy(config, [], 'low', 'revision-b', high, 20);
  assert.equal(retained.risk, 'high');
  assert.match(retained.sources.join('\n'), /retained escalation: high/);
  assert.deepEqual(
    retained.history.map((entry) => entry.requestedRisk),
    ['high', 'low'],
  );

  const weakenedConfig = {
    ...config,
    high: ['code-adversary' as const, 'test-adversary' as const],
  };
  const retainedGates = selectShipValidationPolicy(
    weakenedConfig,
    [],
    'high',
    'revision-c',
    high,
    30,
  );
  assert.deepEqual(retainedGates.requiredGates, high.requiredGates);
  assert.match(retainedGates.sources.join('\n'), /retained earlier required gates/);
});

void test('repository policies cannot remove gates at higher risk', () => {
  assert.throws(
    () =>
      shipValidationConfigSchema.parse({
        defaultRisk: 'low',
        low: ['test-adversary'],
        medium: [],
        high: ['test-adversary'],
      }),
    /retain every low-risk gate/,
  );
  assert.throws(
    () =>
      shipValidationConfigSchema.parse({
        defaultRisk: 'low',
        low: [],
        medium: ['code-adversary'],
        high: [],
      }),
    /retain every medium-risk gate/,
  );
});

void test('all required gates need a latest successful terminal verdict', () => {
  const policy = selectShipValidationPolicy(config, [], 'high', 'revision-a', undefined, 10);
  const clean = gate('code-adversary', 'CLEAN');
  const findings = gate('findings-adversary', 'CLEAN');
  const pass = gate('test-adversary', 'PASS');
  assert.equal(requiredShipGatesSatisfied(policy, [clean, findings, pass]), true);
  assert.equal(requiredShipGatesSatisfied(policy, [clean, pass]), false);
  assert.equal(
    requiredShipGatesSatisfied(policy, [clean, findings, gate('test-adversary', 'FAIL')]),
    false,
  );
  assert.equal(
    requiredShipGatesSatisfied(policy, [clean, findings, pass, gate('test-adversary', 'FAIL', 2)]),
    false,
  );
  assert.equal(requiredShipGatesSatisfied(undefined, [clean, findings, pass]), false);
});

void test('required gates reject stale revisions and non-completed passing verdicts', () => {
  const policy = selectShipValidationPolicy(config, [], 'low', 'revision-a', undefined, 10);
  const pass = gate('test-adversary', 'PASS');

  assert.equal(requiredShipGatesSatisfied(policy, [{ ...pass, revision: 'revision-old' }]), false);
  assert.equal(requiredShipGatesSatisfied(policy, [{ ...pass, state: 'failed' }]), false);
  assert.equal(requiredShipGatesSatisfied(policy, [{ ...pass, state: 'interrupted' }]), false);
  assert.equal(
    requiredShipGatesSatisfied(policy, [pass, { ...pass, updated: 2, state: 'failed' }]),
    false,
  );
  assert.equal(
    requiredShipGatesSatisfied(policy, [
      pass,
      { ...pass, id: 'later-created', created: 2, state: 'failed' },
    ]),
    false,
  );
  assert.equal(
    requiredShipGatesSatisfied(policy, [
      pass,
      { ...pass, id: 'random-later-attempt', sequence: 2, verdict: 'FAIL' },
    ]),
    false,
  );
});

void test('validation inputs retry until paths and config share one stable revision', async () => {
  const revisions = ['revision-a', 'revision-b', 'revision-b', 'revision-b'];
  const generations = ['generation-a', 'generation-a', 'generation-b', 'generation-b'];
  const paths = [['stale.ts'], ['current.ts']];
  const configs = [{ source: 'stale' }, { source: 'current' }];

  const result = await readStableShipValidationInputs(
    async () => revisions.shift()!,
    async () => generations.shift()!,
    async () => paths.shift()!,
    async () => configs.shift()!,
  );

  assert.deepEqual(result, {
    revision: 'revision-b',
    mutationGeneration: 'generation-b',
    changedPaths: ['current.ts'],
    config: { source: 'current' },
  });
});

void test('validation inputs reject revision ABA when mutation generation changes', async () => {
  const revisions = ['revision-a', 'revision-a', 'revision-a', 'revision-a'];
  const generations = ['generation-a', 'generation-b', 'generation-b', 'generation-b'];
  const paths = [['stale.ts'], ['current.ts']];

  const result = await readStableShipValidationInputs(
    async () => revisions.shift()!,
    async () => generations.shift()!,
    async () => paths.shift()!,
    async () => ({ source: 'repository' }),
  );

  assert.deepEqual(result.changedPaths, ['current.ts']);
});

void test('validation inputs retry when the shipping base moves', async () => {
  const revisions = ['revision-a', 'revision-a', 'revision-a', 'revision-a'];
  const generations = ['generation-a', 'generation-a', 'generation-a', 'generation-a'];
  const bases = ['base-a', 'base-b', 'base-b', 'base-b'];
  const observedBases: (string | undefined)[] = [];

  const result = await readStableShipValidationInputs(
    async () => revisions.shift()!,
    async () => generations.shift()!,
    async (baseRevision) => {
      observedBases.push(baseRevision);
      return [`changed-from-${baseRevision}.ts`];
    },
    async () => ({ source: 'repository' }),
    3,
    async () => bases.shift()!,
  );

  assert.deepEqual(observedBases, ['base-a', 'base-b']);
  assert.deepEqual(result, {
    revision: 'revision-a',
    mutationGeneration: 'generation-a',
    baseRevision: 'base-b',
    changedPaths: ['changed-from-base-b.ts'],
    config: { source: 'repository' },
  });
});

void test('base rebinding retains risk history and gate floor while invalidating old gates', () => {
  const previous = selectShipValidationPolicy(
    config,
    ['src-tauri/src/lib.rs'],
    'high',
    'revision-a',
    undefined,
    10,
    'base-a',
    'generation-a',
  );
  const rebound = selectShipValidationPolicy(
    { ...config, high: ['code-adversary', 'test-adversary'] },
    [],
    'low',
    'revision-a',
    previous,
    20,
    'base-b',
    'generation-a',
  );
  const oldPass = { ...gate('test-adversary', 'PASS'), baseRevision: 'base-a' };

  assert.equal(rebound.risk, 'high');
  assert.deepEqual(rebound.requiredGates, previous.requiredGates);
  assert.equal(rebound.history.length, previous.history.length + 1);
  assert.equal(requiredShipGatesSatisfied(rebound, [oldPass]), false);
  assert.equal(
    requiredShipGatesSatisfied(rebound, [{ ...oldPass, baseRevision: 'base-b' }]),
    false,
  );
  assert.equal(
    requiredShipGatesSatisfied(rebound, [
      { ...gate('code-adversary', 'CLEAN'), baseRevision: 'base-b' },
      { ...gate('findings-adversary', 'CLEAN'), baseRevision: 'base-b' },
      { ...oldPass, baseRevision: 'base-b' },
    ]),
    true,
  );
});

void test('validation selection fails when the worktree never stabilizes', async () => {
  let revision = 0;

  await assert.rejects(
    readStableShipValidationInputs(
      async () => `revision-${revision++}`,
      async () => `generation-${revision}`,
      async () => ['current.ts'],
      async () => ({ source: 'repository' }),
      2,
    ),
    /kept changing/,
  );
});

void test('gate enforcement rejects missing, stale, and non-required policy', () => {
  const policy = selectShipValidationPolicy(
    config,
    [],
    'low',
    'revision-a',
    undefined,
    10,
    'base-a',
  );
  assert.doesNotThrow(() =>
    assertShipGateAllowed(policy, 'test-adversary', 'revision-a', 'base-a'),
  );
  assert.throws(
    () => assertShipGateAllowed(undefined, 'test-adversary', 'revision-a'),
    /Select validation risk/,
  );
  assert.throws(
    () => assertShipGateAllowed(policy, 'test-adversary', 'revision-b'),
    /worktree changed/,
  );
  assert.throws(
    () => assertShipGateAllowed(policy, 'code-adversary', 'revision-a'),
    /not required/,
  );
  assert.throws(
    () => assertShipGateAllowed(policy, 'test-adversary', 'revision-a', 'base-b'),
    /shipping base changed/,
  );
});

void test('persisted policy evidence stays bounded for large changes and repeated selection', () => {
  const paths = Array.from({ length: 600 }, (_, index) => `src-tauri/generated/${index}.rs`);
  let policy = selectShipValidationPolicy(config, paths, 'low', 'revision-a', undefined, 1);
  for (let at = 2; at <= 60; at += 1)
    policy = selectShipValidationPolicy(config, paths, 'low', `revision-${at}`, policy, at);
  assert.equal(policy.changedPaths.length, 500);
  assert.equal(policy.history.length, 50);
  assert.match(policy.sources.join('\n'), /\+595 more/);
});

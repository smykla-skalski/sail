import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acpModelId,
  evaluateModelRouting,
  parseModelRoutingSettings,
  selectModelRoute,
  type ModelRoutingSettings,
} from '../src/lib/model-routing.ts';

const settings: ModelRoutingSettings = {
  routes: [
    { role: 'exploration', risk: 'low', provider: 'claude', model: 'claude-haiku-4-5' },
    {
      role: 'implementation',
      risk: 'low',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      variant: 'high',
    },
    {
      role: 'implementation',
      risk: 'high',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      variant: 'xhigh',
    },
    { role: 'debugging', risk: 'medium', provider: 'opencode', model: 'openai:gpt-6.1-sol' },
    { role: 'review', risk: 'medium', provider: 'claude', model: 'review-model' },
    { role: 'review', risk: 'high', provider: 'claude', model: 'review-model' },
    { role: 'testing', risk: 'medium', provider: 'claude', model: 'review-model' },
    { role: 'ci-triage', risk: 'medium', provider: 'codex', model: 'gpt-6.1-luna' },
  ],
};

void test('selects an exact route by role and task risk', () => {
  assert.deepEqual(selectModelRoute(settings, { role: 'implementation', risk: 'low' }), {
    route: settings.routes[1],
    contextIsolationRequired: false,
    reason: null,
  });
  assert.match(
    selectModelRoute(settings, { role: 'debugging', risk: 'high' }).reason ?? '',
    /No high-risk debugging/,
  );
});

void test('rejects aliases and accepts a review route that uses the implementation model', () => {
  const alias = { ...settings, routes: [{ ...settings.routes[0], model: 'latest' }] };
  assert.match(selectModelRoute(alias, { role: 'exploration', risk: 'low' }).reason ?? '', /exact/);
  assert.deepEqual(selectModelRoute(settings, { role: 'review', risk: 'medium' }), {
    route: settings.routes[4],
    contextIsolationRequired: true,
    reason: null,
  });
  assert.equal(
    selectModelRoute(settings, { role: 'testing', risk: 'medium' }).contextIsolationRequired,
    true,
  );
});

void test('parses, deduplicates, and defaults review requirements safely', () => {
  const parsed = parseModelRoutingSettings(
    JSON.stringify({
      routes: [settings.routes[0], { ...settings.routes[0], model: 'replacement' }],
    }),
  );
  assert.equal(parsed.routes.length, 1);
  assert.equal(parsed.routes[0].model, 'replacement');
  assert.deepEqual(parsed, {
    routes: [{ ...settings.routes[0], model: 'replacement' }],
  });
});

void test('defaults safely when no model routes are configured', () => {
  const disabled = parseModelRoutingSettings(null);
  assert.deepEqual(disabled, { routes: [] });
  assert.deepEqual(selectModelRoute(disabled, { role: 'implementation', risk: 'high' }), {
    route: null,
    contextIsolationRequired: false,
    reason: null,
  });
  const malformedRoutes = parseModelRoutingSettings(JSON.stringify({ routes: 'invalid' }));
  assert.deepEqual(malformedRoutes, { routes: [] });
  for (const raw of [
    '{',
    JSON.stringify({
      routes: [{ role: 'implementation', risk: 'high', provider: 'codex', model: '' }],
    }),
  ]) {
    const malformed = parseModelRoutingSettings(raw);
    assert.deepEqual(malformed, { routes: [] });
    assert.equal(selectModelRoute(malformed, { role: 'implementation', risk: 'low' }).reason, null);
  }
});

void test('evaluates accepted tasks and known routing failures', () => {
  assert.deepEqual(evaluateModelRouting(settings), {
    revision: '2026-10-08.1',
    accepted: 6,
    acceptedTotal: 6,
    failuresPrevented: 2,
    failureTotal: 3,
  });
});

void test('OpenCode routes use the provider/model ID its ACP selector lists', () => {
  assert.equal(acpModelId('opencode', 'openai:gpt-6.1-sol'), 'openai/gpt-6.1-sol');
  assert.equal(acpModelId('opencode', 'opencode/big-pickle'), 'opencode/big-pickle');
  assert.equal(acpModelId('codex', 'provider:model'), 'provider:model');
  assert.equal(
    acpModelId('opencode', 'openrouter:anthropic/claude-sonnet-4'),
    'openrouter/anthropic/claude-sonnet-4',
  );
  for (const [model, accepted] of [
    ['openai/gpt-6.1-sol', true],
    ['openai:gpt-6.1-sol', true],
    ['gpt-6.1-sol', false],
  ] as const) {
    const selection = selectModelRoute(
      {
        routes: [{ role: 'debugging', risk: 'low', provider: 'opencode', model }],
      },
      { role: 'debugging', risk: 'low' },
    );
    assert.equal(!!selection.route, accepted, model);
  }
});

void test('legacy model-separation settings are ignored', () => {
  const parsed = parseModelRoutingSettings(
    JSON.stringify({ routes: [settings.routes[4]], independentReviewRisks: ['high'] }),
  );
  assert.deepEqual(parsed, { routes: [settings.routes[4]] });
});

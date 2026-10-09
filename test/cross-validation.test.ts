import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseValidationSettings,
  selectValidationChoice,
  validationInstructions,
} from '../src/lib/cross-validation.ts';

const settings = parseValidationSettings(
  JSON.stringify({
    choices: [
      { agent: 'claude', model: 'model-a' },
      { agent: 'codex', model: 'model-b' },
    ],
    strictDifferentModel: true,
  }),
);

void test('routes only to selected, available models outside every implementation model', () => {
  const available = [
    { agent: 'opencode', model: 'model-c' },
    { agent: 'claude', model: 'model-a' },
    { agent: 'codex', model: 'model-b' },
  ];
  assert.deepEqual(selectValidationChoice(settings, available, ['model-a']), {
    choice: { agent: 'codex', model: 'model-b' },
    reason: null,
  });
  assert.match(
    selectValidationChoice(settings, available, ['model-a', 'model-b']).reason ?? '',
    /Strict different-model/,
  );
});

void test('unavailable selections never fall back outside the selected pool', () => {
  const result = selectValidationChoice(settings, [{ agent: 'opencode', model: 'model-c' }], []);
  assert.equal(result.choice, null);
  assert.match(result.reason ?? '', /None of the selected/);
});

void test('non-strict routing falls back only after trying a different selected model', () => {
  const relaxed = { ...settings, strictDifferentModel: false };
  const available = settings.choices;
  assert.equal(
    selectValidationChoice(relaxed, available, ['model-a', 'model-b']).choice?.model,
    'model-a',
  );
});

void test('provider prefix does not disguise the same implementation model', () => {
  const pool = {
    choices: [{ agent: 'opencode', model: 'anthropic:model-a' }],
    strictDifferentModel: true,
  };
  assert.equal(selectValidationChoice(pool, pool.choices, ['model-a']).choice, null);
});

void test('empty or corrupt settings disable cross-validation', () => {
  assert.deepEqual(parseValidationSettings('{bad'), {
    choices: [],
    strictDifferentModel: false,
  });
  assert.match(
    validationInstructions(parseValidationSettings(null), 'gpt-5.6-luna'),
    /cross-validation is disabled[\s\S]*implementation agent and model[\s\S]*Do not call validation_gate/,
  );
  assert.match(validationInstructions(settings), /Report the actual provider and model/);
});

void test('an explicit strict policy still pauses without a selected model', () => {
  const strict = { choices: [], strictDifferentModel: true };
  assert.match(validationInstructions(strict), /Selected agent and model pool:\n\(empty\)/);
  assert.match(selectValidationChoice(strict, [], []).reason ?? '', /Select/);
});

void test('strict routing pauses for unresolved implementation or selected aliases', () => {
  for (const model of ['default', 'sonnet', 'opus[1m]', 'anthropic:claude-sonnet-latest']) {
    const concrete = {
      choices: [{ agent: 'codex', model: 'gpt-5.4' }],
      strictDifferentModel: true,
    };
    assert.equal(selectValidationChoice(concrete, concrete.choices, [model]).choice, null);
    assert.match(
      selectValidationChoice(concrete, concrete.choices, [model]).reason ?? '',
      /Cannot verify/,
    );
    const alias = { choices: [{ agent: 'claude', model }], strictDifferentModel: true };
    assert.equal(selectValidationChoice(alias, alias.choices, ['gpt-5.4']).choice, null);
  }
});

void test('aliases never count as verified different models', () => {
  const pool = {
    choices: [
      { agent: 'claude', model: 'sonnet' },
      { agent: 'codex', model: 'gpt-5.4' },
    ],
    strictDifferentModel: true,
  };
  assert.equal(
    selectValidationChoice(pool, pool.choices, ['claude-sonnet-4-6']).choice?.model,
    'gpt-5.4',
  );
});

await test('strict validation treats OpenCode provider:model and provider/model as one model', () => {
  const openCode = {
    choices: [{ agent: 'opencode', model: 'openai:gpt-6.1-sol' }],
    strictDifferentModel: true,
  };
  const selection = selectValidationChoice(openCode, openCode.choices, ['openai/gpt-6.1-sol']);
  assert.equal(selection.choice, null);
});

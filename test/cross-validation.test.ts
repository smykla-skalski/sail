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

void test('legacy model-separation settings are ignored and selected models remain eligible', () => {
  assert.deepEqual(settings, {
    choices: [
      { agent: 'claude', model: 'model-a' },
      { agent: 'codex', model: 'model-b' },
    ],
  });
  assert.deepEqual(
    selectValidationChoice(settings, [
      { agent: 'claude', model: 'model-a' },
      { agent: 'codex', model: 'model-b' },
    ]),
    { choice: { agent: 'claude', model: 'model-a' }, reason: null },
  );
});

void test('unavailable selections never fall back outside the selected pool', () => {
  const result = selectValidationChoice(settings, [{ agent: 'opencode', model: 'model-c' }]);
  assert.equal(result.choice, null);
  assert.match(result.reason ?? '', /None of the selected/);
});

void test('no configured pool still requires a fresh validation subagent session', () => {
  const empty = parseValidationSettings(null);
  assert.deepEqual(empty, { choices: [] });
  assert.match(selectValidationChoice(empty, []).reason ?? '', /No validation model/);
  const instructions = validationInstructions(empty, 'gpt-5.6-luna');
  assert.match(instructions, /validation_gate to start a fresh subagent session/);
  assert.match(instructions, /a different model is optional/);
  assert.doesNotMatch(instructions, /Do not call validation_gate/);
});

void test('configured pool instructions require fresh sessions and allow the implementation model', () => {
  const instructions = validationInstructions(settings, 'model-a');
  assert.match(instructions, /fresh/);
  assert.match(instructions, /may match the implementation model/);
  assert.match(instructions, /Report actual route metadata/);
});

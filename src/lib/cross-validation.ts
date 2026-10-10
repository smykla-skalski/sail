export type ValidationChoice = { agent: string; model: string };
export type ValidationRoute = { agent: string; model?: string };
export type ValidationSettings = { choices: ValidationChoice[] };

export const validationSettingsKey = 'sai-cross-validation';

/** Drops a `provider:` or `provider/` prefix so OpenCode's two ID forms compare equal. */
function modelId(value: string): string {
  return value.replace(/^[^/:]+[:/]/, '').toLowerCase();
}

export function hasUnresolvedModelAlias(value: string): boolean {
  return (
    /^(default|auto|latest|sonnet|opus|haiku|fable)(?:\[.*\])?$/.test(modelId(value)) ||
    /(?:^|-)latest$/.test(modelId(value))
  );
}

export function parseValidationSettings(raw: string | null): ValidationSettings {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') throw new Error('Invalid settings');
    if (!('choices' in value) || !Array.isArray(value.choices)) throw new Error('Invalid choices');
    const choices = value.choices.filter(
      (choice): choice is ValidationChoice =>
        !!choice &&
        typeof choice === 'object' &&
        typeof choice.agent === 'string' &&
        typeof choice.model === 'string' &&
        !!choice.agent.trim() &&
        !!choice.model.trim(),
    );
    return {
      choices: [
        ...new Map(choices.map((choice) => [`${choice.agent}\0${choice.model}`, choice])).values(),
      ],
    };
  } catch {
    return { choices: [] };
  }
}

export function selectValidationChoice(
  settings: { choices: ValidationRoute[] },
  available: ValidationRoute[],
): { choice: ValidationRoute | null; reason: string | null } {
  if (!settings.choices.length)
    return { choice: null, reason: 'No validation model is available.' };
  const eligible = settings.choices.filter((choice) =>
    available.some((item) => item.agent === choice.agent && item.model === choice.model),
  );
  if (!eligible.length)
    return { choice: null, reason: 'None of the selected cross-validation models is available.' };
  return { choice: eligible[0], reason: null };
}

export function validationInstructions(
  settings: ValidationSettings,
  currentModel?: string,
): string {
  if (!settings.choices.length)
    return [
      'No validation model pool is configured.',
      currentModel ? `Implementation model: ${currentModel}.` : '',
      'For every review and test attempt, use validation_gate to start a fresh subagent session. Use the assigned Ship worker provider and model by default when available; a different model is optional.',
      'If the provider cannot start a fresh session, pause and report the missing capability. Unresolved model metadata does not block a gate when its fresh execution identity is known.',
    ]
      .filter(Boolean)
      .join('\n');
  const pool = settings.choices.length
    ? settings.choices.map(({ agent, model }) => `- ${agent}: ${model}`).join('\n')
    : '(empty)';
  return [
    'Sail cross-validation policy:',
    `Selected agent and model pool:\n${pool}`,
    currentModel ? `Current implementation model: ${currentModel}.` : '',
    'Before each gate, check current availability of the selected pool and choose a selected available model. A validation session must be fresh, but its model may match the implementation model.',
    'In Sail, use the validation_gate tool for each pass in order, with the gate and prompt. Wait for its receipt before starting the next pass. The tool selects the configured route when present and starts a fresh session. If the tool is unavailable or cannot start a fresh session, pause the gate. Never launch an unselected agent or model as a substitute. Report actual route metadata when available.',
  ]
    .filter(Boolean)
    .join('\n');
}

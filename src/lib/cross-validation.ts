export type ValidationChoice = { agent: string; model: string };
export type ValidationSettings = { choices: ValidationChoice[]; strictDifferentModel: boolean };

export const validationSettingsKey = 'sai-cross-validation';

function modelId(value: string): string {
  return value.slice(value.indexOf(':') + 1).toLowerCase();
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
      strictDifferentModel: 'strictDifferentModel' in value && value.strictDifferentModel === true,
    };
  } catch {
    return { choices: [], strictDifferentModel: false };
  }
}

export function selectValidationChoice(
  settings: ValidationSettings,
  available: ValidationChoice[],
  implementingModels: string[],
): { choice: ValidationChoice | null; reason: string | null } {
  if (!settings.choices.length)
    return { choice: null, reason: 'Select cross-validation agents and models in Settings.' };
  const eligible = settings.choices.filter((choice) =>
    available.some((item) => item.agent === choice.agent && item.model === choice.model),
  );
  if (!eligible.length)
    return { choice: null, reason: 'None of the selected cross-validation models is available.' };
  const used = new Set(implementingModels.map(modelId));
  const different = eligible.find((choice) => !used.has(modelId(choice.model)));
  if (different) return { choice: different, reason: null };
  if (settings.strictDifferentModel)
    return {
      choice: null,
      reason:
        'Strict different-model routing is enabled, but no selected available model differs from every implementation model.',
    };
  return { choice: eligible[0], reason: null };
}

export function validationInstructions(
  settings: ValidationSettings,
  currentModel?: string,
): string {
  const pool = settings.choices.length
    ? settings.choices.map(({ agent, model }) => `- ${agent}: ${model}`).join('\n')
    : '(empty)';
  return [
    'Sail cross-validation policy:',
    `Selected agent and model pool:\n${pool}`,
    `Strict different-model routing: ${settings.strictDifferentModel ? 'on' : 'off'}.`,
    currentModel ? `Current implementation model: ${currentModel}.` : '',
    'Before each gate, collect every model that implemented the issue and check current availability of the selected pool. Choose a selected available model different from every implementation model when one exists. If strict routing is on and none exists, pause with the exact reason. An empty pool also pauses the gate.',
    'In Sail, use the validation_gate tool for each pass in order, with gate, prompt, and the complete implementingModels list. Wait for its receipt before starting the next pass. The tool selects the configured provider/model and starts a fresh session. If the tool is unavailable or cannot verify its actual model, pause the gate. Never launch an unselected agent or model as a substitute. Report the actual provider and model returned for each pass.',
  ]
    .filter(Boolean)
    .join('\n');
}

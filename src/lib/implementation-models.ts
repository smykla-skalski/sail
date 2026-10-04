import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './settings.ts';

function key(directory: string): string {
  return `sai-implementation-models:${directory}`;
}

export function implementationModels(directory: string): string[] {
  try {
    const saved: unknown = JSON.parse(getSetting(key(directory)) ?? '[]');
    return Array.isArray(saved)
      ? saved.filter((model): model is string => typeof model === 'string' && !!model.trim())
      : [];
  } catch {
    return [];
  }
}

export async function recordImplementationModel(
  directory: string,
  model: string | undefined,
  before: string,
): Promise<void> {
  if (!model) return;
  const after = await invoke<string>('working_tree_revision', { path: directory });
  if (before === after) return;
  const models = implementationModels(directory);
  if (!models.includes(model)) setSetting(key(directory), JSON.stringify([...models, model]));
}

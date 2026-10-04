import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './settings.ts';

function key(directory: string): string {
  return `sai-implementation-models:${directory}`;
}

function runKey(directory: string): string {
  return `sai-implementation-run:${directory}`;
}

export function beginShipItRun(directory: string, prompt: string): void {
  const firstLine = prompt.split('\n')[0].trim();
  if (!/^\/ship-it(?:\s|$)/i.test(firstLine)) return;
  const issue =
    /^\/ship-it\s+(https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+|(?:[^/\s]+\/[^/\s]+)?#\d+)/i.exec(
      firstLine,
    )?.[1];
  const identity = issue ?? crypto.randomUUID();
  if (issue && getSetting(runKey(directory)) === identity) return;
  setSetting(runKey(directory), identity);
  setSetting(key(directory), '[]');
}

export function implementationModels(directory: string): string[] {
  if (!getSetting(runKey(directory))) return [];
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
  if (!getSetting(runKey(directory))) return;
  const after = await invoke<string>('working_tree_revision', { path: directory });
  if (before === after) return;
  const models = implementationModels(directory);
  if (!models.includes(model)) setSetting(key(directory), JSON.stringify([...models, model]));
}

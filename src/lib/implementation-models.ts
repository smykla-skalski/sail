import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './settings.ts';

function key(directory: string): string {
  return `sai-implementation-models:${directory}`;
}

function runKey(directory: string): string {
  return `sai-implementation-run:${directory}`;
}

function uncertainKey(directory: string): string {
  return `sai-implementation-uncertain:${directory}`;
}

export type ImplementationTurn = { before: string; overlapped: boolean };
const activeTurns = new Map<string, Set<ImplementationTurn>>();

export async function beginImplementationTurn(directory: string): Promise<ImplementationTurn> {
  const active = activeTurns.get(directory) ?? new Set<ImplementationTurn>();
  const turn = { before: '', overlapped: active.size > 0 };
  if (turn.overlapped) for (const other of active) other.overlapped = true;
  active.add(turn);
  activeTurns.set(directory, active);
  try {
    turn.before = await invoke<string>('working_tree_revision', { path: directory });
    return turn;
  } catch (cause) {
    abandonImplementationTurn(directory, turn);
    throw cause;
  }
}

export function abandonImplementationTurn(directory: string, turn: ImplementationTurn): void {
  const active = activeTurns.get(directory);
  active?.delete(turn);
  if (!active?.size) activeTurns.delete(directory);
}

export function implementationAttributionUncertain(directory: string): boolean {
  return getSetting(uncertainKey(directory)) === '1';
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
  setSetting(uncertainKey(directory), '0');
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
  turn: ImplementationTurn,
): Promise<void> {
  try {
    if (!getSetting(runKey(directory))) return;
    const after = await invoke<string>('working_tree_revision', { path: directory });
    if (turn.before === after) return;
    if (turn.overlapped) {
      setSetting(uncertainKey(directory), '1');
      return;
    }
    if (!model) return;
    const models = implementationModels(directory);
    if (!models.includes(model)) setSetting(key(directory), JSON.stringify([...models, model]));
  } finally {
    abandonImplementationTurn(directory, turn);
  }
}

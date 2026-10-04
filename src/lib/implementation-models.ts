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

export type ImplementationTurn = {
  before: string;
  model: string | undefined;
  owner: string | undefined;
  peers: Set<ImplementationTurn>;
};
const activeTurns = new Map<string, Set<ImplementationTurn>>();

export async function beginImplementationTurn(
  directory: string,
  model?: string,
  owner?: string,
): Promise<ImplementationTurn> {
  const active = activeTurns.get(directory) ?? new Set<ImplementationTurn>();
  const turn: ImplementationTurn = { before: '', model, owner, peers: new Set() };
  for (const other of active) {
    turn.peers.add(other);
    other.peers.add(turn);
  }
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

export async function activeImplementationModels(
  directory: string,
  sourceId?: string,
): Promise<string[] | null> {
  const active = [...(activeTurns.get(directory) ?? [])];
  if (!active.length) return [];
  const revision = await invoke<string>('working_tree_revision', { path: directory });
  const relevant = active.filter((turn) => turn.owner !== sourceId || turn.before !== revision);
  const participants = new Set<ImplementationTurn>();
  for (const turn of relevant) {
    participants.add(turn);
    if (turn.before !== revision) for (const peer of turn.peers) participants.add(peer);
  }
  return [...participants].every((turn) => turn.model)
    ? [...participants].map((turn) => turn.model!)
    : null;
}

export function beginShipItRun(directory: string, prompt: string): void {
  const firstLine = prompt.split('\n')[0].trim();
  if (!/^\/ship-it(?:\s|$)/i.test(firstLine)) return;
  const issue =
    /^\/ship-it\s+(https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+|(?:[^/\s]+\/[^/\s]+)?#\d+)/i.exec(
      firstLine,
    )?.[1];
  if (!issue) return;
  const identity = `#${issue.match(/\d+$/)![0]}`;
  const previous = getSetting(runKey(directory));
  if (previous && previous !== identity)
    throw new Error(`This worktree tracks ${previous}. Start ${identity} in a new worktree.`);
  setSetting(runKey(directory), identity);
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
  turn: ImplementationTurn,
): Promise<void> {
  try {
    const after = await invoke<string>('working_tree_revision', { path: directory });
    if (turn.before === after) return;
    turn.model = model ?? turn.model;
    const participants = [turn, ...turn.peers];
    if (participants.some((participant) => !participant.model)) {
      setSetting(uncertainKey(directory), '1');
      return;
    }
    const models = new Set(implementationModels(directory));
    for (const participant of participants) models.add(participant.model!);
    setSetting(key(directory), JSON.stringify([...models]));
  } finally {
    abandonImplementationTurn(directory, turn);
  }
}

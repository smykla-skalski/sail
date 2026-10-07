import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from './settings.ts';
import { slashCommands } from './slash-commands.ts';

function key(directory: string): string {
  return `sai-implementation-models:${directory}`;
}

function runKey(directory: string): string {
  return `sai-implementation-run:${directory}`;
}

function shipOwnerKey(directory: string): string {
  return `sai-ship-it-owner:${directory}`;
}

function uncertainKey(directory: string): string {
  return `sai-implementation-uncertain:${directory}`;
}

function pendingKey(directory: string): string {
  return `sai-implementation-pending:${directory}`;
}

type PendingTurn = { id: string; before: string; model?: string; owner?: string };

function pendingTurns(directory: string): PendingTurn[] {
  try {
    const saved: unknown = JSON.parse(getSetting(pendingKey(directory)) ?? '[]');
    return Array.isArray(saved)
      ? saved.filter(
          (turn): turn is PendingTurn =>
            !!turn &&
            typeof turn.id === 'string' &&
            typeof turn.before === 'string' &&
            (turn.model === undefined || typeof turn.model === 'string') &&
            (turn.owner === undefined || typeof turn.owner === 'string'),
        )
      : [];
  } catch {
    return [];
  }
}

export function hasPendingImplementationTurn(directory: string, owner?: string): boolean {
  return pendingTurns(directory).some((turn) => owner === undefined || turn.owner === owner);
}

export function claimLegacyPendingImplementationTurn(directory: string, owner: string): boolean {
  const turns = pendingTurns(directory);
  const legacy = turns.filter((turn) => turn.owner === undefined);
  if (legacy.length !== 1 || turns.some((turn) => turn.owner && turn.owner !== owner)) return false;
  legacy[0].owner = owner;
  savePendingTurns(directory, turns);
  return true;
}

function savePendingTurns(directory: string, turns: PendingTurn[]): void {
  setSetting(pendingKey(directory), JSON.stringify(turns));
}

export type ImplementationTurn = {
  id: string;
  before: string;
  model: string | undefined;
  owner: string | undefined;
  peers: Set<ImplementationTurn>;
};

export type ShipItIssue = {
  repository: string;
  number: number;
};

export function savedShipItOwner(directory: string): string | null {
  const owner = getSetting(shipOwnerKey(directory));
  return owner?.trim() || null;
}

export function recordShipItOwner(directory: string, owner: string): void {
  setSetting(shipOwnerKey(directory), owner);
}

export function savedShipItIssue(directory: string): ShipItIssue | null {
  const match = /^([^#]+)#([1-9]\d*)$/.exec(getSetting(runKey(directory)) ?? '');
  return match ? { repository: match[1], number: Number(match[2]) } : null;
}
const activeTurns = new Map<string, Set<ImplementationTurn>>();

export async function beginImplementationTurn(
  directory: string,
  model?: string,
  owner?: string,
): Promise<ImplementationTurn> {
  await recoverImplementationModels(directory);
  const active = activeTurns.get(directory) ?? new Set<ImplementationTurn>();
  const turn: ImplementationTurn = {
    id: crypto.randomUUID(),
    before: '',
    model,
    owner,
    peers: new Set(),
  };
  for (const other of active) {
    turn.peers.add(other);
    other.peers.add(turn);
  }
  active.add(turn);
  activeTurns.set(directory, active);
  try {
    turn.before = await invoke<string>('working_tree_revision', { path: directory });
    savePendingTurns(directory, [
      ...pendingTurns(directory),
      { id: turn.id, before: turn.before, model, owner },
    ]);
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

export async function recoverImplementationModels(directory: string): Promise<void> {
  const active = activeTurns.get(directory) ?? new Set();
  const pending = pendingTurns(directory);
  const interrupted = pending.filter((turn) => ![...active].some((item) => item.id === turn.id));
  if (!interrupted.length) return;
  const revision = await invoke<string>('working_tree_revision', { path: directory });
  const models = new Set(implementationModels(directory));
  for (const turn of interrupted) {
    if (turn.before === revision) continue;
    if (turn.model) models.add(turn.model);
    else setSetting(uncertainKey(directory), '1');
  }
  setSetting(key(directory), JSON.stringify([...models]));
  savePendingTurns(
    directory,
    pending.filter((turn) => !interrupted.includes(turn)),
  );
}

export async function settledImplementationAttribution(directory: string) {
  await recoverImplementationModels(directory);
  if (pendingTurns(directory).length)
    throw new Error('Implementation attribution is still settling.');
  return {
    models: implementationModels(directory),
    modelUncertain: implementationAttributionUncertain(directory),
  };
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

export async function beginShipItRun(
  directory: string,
  prompt: string,
  selectedSkill?: string | null,
): Promise<ShipItIssue | null> {
  if (selectedSkill !== undefined && selectedSkill?.toLowerCase() !== 'ship-it') return null;
  const command = slashCommands(prompt).find((item) => item.name.toLowerCase() === 'ship-it');
  if (!command) return null;
  const issue =
    /^(?:\s+(?:--issue|--risk\s+(?:low|medium|high))(?=\s))*\s+(https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+|(?:[^/\s]+\/[^/\s]+)?#\d+)/i.exec(
      prompt.slice(command.end),
    )?.[1];
  if (!issue) return null;
  const canonical = async (reference: string): Promise<string> => {
    const number = Number(reference.match(/\d+$/)![0]);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Choose an issue.');
    const qualified = /^(?:https?:\/\/github\.com\/)?([^/\s]+\/[^/#\s]+)(?:\/issues\/|#)/i.exec(
      reference,
    );
    if (qualified) return `${qualified[1].toLowerCase()}#${number}`;
    const repository = await invoke<string>('github_issue_repository', { repository: directory });
    return `${repository.toLowerCase()}#${number}`;
  };
  const identity = await canonical(issue);
  const saved = getSetting(runKey(directory));
  const previous = saved ? await canonical(saved) : undefined;
  if (previous && previous !== identity)
    throw new Error(`This worktree tracks ${previous}. Start ${identity} in a new worktree.`);
  setSetting(runKey(directory), identity);
  const [repository, number] = identity.split('#');
  return { repository, number: Number(number) };
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
  let completed = false;
  try {
    const after = await invoke<string>('working_tree_revision', { path: directory });
    if (turn.before === after) {
      completed = true;
      return;
    }
    turn.model = model ?? turn.model;
    const participants = [turn, ...turn.peers];
    if (participants.some((participant) => !participant.model)) {
      setSetting(uncertainKey(directory), '1');
      completed = true;
      return;
    }
    const models = new Set(implementationModels(directory));
    for (const participant of participants) models.add(participant.model!);
    setSetting(key(directory), JSON.stringify([...models]));
    completed = true;
  } finally {
    if (completed)
      savePendingTurns(
        directory,
        pendingTurns(directory).filter((pending) => pending.id !== turn.id),
      );
    abandonImplementationTurn(directory, turn);
  }
}

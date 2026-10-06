import type { AgentAvailability, AgentId, AgentThread } from './acp';
import type { ProjectCatalog } from './projects';
import { threadKey } from './recent-threads.ts';
import { commandsForDirectory, type SavedCommand } from './saved-commands.ts';

export type PaletteStep =
  | { kind: 'projects' }
  | { kind: 'worktrees'; repository: string }
  | { kind: 'agents'; repository: string; directory: string }
  | { kind: 'sessions'; repository: string; directory: string; agent: AgentId };

export type PaletteEntry = {
  id: string;
  kind:
    | 'project'
    | 'worktree'
    | 'new-worktree'
    | 'agent'
    | 'new-session'
    | 'thread'
    | 'opencode-session'
    | 'command';
  label: string;
  detail: string;
  disabled?: boolean;
  directory?: string;
  agent?: AgentId;
  thread?: AgentThread;
  sessionId?: string;
  command?: SavedCommand;
};

export type PaletteOpenCodeSession = {
  id: string;
  title: string;
  directory: string;
  parentID: string | null;
  updated: number;
};

export type PaletteSearch = {
  step: PaletteStep;
  query: string;
  catalog: ProjectCatalog;
  currentDirectory: string;
  agents: AgentAvailability[];
  threads: AgentThread[];
  openCodeAvailable: boolean;
  openCodeSessions: PaletteOpenCodeSession[];
  commands: SavedCommand[];
  runningThreadKeys: string[];
};

export function locationName(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

function fuzzyScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return direct;
  let previous = -1;
  let gapScore = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, previous + 1);
    if (index < 0) return null;
    gapScore += index - previous - 1;
    previous = index;
  }
  return gapScore;
}

function score(text: string, query: string): number | null {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .reduce<number | null>((total, term) => {
      const match = fuzzyScore(text, term);
      return total === null || match === null ? null : total + match;
    }, 0);
}

function rank(
  entries: PaletteEntry[],
  query: string,
  searchText = (entry: PaletteEntry) => `${entry.label} ${entry.detail}`,
  priority: (entry: PaletteEntry) => number = () => 0,
): PaletteEntry[] {
  return entries
    .flatMap((entry) => {
      const matchScore = score(searchText(entry), query);
      return matchScore === null ? [] : [{ entry, matchScore }];
    })
    .toSorted((a, b) => priority(b.entry) - priority(a.entry) || a.matchScore - b.matchScore)
    .slice(0, 50)
    .map(({ entry }) => entry);
}

function directoryContext(catalog: ProjectCatalog, directory: string) {
  for (const repository of catalog.repositories) {
    if (repository === directory)
      return { repository, project: locationName(repository), location: 'Main checkout' };
    const worktree = (catalog.worktrees[repository] ?? []).find((item) => item.path === directory);
    if (worktree)
      return { repository, project: locationName(repository), location: worktree.branch };
  }
  return null;
}

export function searchCommandPalette({
  step,
  query,
  catalog,
  currentDirectory,
  agents,
  threads,
  openCodeAvailable,
  openCodeSessions,
  commands,
  runningThreadKeys,
}: PaletteSearch): PaletteEntry[] {
  if (step.kind === 'projects') {
    const repositories: PaletteEntry[] = catalog.repositories.map((repository) => {
      const group = catalog.groups.find((item) => item.repositories.includes(repository));
      return {
        id: `project:${repository}`,
        kind: 'project',
        label: locationName(repository),
        detail: `${group?.name ?? 'Ungrouped'} · ${repository}`,
        directory: repository,
      };
    });
    const projects = rank(repositories, query).toSorted(
      (a, b) => Number(b.directory === currentDirectory) - Number(a.directory === currentDirectory),
    );
    const commandEntries: PaletteEntry[] = commandsForDirectory(
      commands,
      catalog,
      currentDirectory,
    ).map((command) => ({
      id: `command:${command.id}`,
      kind: 'command',
      label: command.name,
      detail: command.project ? 'Project command' : 'Global command',
      command,
    }));
    const saved = rank(
      commandEntries,
      query,
      (entry) => `${entry.label} ${entry.detail} ${entry.command?.command ?? ''}`,
    );
    if (query.trim()) {
      const worktrees: PaletteEntry[] = catalog.repositories.flatMap((repository) =>
        (catalog.worktrees[repository] ?? []).map((worktree) => ({
          id: `worktree:${worktree.path}`,
          kind: 'worktree' as const,
          label: worktree.branch,
          detail: `${locationName(repository)} · ${worktree.path}`,
          directory: worktree.path,
        })),
      );
      const running = new Set(runningThreadKeys);
      const uniqueThreads = new Map(threads.map((thread) => [threadKey(thread), thread]));
      const sessionEntries: PaletteEntry[] = [...uniqueThreads.entries()].flatMap(
        ([key, thread]) => {
          const context = directoryContext(catalog, thread.directory);
          if (!context) return [];
          const agentName =
            thread.agent === 'opencode'
              ? 'OpenCode'
              : (agents.find((agent) => agent.id === thread.agent)?.name ?? thread.agent);
          const available =
            thread.agent === 'opencode'
              ? openCodeAvailable
              : !!agents.find((agent) => agent.id === thread.agent)?.available;
          return [
            {
              id: `global-thread:${key}`,
              kind: 'thread' as const,
              label: thread.title,
              detail: `${agentName} · ${context.project} / ${context.location}${running.has(key) ? ' · Running' : ''}`,
              directory: thread.directory,
              agent: thread.agent,
              thread,
              disabled: !available,
            },
          ];
        },
      );
      return rank(
        [...repositories, ...worktrees, ...sessionEntries, ...commandEntries],
        query,
        (entry) => `${entry.label} ${entry.detail} ${entry.command?.command ?? ''}`,
        (entry) =>
          entry.thread && running.has(threadKey(entry.thread))
            ? 2
            : entry.kind === 'command'
              ? 1
              : 0,
      );
    }
    const projectSlots = 50 - Math.min(saved.length, 10);
    return [...projects.slice(0, projectSlots), ...saved.slice(0, 50 - projectSlots)];
  }

  if (step.kind === 'worktrees') {
    const locations: PaletteEntry[] = [
      {
        id: `worktree:${step.repository}`,
        kind: 'worktree',
        label: 'Main checkout',
        detail: step.repository,
        directory: step.repository,
      },
      ...(catalog.worktrees[step.repository] ?? []).map((worktree) => ({
        id: `worktree:${worktree.path}`,
        kind: 'worktree' as const,
        label: worktree.branch,
        detail: worktree.path,
        directory: worktree.path,
      })),
    ];
    const create: PaletteEntry = {
      id: `new-worktree:${step.repository}`,
      kind: 'new-worktree',
      label: 'Create new worktree…',
      detail: `For ${locationName(step.repository)}`,
    };
    const newWorktree = !query.trim() || score(`${create.label} ${create.detail}`, query) !== null;
    const worktrees = rank(locations, query);
    return query.trim() ? [...(newWorktree ? [create] : []), ...worktrees] : [...worktrees, create];
  }

  if (step.kind === 'agents') {
    return rank(
      [
        {
          id: 'agent:opencode',
          kind: 'agent',
          label: 'OpenCode',
          detail: openCodeAvailable ? 'Sail architect and work sessions' : 'OpenCode unavailable',
          agent: 'opencode',
          disabled: !openCodeAvailable,
        },
        ...agents.map((agent) => ({
          id: `agent:${agent.id}`,
          kind: 'agent' as const,
          label: agent.name,
          detail: agent.available ? 'Agent sessions' : (agent.reason ?? 'Unavailable'),
          agent: agent.id,
          disabled: !agent.available,
        })),
      ],
      query,
    );
  }

  const create: PaletteEntry = {
    id: `new-session:${step.agent}:${step.directory}`,
    kind: 'new-session',
    label: 'New session',
    detail: `Start with ${step.agent === 'opencode' ? 'OpenCode' : (agents.find((agent) => agent.id === step.agent)?.name ?? step.agent)}`,
  };
  const existing: PaletteEntry[] =
    step.agent === 'opencode'
      ? openCodeSessions
          .filter((session) => session.directory === step.directory && !session.parentID)
          .toSorted((a, b) => b.updated - a.updated)
          .map((session) => ({
            id: `opencode-session:${session.id}`,
            kind: 'opencode-session',
            label: session.title,
            detail: new Date(session.updated).toLocaleString(),
            sessionId: session.id,
          }))
      : threads
          .filter((thread) => thread.directory === step.directory && thread.agent === step.agent)
          .toSorted((a, b) => b.updated - a.updated)
          .map((thread) => ({
            id: `thread:${thread.agent}:${thread.directory}:${thread.sessionId}`,
            kind: 'thread',
            label: thread.title,
            detail: new Date(thread.updated).toLocaleString(),
            thread,
          }));
  const newSession = !query.trim() || score(create.label, query) !== null ? [create] : [];
  return [...newSession, ...rank(existing, query)].slice(0, 50);
}

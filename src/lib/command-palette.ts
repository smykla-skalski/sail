import type { AgentAvailability, AgentId, AgentThread } from './acp';
import type { ProjectCatalog } from './projects';
import { threadKey } from './recent-threads.ts';
import { commandsForDirectory, type SavedCommand } from './saved-commands.ts';
import { shortcutFor, type ShortcutId } from './shortcuts.ts';
import type { ThemePreference } from './theme.ts';

export type PaletteActionId =
  | 'pane.split'
  | 'terminal.split'
  | 'chat.side'
  | 'inbox.open'
  | 'attention.next'
  | 'overview.toggle'
  | 'ship.open'
  | 'changes.toggle'
  | 'settings.open'
  | 'theme.system'
  | 'theme.light'
  | 'theme.dark'
  | 'shortcuts.help'
  | 'sidebar.toggle';

export type PaletteAction = {
  id: PaletteActionId;
  label: string;
  detail: string;
  /** Shown as the entry's hint; the label also comes from the registry. */
  shortcut?: ShortcutId;
  disabled?: boolean;
};

export type PaletteActionContext = {
  theme: ThemePreference;
  overview: boolean;
  hasDirectory: boolean;
};

function registryAction(
  id: PaletteActionId & ShortcutId,
  detail: string,
  disabled = false,
): PaletteAction {
  return { id, label: shortcutFor(id).label, detail, shortcut: id, disabled };
}

const themeLabels: Record<ThemePreference, string> = {
  system: 'Follow system theme',
  light: 'Switch to light theme',
  dark: 'Switch to dark theme',
};

/** One action for each theme choice other than the current one. */
function themeActions(current: ThemePreference): PaletteAction[] {
  return (['system', 'light', 'dark'] as const)
    .filter((theme) => theme !== current)
    .map((theme) => ({ id: `theme.${theme}`, label: themeLabels[theme], detail: 'Appearance' }));
}

/** App actions the palette offers; labels and hints for shortcuts come from the registry. */
export function paletteActions({ theme, overview, hasDirectory }: PaletteActionContext) {
  const actions: PaletteAction[] = [
    registryAction('pane.split', 'Open another pane beside this one', !hasDirectory),
    registryAction('terminal.split', 'Open a terminal beside this pane', !hasDirectory),
    registryAction('chat.side', 'Ask a question without leaving this thread', !hasDirectory),
    { id: 'inbox.open', label: 'Open Inbox', detail: 'Requests and items waiting on you' },
    registryAction('attention.next', 'Jump to the next thread, request or Ship item'),
    {
      id: 'overview.toggle',
      label: overview ? 'Back to workspace' : 'Open task overview',
      detail: 'All worktrees at a glance',
    },
    { id: 'ship.open', label: 'Open Ship runs', detail: 'Issues being shipped end to end' },
    {
      id: 'changes.toggle',
      label: shortcutFor('details.toggle').label,
      detail: 'Review the diff for this worktree',
      shortcut: 'details.toggle',
    },
    registryAction('settings.open', 'Theme, notifications and agents'),
    ...themeActions(theme),
    registryAction('shortcuts.help', 'List every keyboard shortcut'),
    registryAction('sidebar.toggle', 'Show or hide the project sidebar'),
  ];
  return actions;
}

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
    | 'command'
    | 'action';
  label: string;
  detail: string;
  disabled?: boolean;
  directory?: string;
  agent?: AgentId;
  thread?: AgentThread;
  sessionId?: string;
  command?: SavedCommand;
  actionId?: PaletteActionId;
  shortcut?: ShortcutId;
};

export type PaletteSearch = {
  step: PaletteStep;
  query: string;
  catalog: ProjectCatalog;
  currentDirectory: string;
  agents: AgentAvailability[];
  threads: AgentThread[];
  commands: SavedCommand[];
  runningThreadKeys: string[];
  actions?: PaletteAction[];
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
  commands,
  runningThreadKeys,
  actions = [],
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
    const actionEntries: PaletteEntry[] = actions.map((action) => ({
      id: `action:${action.id}`,
      kind: 'action',
      label: action.label,
      detail: action.detail,
      disabled: action.disabled,
      actionId: action.id,
      shortcut: action.shortcut,
    }));
    if (query.trim()) {
      // Fuzzy gaps let unrelated actions match; require every term as a whole substring.
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matchingActions = actionEntries.filter((entry) =>
        terms.every((term) => entry.label.toLowerCase().includes(term)),
      );
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
          const agentName = agents.find((agent) => agent.id === thread.agent)?.name ?? thread.agent;
          const available = !!agents.find((agent) => agent.id === thread.agent)?.available;
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
        [...repositories, ...worktrees, ...sessionEntries, ...commandEntries, ...matchingActions],
        query,
        // Action details are prose; matching them would outrank exact thread and project names.
        (entry) =>
          entry.kind === 'action'
            ? entry.label
            : `${entry.label} ${entry.detail} ${entry.directory ?? ''} ${entry.command?.command ?? ''}`,
        (entry) =>
          entry.thread && running.has(threadKey(entry.thread))
            ? 2
            : entry.kind === 'command'
              ? 1
              : 0,
      );
    }
    // Actions come on top of the 50 project and command entries, so no project is dropped.
    const projectSlots = 50 - Math.min(saved.length, 10);
    return [
      ...projects.slice(0, projectSlots),
      ...saved.slice(0, 50 - projectSlots),
      ...actionEntries,
    ];
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
      agents.map((agent) => ({
        id: `agent:${agent.id}`,
        kind: 'agent' as const,
        label: agent.name,
        detail: agent.available ? 'Agent sessions' : (agent.reason ?? 'Unavailable'),
        agent: agent.id,
        disabled: !agent.available,
      })),
      query,
    );
  }

  const create: PaletteEntry = {
    id: `new-session:${step.agent}:${step.directory}`,
    kind: 'new-session',
    label: 'New session',
    detail: `Start with ${agents.find((agent) => agent.id === step.agent)?.name ?? step.agent}`,
  };
  const seen = new Set<string>();
  const existing: PaletteEntry[] = threads
    .filter((thread) => thread.directory === step.directory && thread.agent === step.agent)
    .toSorted((a, b) => b.updated - a.updated)
    .filter((thread) => {
      // A saved thread and its session/list entry name one session.
      if (seen.has(thread.sessionId)) return false;
      seen.add(thread.sessionId);
      return true;
    })
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

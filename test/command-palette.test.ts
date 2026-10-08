import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paletteActions,
  searchCommandPalette,
  type PaletteOpenCodeSession,
  type PaletteSearch,
  type PaletteStep,
} from '../src/lib/command-palette.ts';
import type { AgentAvailability, AgentThread } from '../src/lib/acp.ts';
import type { ProjectCatalog } from '../src/lib/projects.ts';
import { loadSavedCommands } from '../src/lib/saved-commands.ts';
import { shortcutFor } from '../src/lib/shortcuts.ts';

const catalog: ProjectCatalog = {
  repositories: ['/work/alpha', '/other/alpha', '/work/bravo'],
  groups: [{ id: 'team', name: 'Team project', collapsed: false, repositories: ['/work/alpha'] }],
  worktrees: { '/work/alpha': [{ path: '/work/alpha-feature', branch: 'feature' }] },
};
const agents: AgentAvailability[] = [
  { id: 'claude', name: 'Claude', binaryPath: '/bin/claude', available: true, reason: null },
  { id: 'codex', name: 'Codex', binaryPath: null, available: false, reason: 'Not installed' },
];
const threads: AgentThread[] = [
  {
    agent: 'claude',
    directory: '/work/alpha-feature',
    sessionId: 'old',
    title: 'Older',
    updated: 2,
  },
  {
    agent: 'claude',
    directory: '/work/alpha-feature',
    sessionId: 'new',
    title: 'Newest',
    updated: 3,
  },
  { agent: 'claude', directory: '/work/bravo', sessionId: 'other', title: 'Elsewhere', updated: 4 },
];

function search(step: PaletteStep, query = '', options: Partial<PaletteSearch> = {}) {
  return searchCommandPalette({
    step,
    query,
    catalog,
    currentDirectory: '/work/alpha',
    agents,
    threads,
    openCodeAvailable: true,
    openCodeSessions: [],
    commands: [],
    runningThreadKeys: [],
    ...options,
  });
}

function session(
  id: string,
  directory: string,
  parentID: string | null = null,
): PaletteOpenCodeSession {
  return { id, title: id, directory, parentID, updated: 3 };
}

void test('project search keeps duplicate names distinct and shows group context', () => {
  const matches = search({ kind: 'projects' }, 'alpha');
  assert.deepEqual(
    matches.filter((entry) => entry.kind === 'project').map((entry) => entry.directory),
    ['/work/alpha', '/other/alpha'],
  );
  assert.match(matches[0].detail, /Team project/);
  assert.equal(search({ kind: 'projects' }, 'feature')[0]?.directory, '/work/alpha-feature');
});

void test('root search finds agent work by title, provider, and worktree context', () => {
  const titleMatch = search({ kind: 'projects' }, 'older');
  const providerAndBranchMatch = search({ kind: 'projects' }, 'claude feature');
  const pathMatch = search({ kind: 'projects' }, '/work/alpha-feature');

  assert.equal(titleMatch[0]?.thread?.sessionId, 'old');
  assert.deepEqual(
    providerAndBranchMatch.map((entry) => entry.thread?.sessionId),
    ['old', 'new'],
  );
  assert.deepEqual(
    pathMatch.filter((entry) => entry.kind === 'thread').map((entry) => entry.thread?.sessionId),
    ['old', 'new'],
  );
});

void test('root search puts running agent work first', () => {
  const matches = search({ kind: 'projects' }, 'claude feature', {
    runningThreadKeys: [JSON.stringify(['claude', '/work/alpha-feature', 'old'])],
  });

  assert.equal(matches[0]?.thread?.sessionId, 'old');
  assert.match(matches[0]?.detail ?? '', /Running/);
});

void test('root search deduplicates known agent work', () => {
  const duplicate = threads[0];
  const matches = search({ kind: 'projects' }, 'older', {
    threads: [duplicate, duplicate],
  });

  assert.deepEqual(
    matches.map((entry) => entry.thread?.sessionId),
    ['old'],
  );
});

void test('worktree step offers main checkout, matching branches, and creation', () => {
  const step: PaletteStep = { kind: 'worktrees', repository: '/work/alpha' };
  assert.deepEqual(
    search(step).map((entry) => entry.kind),
    ['worktree', 'worktree', 'new-worktree'],
  );
  assert.deepEqual(
    search(step, 'ftr').map((entry) => entry.kind),
    ['worktree'],
  );
  assert.deepEqual(search(step, 'not a branch'), []);
  assert.equal(search(step, 'new')[0]?.kind, 'new-worktree');
});

void test('agent step exposes availability without silently choosing an agent', () => {
  const step: PaletteStep = {
    kind: 'agents',
    repository: '/work/alpha',
    directory: '/work/alpha-feature',
  };
  assert.deepEqual(
    search(step).map((entry) => [entry.agent, !!entry.disabled]),
    [
      ['opencode', false],
      ['claude', false],
      ['codex', true],
    ],
  );
  assert.equal(search(step, 'codex')[0]?.detail, 'Not installed');
});

void test('session step offers new first, then only matching worktree sessions', () => {
  const step: PaletteStep = {
    kind: 'sessions',
    repository: '/work/alpha',
    directory: '/work/alpha-feature',
    agent: 'claude',
  };
  assert.deepEqual(
    search(step).map((entry) => entry.thread?.sessionId ?? entry.kind),
    ['new-session', 'new', 'old'],
  );
  assert.equal(search(step, 'newest')[0]?.thread?.sessionId, 'new');
});

void test('OpenCode session step filters parent and other worktree sessions', () => {
  const step: PaletteStep = {
    kind: 'sessions',
    repository: '/work/alpha',
    directory: '/work/alpha-feature',
    agent: 'opencode',
  };
  const matches = search(step, '', {
    openCodeSessions: [
      session('right', '/work/alpha-feature'),
      session('other', '/work/bravo'),
      session('child', '/work/alpha-feature', 'right'),
    ],
  });
  assert.deepEqual(
    matches.map((entry) => entry.sessionId ?? entry.kind),
    ['new-session', 'right'],
  );
});

void test('saved commands remain searchable at the root only', () => {
  const commands = loadSavedCommands(
    JSON.stringify([
      { id: 'global', name: 'Run tests', command: 'npm test', project: null },
      { id: 'alpha', name: 'Build alpha', command: 'npm run build', project: '/work/alpha' },
      { id: 'bravo', name: 'Build bravo', command: 'make build', project: '/work/bravo' },
    ]),
  );
  assert.equal(search({ kind: 'projects' }, 'build', { commands })[0]?.command?.id, 'alpha');
  assert.equal(search({ kind: 'projects' }, 'tests', { commands })[0]?.command?.id, 'global');
  assert.equal(search({ kind: 'projects' }, 'npm test', { commands })[0]?.command?.id, 'global');
  const crowdedCatalog: ProjectCatalog = {
    repositories: Array.from({ length: 55 }, (_, index) => `/work/build-${index}`),
    groups: [],
    worktrees: {},
  };
  const globalBuild = loadSavedCommands(
    JSON.stringify([{ id: 'build', name: 'Build', command: 'npm run build', project: null }]),
  );
  assert.ok(
    search({ kind: 'projects' }, 'build', {
      catalog: crowdedCatalog,
      commands: globalBuild,
    }).some((entry) => entry.command?.id === 'build'),
  );
  assert.ok(
    !search({ kind: 'worktrees', repository: '/work/alpha' }, 'build', { commands }).some(
      (entry) => entry.kind === 'command',
    ),
  );
});

void test('root search offers app actions with their shortcut hints', () => {
  const actions = paletteActions({ dark: false, overview: false, hasDirectory: true });
  const entries = search({ kind: 'projects' }, '', { actions }).filter(
    (entry) => entry.kind === 'action',
  );

  assert.deepEqual(
    entries.map((entry) => entry.actionId),
    actions.map((action) => action.id),
  );
  assert.equal(entries.find((entry) => entry.actionId === 'chat.side')?.shortcut, 'chat.side');
  assert.equal(
    entries.find((entry) => entry.actionId === 'changes.toggle')?.shortcut,
    'details.toggle',
  );
  assert.equal(entries.find((entry) => entry.actionId === 'inbox.open')?.shortcut, undefined);
  for (const entry of entries)
    if (entry.shortcut) assert.equal(entry.label, shortcutFor(entry.shortcut).label);
});

void test('action entries are searchable by label and detail, and outrank projects', () => {
  const actions = paletteActions({ dark: false, overview: false, hasDirectory: true });

  assert.equal(search({ kind: 'projects' }, 'split pane', { actions })[0]?.actionId, 'pane.split');
  assert.equal(
    search({ kind: 'projects' }, 'next attention', { actions })[0]?.actionId,
    'attention.next',
  );
  assert.equal(search({ kind: 'projects' }, 'inbox', { actions })[0]?.actionId, 'inbox.open');
  assert.equal(
    search({ kind: 'projects' }, 'shortcuts', { actions })[0]?.actionId,
    'shortcuts.help',
  );
  assert.equal(search({ kind: 'projects' }, 'zzzz', { actions }).length, 0);
});

const byId = (context: Parameters<typeof paletteActions>[0]) =>
  new Map(paletteActions(context).map((action) => [action.id, action]));

void test('action entries follow the theme, overview and project state', () => {
  assert.equal(
    byId({ dark: false, overview: false, hasDirectory: true }).get('theme.toggle')?.label,
    'Switch to dark theme',
  );
  assert.equal(
    byId({ dark: true, overview: true, hasDirectory: true }).get('theme.toggle')?.label,
    'Switch to light theme',
  );
  assert.equal(
    byId({ dark: true, overview: true, hasDirectory: true }).get('overview.toggle')?.label,
    'Back to workspace',
  );
  const noProject = byId({ dark: false, overview: false, hasDirectory: false });
  assert.equal(noProject.get('pane.split')?.disabled, true);
  assert.equal(noProject.get('settings.open')?.disabled, false);
  const entries = search({ kind: 'projects' }, 'split', { actions: [...noProject.values()] });
  assert.equal(entries.find((entry) => entry.actionId === 'pane.split')?.disabled, true);
});

void test('worktree, agent and session steps show no app actions', () => {
  const actions = paletteActions({ dark: false, overview: false, hasDirectory: true });
  for (const step of [
    { kind: 'worktrees', repository: '/work/alpha' },
    { kind: 'agents', repository: '/work/alpha', directory: '/work/alpha' },
    {
      kind: 'sessions',
      repository: '/work/alpha',
      directory: '/work/alpha-feature',
      agent: 'claude',
    },
  ] as PaletteStep[])
    assert.equal(search(step, '', { actions }).filter((e) => e.kind === 'action').length, 0);
});

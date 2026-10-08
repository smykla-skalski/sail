export type ProjectGroup = {
  id: string;
  name: string;
  collapsed: boolean;
  repositories: string[];
};

export type ProjectCatalog = {
  repositories: string[];
  groups: ProjectGroup[];
  worktrees: Record<string, ProjectWorktree[]>;
  collapsedRepositories?: string[];
};

export type PullRequestLink = { number: number; url: string };
export type ProjectWorktree = {
  path: string;
  branch: string;
  base?: string;
  pullRequest?: PullRequestLink;
  statusComment?: string;
  setupStatus?: 'pending' | 'ready' | 'failed';
};

export type WorktreeCreation = {
  id: string;
  repository: string;
  name: string;
  stage: string;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedCollapsedRepositories(repositories: string[], paths: string[]) {
  const collapsedRepositories = [...new Set(paths.filter((path) => repositories.includes(path)))];
  return collapsedRepositories.length ? { collapsedRepositories } : {};
}

export function loadProjectCatalog(raw: string | null, current: string): ProjectCatalog {
  let saved: unknown;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  const value = isRecord(saved) ? saved : {};
  const repositories = Array.isArray(value.repositories)
    ? [
        ...new Set(
          value.repositories.filter((path): path is string => typeof path === 'string' && !!path),
        ),
      ]
    : [];
  const worktrees: Record<string, ProjectWorktree[]> = {};
  if (isRecord(value.worktrees)) {
    for (const [parent, entries] of Object.entries(value.worktrees)) {
      if (!Array.isArray(entries)) continue;
      worktrees[parent] = entries.flatMap((entry): ProjectWorktree[] => {
        if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.branch !== 'string')
          return [];
        const worktree: ProjectWorktree = { path: entry.path, branch: entry.branch };
        if (typeof entry.base === 'string') worktree.base = entry.base;
        if (
          entry.setupStatus === 'pending' ||
          entry.setupStatus === 'ready' ||
          entry.setupStatus === 'failed'
        )
          worktree.setupStatus = entry.setupStatus;
        if (typeof entry.statusComment === 'string')
          worktree.statusComment = entry.statusComment.slice(0, 140);
        if (isRecord(entry.pullRequest)) {
          const { number, url } = entry.pullRequest;
          if (typeof number === 'number' && validPullRequestLink(number, url))
            worktree.pullRequest = { number, url };
        }
        return [worktree];
      });
    }
  }
  if (
    current &&
    !repositories.includes(current) &&
    !Object.values(worktrees).some((entries) => entries.some((entry) => entry.path === current))
  )
    repositories.unshift(current);
  const collapsedRepositories = Array.isArray(value.collapsedRepositories)
    ? value.collapsedRepositories.filter((path): path is string => typeof path === 'string')
    : [];
  const assigned = new Set<string>();
  const groups: ProjectGroup[] = [];
  for (const item of Array.isArray(value.groups) ? value.groups : []) {
    if (!isRecord(item)) continue;
    const group = item;
    if (typeof group.id !== 'string' || typeof group.name !== 'string' || !group.name.trim())
      continue;
    const paths = Array.isArray(group.repositories) ? group.repositories : [];
    groups.push({
      id: group.id,
      name: group.name.trim(),
      collapsed: group.collapsed === true,
      repositories: paths.filter((path): path is string => {
        if (typeof path !== 'string' || !repositories.includes(path) || assigned.has(path))
          return false;
        assigned.add(path);
        return true;
      }),
    });
  }
  return {
    repositories,
    groups,
    worktrees,
    ...normalizedCollapsedRepositories(repositories, collapsedRepositories),
  };
}

function validPullRequestLink(number: unknown, value: unknown): value is string {
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return false;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) &&
      Number(url.pathname.split('/').at(-1)) === number
    );
  } catch {
    return false;
  }
}

export function ungroupedRepositories(catalog: ProjectCatalog): string[] {
  const assigned = new Set(catalog.groups.flatMap((group) => group.repositories));
  return catalog.repositories.filter((path) => !assigned.has(path));
}

export function assignRepository(
  catalog: ProjectCatalog,
  path: string,
  groupID: string | null,
): ProjectCatalog {
  return {
    ...catalog,
    repositories: catalog.repositories.includes(path)
      ? catalog.repositories
      : [...catalog.repositories, path],
    groups: catalog.groups.map((group) => ({
      ...group,
      repositories: [
        ...group.repositories.filter((repository) => repository !== path),
        ...(group.id === groupID ? [path] : []),
      ],
    })),
  };
}

export function removeRepository(catalog: ProjectCatalog, path: string): ProjectCatalog {
  const { collapsedRepositories, ...remaining } = catalog;
  const repositories = catalog.repositories.filter((repository) => repository !== path);
  return {
    ...remaining,
    repositories,
    groups: catalog.groups.map((group) => ({
      ...group,
      repositories: group.repositories.filter((repository) => repository !== path),
    })),
    worktrees: Object.fromEntries(
      Object.entries(catalog.worktrees).filter(([parent]) => parent !== path),
    ),
    ...normalizedCollapsedRepositories(
      repositories,
      collapsedRepositories?.filter((repository) => repository !== path) ?? [],
    ),
  };
}

export function addWorktree(
  catalog: ProjectCatalog,
  repository: string,
  worktree: ProjectWorktree & { setup?: string },
): ProjectCatalog {
  const entries = catalog.worktrees[repository] ?? [];
  if (entries.some((entry) => entry.path === worktree.path)) return catalog;
  return {
    ...catalog,
    worktrees: {
      ...catalog.worktrees,
      [repository]: [
        ...entries,
        { ...worktree, setupStatus: worktree.setup ? 'pending' : 'ready' },
      ],
    },
  };
}

export function setWorktreeSetupStatus(
  catalog: ProjectCatalog,
  repository: string,
  path: string,
  status: 'ready' | 'failed',
): ProjectCatalog {
  return {
    ...catalog,
    worktrees: {
      ...catalog.worktrees,
      [repository]: (catalog.worktrees[repository] ?? []).map((worktree) =>
        worktree.path === path ? Object.assign({}, worktree, { setupStatus: status }) : worktree,
      ),
    },
  };
}

export function setWorktreeStatus(
  catalog: ProjectCatalog,
  repository: string,
  path: string,
  comment: string,
): ProjectCatalog {
  const worktrees: ProjectWorktree[] = [];
  for (const worktree of catalog.worktrees[repository] ?? []) {
    worktrees.push(
      worktree.path === path
        ? { ...worktree, statusComment: comment.trim().slice(0, 140) || undefined }
        : worktree,
    );
  }
  return {
    ...catalog,
    worktrees: {
      ...catalog.worktrees,
      [repository]: worktrees,
    },
  };
}

export function removeWorktree(
  catalog: ProjectCatalog,
  repository: string,
  path: string,
): ProjectCatalog {
  return {
    ...catalog,
    worktrees: {
      ...catalog.worktrees,
      [repository]: (catalog.worktrees[repository] ?? []).filter((item) => item.path !== path),
    },
  };
}

export function worktreeAt(
  catalog: ProjectCatalog,
  directory: string,
): { repository: string; worktree: ProjectWorktree } | null {
  for (const [repository, worktrees] of Object.entries(catalog.worktrees)) {
    const worktree = worktrees.find((item) => item.path === directory);
    if (worktree) return { repository, worktree };
  }
  return null;
}

export function owningRepository(catalog: ProjectCatalog, path: string): string | null {
  if (catalog.repositories.includes(path)) return path;
  return worktreeAt(catalog, path)?.repository ?? null;
}

export function setWorktreePullRequest(
  catalog: ProjectCatalog,
  repository: string,
  path: string,
  pullRequest: PullRequestLink,
): ProjectCatalog {
  return {
    ...catalog,
    worktrees: {
      ...catalog.worktrees,
      [repository]: (catalog.worktrees[repository] ?? []).map((worktree) =>
        worktree.path === path ? Object.assign({}, worktree, { pullRequest }) : worktree,
      ),
    },
  };
}

export function replaceRepositoryPath(
  catalog: ProjectCatalog,
  oldPath: string,
  canonicalPath: string,
): ProjectCatalog {
  if (oldPath === canonicalPath || !catalog.repositories.includes(oldPath)) return catalog;
  const repositories = [
    ...new Set(catalog.repositories.map((path) => (path === oldPath ? canonicalPath : path))),
  ];
  const { collapsedRepositories, ...remaining } = catalog;
  const assigned = new Set<string>();
  const groups = catalog.groups.map((group) => ({
    ...group,
    repositories: group.repositories
      .map((path) => (path === oldPath ? canonicalPath : path))
      .filter((path) => {
        if (assigned.has(path)) return false;
        assigned.add(path);
        return true;
      }),
  }));
  const worktrees = Object.fromEntries(
    Object.entries(catalog.worktrees).map(([parent, entries]) => [
      parent === oldPath ? canonicalPath : parent,
      entries.map((entry) => ({
        ...entry,
        path: entry.path === oldPath ? canonicalPath : entry.path,
      })),
    ]),
  );
  return {
    ...remaining,
    repositories,
    groups,
    worktrees,
    ...normalizedCollapsedRepositories(
      repositories,
      collapsedRepositories?.map((path) => (path === oldPath ? canonicalPath : path)) ?? [],
    ),
  };
}

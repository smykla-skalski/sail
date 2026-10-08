import type { ShipIssue, ShipRun } from './issue-shipping';
import type { NativeSubagent } from './native-subagents.ts';
import { ciStatus, dependencyUrl, shipBlock, shipStatus } from './ship-progress.ts';

export type DependencyMapNode = {
  id: string;
  kind: 'worker' | 'subagent' | 'external' | 'missing';
  label: string;
  owner: string;
  state: string;
  blockingReason: string | null;
  checkState: string;
  issue?: ShipIssue;
  url?: string;
  depth: number;
  errors: string[];
};

export type DependencyMapEdge = { from: string; to: string; error: boolean };

export type WorkerDependencyMap = {
  nodes: DependencyMapNode[];
  edges: DependencyMapEdge[];
  errors: string[];
};

function localAliases(run: ShipRun): Map<string, ShipIssue> {
  const aliases = new Map<string, ShipIssue>();
  for (const issue of run.issues) {
    aliases.set(issue.id, issue);
    aliases.set(String(issue.number), issue);
  }
  return aliases;
}

function localReference(reference: string, remote: string): string {
  const match = /^([^/#]+\/[^/#]+)#([1-9]\d*)$/.exec(reference);
  return match && match[1].toLowerCase() === remote.toLowerCase() ? match[2] : reference;
}

function externalId(reference: string): string {
  const match = /^([^/#]+\/[^/#]+)#([1-9]\d*)$/.exec(reference);
  return `external:${match ? `${match[1].toLowerCase()}#${match[2]}` : reference}`;
}

function dependencyOwner(reference: string, remote: string): string {
  const match = /^([^/#]+\/[^/#]+)#[1-9]\d*$/.exec(reference);
  return match?.[1] ?? remote;
}

export function hasWorkerDependencies(run: ShipRun, native: NativeSubagent[] = []): boolean {
  const threads = new Set(run.issues.flatMap((issue) => (issue.threadId ? [issue.threadId] : [])));
  return (
    run.issues.some((issue) => issue.dependsOn.length > 0) ||
    native.some((child) => threads.has(`acp:${child.agent}:${child.rootSessionId}`))
  );
}

export function buildWorkerDependencyMap(
  run: ShipRun,
  native: NativeSubagent[] = [],
): WorkerDependencyMap {
  const issueThreads = new Set(
    run.issues.flatMap((issue) => (issue.threadId ? [issue.threadId] : [])),
  );
  const relevantNative = native.filter((child) =>
    issueThreads.has(`acp:${child.agent}:${child.rootSessionId}`),
  );
  if (!hasWorkerDependencies(run, relevantNative)) return { nodes: [], edges: [], errors: [] };
  const aliases = localAliases(run);
  const edges: DependencyMapEdge[] = [];
  const errors: string[] = [];
  const nodeErrors = new Map<string, string[]>();
  const external = new Map<string, DependencyMapNode>();
  const dependencies = new Map(run.issues.map((issue) => [issue.id, [] as ShipIssue[]]));
  const externalDependencies = new Set<string>();

  for (const issue of run.issues) {
    for (const reference of issue.dependsOn) {
      const target = aliases.get(localReference(reference, run.remote));
      if (target) {
        dependencies.get(issue.id)!.push(target);
        edges.push({ from: target.id, to: issue.id, error: false });
        continue;
      }
      externalDependencies.add(issue.id);
      const url = dependencyUrl(run.remote, reference);
      const id = externalId(reference);
      if (!external.has(id)) {
        const unavailable = run.dependencyErrors?.[reference];
        const missing = !url;
        const problem = unavailable ?? (missing ? `Missing dependency target: ${reference}` : null);
        external.set(id, {
          id,
          kind: missing ? 'missing' : 'external',
          label: reference,
          owner: url ? dependencyOwner(reference, run.remote) : 'Unknown repository',
          state: problem ? 'Unavailable' : run.externalClosed[reference] ? 'Closed' : 'Waiting',
          blockingReason: problem,
          checkState: 'Unavailable',
          url,
          depth: 0,
          errors: problem ? [problem] : [],
        });
        if (problem) errors.push(problem);
      }
      edges.push({ from: id, to: issue.id, error: external.get(id)!.errors.length > 0 });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleNodes = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start)) cycleNodes.add(member);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency.id);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const issue of run.issues) visit(issue.id);
  if (cycleNodes.size) {
    const labels = [...cycleNodes].map(
      (id) => `#${run.issues.find((issue) => issue.id === id)?.number ?? id}`,
    );
    const message = `Dependency cycle: ${labels.join(' → ')}`;
    errors.push(message);
    for (const id of cycleNodes) nodeErrors.set(id, [message]);
    for (const edge of edges)
      if (cycleNodes.has(edge.from) && cycleNodes.has(edge.to)) edge.error = true;
  }

  const depths = new Map<string, number>();
  const depth = (issue: ShipIssue, trail = new Set<string>()): number => {
    const saved = depths.get(issue.id);
    if (saved !== undefined) return saved;
    if (trail.has(issue.id)) return 0;
    const nextTrail = new Set(trail).add(issue.id);
    const value = Math.max(
      externalDependencies.has(issue.id) ? 1 : 0,
      ...(dependencies.get(issue.id) ?? []).map((item) => depth(item, nextTrail) + 1),
    );
    depths.set(issue.id, value);
    return value;
  };

  const nodes: DependencyMapNode[] = run.issues.map((issue) => ({
    id: issue.id,
    kind: 'worker',
    label: `#${issue.number} ${issue.title}`,
    owner: `${run.provider} / ${issue.workerModel ?? issue.models?.join(', ') ?? 'Unassigned'}`,
    state: shipStatus(run, issue),
    blockingReason:
      shipBlock(issue) ??
      issue.error ??
      (shipStatus(run, issue) === 'Blocked' ? 'Blocked by a failed dependency.' : null),
    checkState: ciStatus(issue.checks),
    issue,
    url: issue.url,
    depth: depth(issue),
    errors: nodeErrors.get(issue.id) ?? [],
  }));
  const nativeByThread = new Map(
    relevantNative.map((child) => [`acp:${child.agent}:${child.sessionId}`, child]),
  );
  const issueByThread = new Map(
    run.issues.flatMap((issue) => (issue.threadId ? [[issue.threadId, issue] as const] : [])),
  );
  const nativeDepth = (child: NativeSubagent, trail = new Set<string>()): number => {
    if (trail.has(child.id)) return 0;
    const parentThread = `acp:${child.agent}:${child.parentSessionId}`;
    const parent = nativeByThread.get(parentThread);
    if (parent) return nativeDepth(parent, new Set(trail).add(child.id)) + 1;
    const issue = issueByThread.get(parentThread);
    return issue ? (depths.get(issue.id) ?? 0) + 1 : 0;
  };
  for (const child of relevantNative) {
    const id = `native:${child.agent}:${child.sessionId}`;
    const parentThread = `acp:${child.agent}:${child.parentSessionId}`;
    const parent = nativeByThread.get(parentThread);
    const issue = issueByThread.get(parentThread);
    if (parent || issue)
      edges.push({
        from: parent ? `native:${parent.agent}:${parent.sessionId}` : issue!.id,
        to: id,
        error: false,
      });
    nodes.push({
      id,
      kind: 'subagent',
      label: child.task,
      owner: `${child.agent} / ${child.name}`,
      state: child.outcome === 'unknown' ? 'Unknown' : child.outcome,
      blockingReason: child.error ?? null,
      checkState: 'Unavailable',
      depth: nativeDepth(child),
      errors: child.error ? [child.error] : [],
    });
  }
  nodes.push(...external.values());
  return {
    nodes: nodes.toSorted(
      (left, right) => left.depth - right.depth || left.label.localeCompare(right.label),
    ),
    edges,
    errors: [...new Set(errors)],
  };
}

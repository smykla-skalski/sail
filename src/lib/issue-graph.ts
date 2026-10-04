import { z } from 'zod';
import type { Plan } from './plan';

export interface IssueDraft {
  id: string;
  number?: number;
  repository?: string;
  title: string;
  body: string;
  dependsOn: string[];
}

export interface IssueGraphDraft {
  repository?: string;
  source: string;
  replaceExisting?: boolean;
  loadedFromUmbrella?: boolean;
  umbrellaNumber?: number;
  title: string;
  body: string;
  issues: IssueDraft[];
}

export interface PublishedIssue extends IssueDraft {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED';
}

export interface PublishedGraph {
  umbrella?: PublishedIssue;
  issues: PublishedIssue[];
}

const IssueGraphDraftSchema = z.object({
  repository: z.string().optional(),
  source: z.string(),
  replaceExisting: z.boolean().optional(),
  loadedFromUmbrella: z.boolean().optional(),
  umbrellaNumber: z.number().optional(),
  title: z.string(),
  body: z.string(),
  issues: z.array(
    z.object({
      id: z.string(),
      number: z.number().optional(),
      repository: z.string().optional(),
      title: z.string(),
      body: z.string(),
      dependsOn: z.array(z.string()),
    }),
  ),
});

export function positiveIssueNumber(value: string | number): number | undefined {
  const text = String(value).trim();
  if (!text) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function isIssueGraphDraft(value: unknown): value is IssueGraphDraft {
  return IssueGraphDraftSchema.safeParse(value).success;
}

export function splitPlan(plan: Plan): IssueGraphDraft {
  return {
    source: plan.sessionID,
    title: `☂️ ${plan.title}`,
    body: plan.summary,
    issues: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      body: step.detail,
      dependsOn: step.dependsOn ?? [],
    })),
  };
}

export function rebaseIssueGraph(previous: IssueGraphDraft | null, plan: Plan): IssueGraphDraft {
  const latest = splitPlan(plan);
  if (!previous) return latest;
  const prior = new Map(previous.issues.map((issue) => [issue.id, issue]));
  const matches = latest.issues.filter((issue) => prior.has(issue.id));
  if (!matches.length && previous.loadedFromUmbrella)
    return { ...previous, source: plan.sessionID };
  return {
    ...latest,
    repository: previous.repository,
    umbrellaNumber: latest.issues.length === 1 ? undefined : previous.umbrellaNumber,
    replaceExisting: previous.replaceExisting,
    issues: latest.issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      body: issue.body,
      dependsOn: issue.dependsOn,
      number: prior.get(issue.id)?.number,
      repository: prior.get(issue.id)?.repository,
    })),
  };
}

function aliasKey(reference: string, target?: string): string {
  const match = /^([^/#]+\/[^/#]+)#([1-9]\d*)$/.exec(reference);
  if (!match) return reference;
  return target && match[1].toLowerCase() === target.toLowerCase()
    ? match[2]
    : `${match[1].toLowerCase()}#${match[2]}`;
}

export function graphErrors(graph: IssueGraphDraft): string[] {
  const errors: string[] = [];
  if (!graph.source.trim()) errors.push('Issue graph has no source.');
  if (!graph.issues.length) errors.push('Add at least one issue.');
  if (graph.issues.length > 1 && !graph.umbrellaNumber && !graph.title.trim())
    errors.push('Enter an umbrella title.');
  if (
    graph.umbrellaNumber !== undefined &&
    (!Number.isSafeInteger(graph.umbrellaNumber) || graph.umbrellaNumber <= 0)
  )
    errors.push('Enter a valid umbrella number.');
  const ids = new Set<string>();
  const numbers = new Set<string>();
  const aliases = new Map(
    graph.issues.map((issue) => [aliasKey(issue.id, graph.repository), issue.id]),
  );
  for (const issue of graph.issues) aliases.set(issue.id, issue.id);
  for (const issue of graph.issues) {
    if (!issue.number) continue;
    const repo = issue.repository ?? graph.repository;
    if (repo) aliases.set(aliasKey(`${repo}#${issue.number}`, graph.repository), issue.id);
    if (!issue.repository || issue.repository === graph.repository)
      aliases.set(String(issue.number), issue.id);
  }
  for (const issue of graph.issues) {
    if (issue.id === 'umbrella') errors.push('Issue ID umbrella is reserved.');
    if (!issue.id.trim() || ids.has(issue.id))
      errors.push(`Duplicate or empty issue ID: ${issue.id || '(empty)'}.`);
    ids.add(issue.id);
    if (aliases.get(aliasKey(issue.id, graph.repository)) !== issue.id)
      errors.push(`Issue ID ${issue.id} conflicts with an issue reference.`);
    if (!issue.title.trim()) errors.push(`Enter a title for ${issue.id || 'the issue'}.`);
    if (issue.number !== undefined) {
      if (!Number.isSafeInteger(issue.number) || issue.number <= 0)
        errors.push(`Invalid issue number for ${issue.id}.`);
      const local = !issue.repository || issue.repository === graph.repository;
      const key = `${local ? 'local' : issue.repository}#${issue.number}`;
      if (numbers.has(key)) errors.push(`Issue #${issue.number} appears twice.`);
      numbers.add(key);
      if (local && issue.number === graph.umbrellaNumber)
        errors.push('An umbrella cannot be its own child.');
    }
    const canonical = issue.dependsOn.map((dependency) => {
      const key = aliasKey(dependency, graph.repository);
      return aliases.get(key) ?? key;
    });
    if (new Set(canonical).size !== canonical.length)
      errors.push(`${issue.id} repeats a dependency.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.issues.map((issue) => [issue.id, issue]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle includes ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const local = aliases.get(aliasKey(dependency, graph.repository));
      if (local) visit(local);
      else if (!/^(?:[1-9]\d*|[^/#]+\/[^/#]+#[1-9]\d*)$/.test(dependency))
        errors.push(`${id} depends on missing issue ${dependency}.`);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const issue of graph.issues) visit(issue.id);
  return [...new Set(errors)];
}

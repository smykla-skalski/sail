import { z } from 'zod';
import type { Plan } from './plan';

export interface IssueDraft {
  id: string;
  number?: number;
  title: string;
  body: string;
  dependsOn: string[];
}

export interface IssueGraphDraft {
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
      title: z.string(),
      body: z.string(),
      dependsOn: z.array(z.string()),
    }),
  ),
});

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
    umbrellaNumber: latest.issues.length === 1 ? undefined : previous.umbrellaNumber,
    replaceExisting: previous.replaceExisting,
    issues: latest.issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      body: issue.body,
      dependsOn: issue.dependsOn,
      number: prior.get(issue.id)?.number,
    })),
  };
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
  const numbers = new Set<number>();
  for (const issue of graph.issues) {
    if (!issue.id.trim() || ids.has(issue.id))
      errors.push(`Duplicate or empty issue ID: ${issue.id || '(empty)'}.`);
    ids.add(issue.id);
    if (!issue.title.trim()) errors.push(`Enter a title for ${issue.id || 'the issue'}.`);
    if (issue.number !== undefined) {
      if (!Number.isSafeInteger(issue.number) || issue.number <= 0)
        errors.push(`Invalid issue number for ${issue.id}.`);
      if (numbers.has(issue.number)) errors.push(`Issue #${issue.number} appears twice.`);
      numbers.add(issue.number);
      if (issue.number === graph.umbrellaNumber)
        errors.push('An umbrella cannot be its own child.');
    }
    const aliases = new Map(
      graph.issues.filter((item) => item.number).map((item) => [String(item.number), item.id]),
    );
    const canonical = issue.dependsOn.map((dependency) => aliases.get(dependency) ?? dependency);
    if (new Set(canonical).size !== canonical.length)
      errors.push(`${issue.id} repeats a dependency.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.issues.map((issue) => [issue.id, issue]));
  const byNumber = new Map(
    graph.issues.filter((issue) => issue.number).map((issue) => [String(issue.number), issue.id]),
  );
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle includes ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const local = byId.has(dependency) ? dependency : byNumber.get(dependency);
      if (local) visit(local);
      else if (!/^[1-9]\d*$/.test(dependency))
        errors.push(`${id} depends on missing issue ${dependency}.`);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const issue of graph.issues) visit(issue.id);
  return [...new Set(errors)];
}

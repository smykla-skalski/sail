import type { Plan } from './plan';

export interface IssueDraft {
  id: string;
  number?: number;
  title: string;
  body: string;
  dependsOn: string[];
}

export interface IssueGraphDraft {
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

export function splitPlan(plan: Plan): IssueGraphDraft {
  return {
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

export function graphErrors(graph: IssueGraphDraft): string[] {
  const errors: string[] = [];
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
    if (new Set(issue.dependsOn).size !== issue.dependsOn.length)
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
      if (!byId.has(dependency)) errors.push(`${id} depends on missing issue ${dependency}.`);
      else visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const issue of graph.issues) visit(issue.id);
  return [...new Set(errors)];
}

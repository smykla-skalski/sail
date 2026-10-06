import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShipIssue, ShipRun } from '../src/lib/issue-shipping.ts';
import {
  buildWorkerDependencyMap,
  hasWorkerDependencies,
} from '../src/lib/worker-dependency-map.ts';

function issue(number: number, dependsOn: string[] = []): ShipIssue {
  return {
    id: `owner/repo#${number}`,
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    title: `Issue ${number}`,
    dependsOn,
    state: 'pending',
    branch: `issue-${number}`,
    path: null,
    receiptId: null,
    threadId: null,
    pullRequest: null,
    error: null,
  };
}

function run(issues: ShipIssue[]): ShipRun {
  return {
    id: 'run',
    source: 'source',
    repository: '/repo',
    remote: 'owner/repo',
    provider: 'codex',
    limit: 2,
    approvedAt: 1,
    externalClosed: {},
    dependencyErrors: {},
    issues,
  };
}

await test('dependency map stays absent for independent work', () => {
  const value = run([issue(1), issue(2)]);
  assert.equal(hasWorkerDependencies(value), false);
  assert.deepEqual(buildWorkerDependencyMap(value), { nodes: [], edges: [], errors: [] });
});

await test('dependency map orders blockers and exposes authoritative worker state', () => {
  const blocker = { ...issue(1), state: 'merged' as const, workerModel: 'gpt-5.6-sol' };
  const dependent = {
    ...issue(2, ['owner/repo#1']),
    state: 'working' as const,
    threadId: 'opencode:thread',
    path: '/repo/worktree',
    checks: [{ name: 'Frontend', state: 'SUCCESS', url: 'https://checks/1' }],
  };
  const graph = buildWorkerDependencyMap(run([dependent, blocker]));

  assert.deepEqual(graph.edges, [{ from: blocker.id, to: dependent.id, error: false }]);
  assert.equal(graph.nodes.find((node) => node.id === blocker.id)?.depth, 0);
  assert.equal(graph.nodes.find((node) => node.id === dependent.id)?.depth, 1);
  assert.equal(graph.nodes.find((node) => node.id === dependent.id)?.state, 'Running');
  assert.equal(graph.nodes.find((node) => node.id === dependent.id)?.checkState, 'Passed');
});

await test('dependency map keeps cycles and missing or unavailable targets visible', () => {
  const value = run([issue(1, ['2']), issue(2, ['1']), issue(3, ['not-an-issue', 'other/repo#9'])]);
  value.dependencyErrors = { 'other/repo#9': 'Repository unavailable' };
  const graph = buildWorkerDependencyMap(value);

  assert.equal(
    graph.errors.some((error) => error.startsWith('Dependency cycle:')),
    true,
  );
  assert.equal(graph.errors.includes('Missing dependency target: not-an-issue'), true);
  assert.equal(graph.errors.includes('Repository unavailable'), true);
  assert.equal(graph.nodes.find((node) => node.label === 'not-an-issue')?.kind, 'missing');
  assert.equal(graph.nodes.find((node) => node.label === 'other/repo#9')?.depth, 0);
  assert.equal(graph.nodes.find((node) => node.id === 'owner/repo#3')?.depth, 1);
});

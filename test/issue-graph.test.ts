import assert from 'node:assert/strict';
import test from 'node:test';
import { graphErrors, positiveIssueNumber } from '../src/lib/issue-graph.ts';

const graph = {
  source: 'session-1',
  title: 'Umbrella',
  body: 'Scope',
  issues: [
    { id: 'a', title: 'First', body: 'One', dependsOn: [] as string[], number: 3 },
    { id: 'b', title: 'Second', body: 'Two', dependsOn: ['a'] as string[], number: 4 },
  ],
};

await test('validates graph identity and dependencies', () => {
  assert.deepEqual(graphErrors(graph), []);
  assert.match(
    graphErrors({
      ...graph,
      issues: [{ ...graph.issues[0], dependsOn: ['b'] }, graph.issues[1]],
    }).join(' '),
    /cycle/,
  );
  assert.match(
    graphErrors({ ...graph, issues: [{ ...graph.issues[0], number: 4 }, graph.issues[1]] }).join(
      ' ',
    ),
    /appears twice/,
  );
  assert.match(
    graphErrors({ ...graph, issues: [{ ...graph.issues[0], dependsOn: ['missing'] }] }).join(' '),
    /missing issue/,
  );
  assert.match(graphErrors({ ...graph, umbrellaNumber: 3 }).join(' '), /own child/);
});

await test('single issue needs no umbrella', () => {
  assert.deepEqual(graphErrors({ ...graph, title: '', issues: [graph.issues[0]] }), []);
});

await test('existing blockers outside the umbrella remain valid', () => {
  assert.deepEqual(
    graphErrors({ ...graph, issues: [{ ...graph.issues[0], dependsOn: ['82'] }] }),
    [],
  );
  assert.match(
    graphErrors({ ...graph, issues: [{ ...graph.issues[0], dependsOn: ['external'] }] }).join(' '),
    /missing issue/,
  );
});

await test('numeric aliases cannot hide a cycle', () => {
  const cyclic = {
    ...graph,
    issues: [
      { ...graph.issues[0], dependsOn: ['b'] },
      { ...graph.issues[1], dependsOn: ['3'] },
    ],
  };
  assert.match(graphErrors(cyclic).join(' '), /cycle/);
});

await test('plan revision refreshes scope while retaining issue numbers', async () => {
  const { rebaseIssueGraph } = await import('../src/lib/issue-graph.ts');
  const plan = {
    title: 'Revised plan',
    summary: 'Revised summary',
    steps: [
      {
        id: 'a',
        title: 'Revised first',
        detail: 'Revised scope',
        files: [],
        risk: 'low' as const,
        status: 'proposed' as const,
        origin: 'plan' as const,
        touched: [],
      },
    ],
    sessionID: 'session-1',
    version: 2,
    state: 'review' as const,
    reviewReason: 'plan' as const,
    outside: [],
    createdAt: 1,
  };
  const updated = rebaseIssueGraph({ ...graph, umbrellaNumber: 9, replaceExisting: true }, plan);
  assert.equal(updated.issues[0].number, 3);
  assert.equal(updated.issues[0].title, 'Revised first');
  assert.equal(updated.umbrellaNumber, undefined);
  assert.equal(updated.replaceExisting, true);
});

await test('issue ID and number are the same blocker', () => {
  const duplicate = {
    ...graph,
    issues: [graph.issues[0], { ...graph.issues[1], dependsOn: ['a', '3'] }],
  };
  assert.match(graphErrors(duplicate).join(' '), /repeats a dependency/);
});

await test('revision to one issue releases an authored umbrella', async () => {
  const { rebaseIssueGraph } = await import('../src/lib/issue-graph.ts');
  const plan = {
    title: 'One issue',
    summary: 'Scope',
    steps: [
      {
        id: 'a',
        title: 'First',
        detail: 'Scope',
        files: [],
        risk: 'low' as const,
        status: 'proposed' as const,
        origin: 'plan' as const,
        touched: [],
      },
    ],
    sessionID: 'session-1',
    version: 3,
    state: 'review' as const,
    reviewReason: 'plan' as const,
    outside: [],
    createdAt: 1,
  };
  const updated = rebaseIssueGraph({ ...graph, umbrellaNumber: 9 }, plan);
  assert.equal(updated.umbrellaNumber, undefined);
  assert.equal(updated.issues[0].number, 3);
});

await test('issue number input accepts Svelte numeric binding values', () => {
  assert.equal(positiveIssueNumber(207), 207);
  assert.equal(positiveIssueNumber('207'), 207);
  assert.equal(positiveIssueNumber(''), undefined);
  assert.equal(positiveIssueNumber(-1), 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { graphErrors } from '../src/lib/issue-graph.ts';

const graph = {
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

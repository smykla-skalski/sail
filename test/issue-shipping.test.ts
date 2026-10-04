import assert from 'node:assert/strict';
import test from 'node:test';
import { createShipRun, readyShipIssues, shipIssueStatus } from '../src/lib/issue-shipping.ts';
import type { PublishedGraph } from '../src/lib/issue-graph.ts';

const graph: PublishedGraph = {
  issues: [
    {
      id: 'first',
      number: 11,
      repository: 'owner/repo',
      title: 'First',
      body: '',
      url: 'https://github.com/owner/repo/issues/11',
      state: 'OPEN',
      dependsOn: [],
    },
    {
      id: 'second',
      number: 12,
      repository: 'owner/repo',
      title: 'Second',
      body: '',
      url: 'https://github.com/owner/repo/issues/12',
      state: 'OPEN',
      dependsOn: [],
    },
    {
      id: 'dependent',
      number: 13,
      repository: 'owner/repo',
      title: 'Dependent',
      body: '',
      url: 'https://github.com/owner/repo/issues/13',
      state: 'OPEN',
      dependsOn: ['first'],
    },
  ],
};

function run(limit = 2) {
  return createShipRun(graph, '/repo', 'owner/repo', 'plan', 'codex', limit, 'run-id-1234', 1);
}

void test('launches ready issues within the limit and waits for merged dependencies', () => {
  const shipping = run();
  assert.deepEqual(
    readyShipIssues(shipping).map((issue) => issue.id),
    ['first', 'second'],
  );
  shipping.issues[0].state = 'working';
  assert.deepEqual(
    readyShipIssues(shipping).map((issue) => issue.id),
    ['second'],
  );
  shipping.issues[0].state = 'awaiting_merge';
  shipping.issues[1].state = 'working';
  assert.deepEqual(readyShipIssues(shipping), []);
  shipping.issues[0].state = 'merged';
  assert.deepEqual(
    readyShipIssues(shipping).map((issue) => issue.id),
    ['dependent'],
  );
});

void test('failed dependency pauses only its dependent', () => {
  const shipping = run(3);
  shipping.issues[0].state = 'failed';
  assert.equal(shipIssueStatus(shipping, shipping.issues[2]), 'paused by failed dependency');
  assert.deepEqual(
    readyShipIssues(shipping).map((issue) => issue.id),
    ['second'],
  );
});

void test('approved snapshot survives serialization and does not expand to new issues', () => {
  const shipping = run();
  graph.issues.push({ ...graph.issues[0], id: 'later', number: 14 });
  assert.equal(JSON.parse(JSON.stringify(shipping)).issues.length, 3);
  graph.issues.pop();
  assert.equal(shipping.issues[0].branch, 'ship-issue-11-run-id-1');
});

void test('external blocker waits until GitHub reports it closed', () => {
  const external = { ...graph, issues: [{ ...graph.issues[0], dependsOn: ['owner/other#7'] }] };
  const shipping = createShipRun(external, '/repo', 'owner/repo', 'plan', 'codex', 2, 'run', 1);
  assert.deepEqual(readyShipIssues(shipping), []);
  shipping.externalClosed['owner/other#7'] = true;
  assert.equal(readyShipIssues(shipping)[0].id, 'first');
});

void test('rejects issues outside the approved repository', () => {
  assert.throws(
    () =>
      createShipRun(
        { ...graph, issues: [{ ...graph.issues[0], repository: 'other/repo' }] },
        '/repo',
        'owner/repo',
        'plan',
        'codex',
        2,
        'run',
        1,
      ),
    /Only open issues/,
  );
});

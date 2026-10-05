import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adoptDirectShipRun,
  createShipRun,
  readyShipIssues,
  resolvedWorkerModel,
  shipIssueStatus,
  shippingWorkerSettled,
  shippingSetupAction,
} from '../src/lib/issue-shipping.ts';
import { shipOwner } from '../src/lib/ship-progress.ts';
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
  assert.deepEqual(readyShipIssues(shipping), []);
  shipping.issues[0].workerSettled = true;
  assert.deepEqual(
    readyShipIssues(shipping).map((issue) => issue.id),
    ['dependent'],
  );
});

void test('merged workers keep their slot until their turn settles', () => {
  const shipping = run(1);
  shipping.issues[0].state = 'merged';
  assert.deepEqual(readyShipIssues(shipping), []);
  shipping.issues[0].workerSettled = true;
  assert.deepEqual(
    readyShipIssues(shipping).map((issue) => issue.id),
    ['second'],
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

void test('failed issue keeps its slot while its worker is unsettled', () => {
  const shipping = run(1);
  shipping.issues[0].state = 'failed';
  shipping.issues[0].receiptId = 'live-worker';
  assert.deepEqual(readyShipIssues(shipping, new Set(['live-worker'])), []);
  assert.deepEqual(
    readyShipIssues(shipping, new Set()).map((issue) => issue.id),
    ['second'],
  );
});

void test('unavailable worker does not prove its turn has stopped', () => {
  assert.equal(shippingWorkerSettled('unavailable'), false);
  assert.equal(shippingWorkerSettled('working'), false);
  assert.equal(shippingWorkerSettled('completed'), true);
  assert.equal(shippingWorkerSettled('failed'), true);
  assert.equal(shippingWorkerSettled('interrupted'), true);
});

void test('interrupted setup cannot rerun a non-idempotent command', () => {
  const issue = run().issues[0];
  assert.equal(shippingSetupAction(issue, 'mkdir build'), 'run');
  issue.setupStarted = true;
  assert.throws(() => shippingSetupAction(issue, 'mkdir build'), /setup was interrupted/);
  issue.setupCompleted = true;
  assert.equal(shippingSetupAction(issue, 'mkdir build'), 'skip');
});

void test('approved snapshot survives serialization and does not expand to new issues', () => {
  const shipping = run();
  graph.issues.push({ ...graph.issues[0], id: 'later', number: 14 });
  assert.equal(JSON.parse(JSON.stringify(shipping)).issues.length, 3);
  graph.issues.pop();
  assert.equal(shipping.issues[0].branch, 'ship-issue-11-run-id-1');
});

void test('adopts an already-running direct Ship It thread', () => {
  const adopted = adoptDirectShipRun([], {
    id: 'direct-run',
    directory: '/repo/worktrees/gateway-fix',
    repository: 'kumahq/kuma',
    number: 18976,
    provider: 'codex',
    threadId: 'acp:codex:running-thread',
    workerModel: 'gpt-5.6-luna',
    approvedAt: 100,
  });

  const issue = adopted[0].issues[0];
  assert.equal(adopted[0].remote, 'kumahq/kuma');
  assert.equal(issue.url, 'https://github.com/kumahq/kuma/issues/18976');
  assert.equal(issue.state, 'working');
  assert.equal(issue.stage, 'implementing');
  assert.equal(issue.workerModel, 'gpt-5.6-luna');
  assert.equal(
    shipOwner(adopted, '/repo/worktrees/gateway-fix', 'acp:codex:running-thread')?.issue,
    issue,
  );
});

void test('fills in the recovered direct worker model without duplicating the run', () => {
  const input = {
    id: 'direct-run',
    directory: '/repo/worktrees/gateway-fix',
    repository: 'kumahq/kuma',
    number: 18976,
    provider: 'codex' as const,
    threadId: 'acp:codex:running-thread',
    approvedAt: 100,
  };
  const adopted = adoptDirectShipRun([], input);

  const recovered = adoptDirectShipRun(adopted, {
    ...input,
    id: 'second-run',
    workerModel: 'gpt-5.6-luna',
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].issues[0].workerModel, 'gpt-5.6-luna');
});

void test('uses one recorded implementation model as the missing worker model', () => {
  const issue = run().issues[0];
  issue.models = ['kong-ai-gateway:zai-org/GLM-5.3'];

  assert.equal(resolvedWorkerModel(issue), 'kong-ai-gateway:zai-org/GLM-5.3');
});

void test('does not guess a worker model when multiple models changed files', () => {
  const issue = run().issues[0];
  issue.models = ['model-a', 'model-b'];

  assert.equal(resolvedWorkerModel(issue), undefined);
});

void test('external blocker waits until GitHub reports it closed', () => {
  const external = { ...graph, issues: [{ ...graph.issues[0], dependsOn: ['owner/other#7'] }] };
  const shipping = createShipRun(external, '/repo', 'owner/repo', 'plan', 'codex', 2, 'run', 1);
  assert.deepEqual(readyShipIssues(shipping), []);
  shipping.externalClosed['owner/other#7'] = true;
  assert.equal(readyShipIssues(shipping)[0].id, 'first');
  shipping.externalClosed['owner/other#7'] = false;
  assert.deepEqual(readyShipIssues(shipping), []);
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

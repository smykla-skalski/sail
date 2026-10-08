import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acpWorkerTerminationConfirmed,
  adoptDirectShipRun,
  adoptRegisteredDirectShipRun,
  assertDirectShipPromptAuthorization,
  beginAuthorizedCoordinationPrompt,
  boundedPromptDispatch,
  claimHeartbeatDue,
  claimMonotonicLeaseDeadline,
  claimRefreshRequiresFence,
  closedPullRequestRequiresFence,
  confirmOpenCodeWorkerStopped,
  createPromptDispatchTracker,
  createShipRun,
  directClaimHandoffChanges,
  directClaimHandoffWaiting,
  directShipPromptAuthorized,
  directShipClaimPrompt,
  dispatchAuthorizedDirectShipPrompt,
  completeAuthorizedPromptRecovery,
  compensatedOpenCodePromptReceiptChanges,
  fenceExpiredShippingLease,
  fencePredecessorWorkerBeforeTakeover,
  fenceResumedShippingClaim,
  fenceShippingTaskThreads,
  nextClaimHeartbeatDeadline,
  monotonicDeadlineExpired,
  openCodePromptRecoveryFailure,
  persistAcquiredClaim,
  persistStartedShippingWorker,
  persistVerifiedHeartbeat,
  predecessorTakeoverChanges,
  promptDispatchAdmissionVisible,
  recoverOpenCodePromptAdmission,
  recoveredClaimLeaseDeadlines,
  recoveredClaimWorkerFenceRequired,
  readyShipIssues,
  registeredShipBranch,
  refreshShippingIssueAfterClaim,
  resumedShippingIssueChanges,
  resolvedWorkerModel,
  settleClosedPullRequest,
  settleDirectClaimHandoff,
  settledLostClaimFence,
  shipIssueStatus,
  shippingClockWasSuspended,
  shippingClaimOwnedByInstance,
  shippingWorkerSettled,
  serializeShippingClaimOperation,
  shippingSetupAction,
  terminalClaimReleaseReady,
  type DirectShipAuthorization,
  type ShippingClaimObservation,
  workerStateSettled,
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

void test('ACP cancellation is not settled until its exact turn stops', () => {
  const activity = {
    alive: true,
    active: ['session-1'],
    activeTurns: { 'session-1': 'turn-1' },
    waiting: [],
    sessions: ['session-1'],
    finished: {},
  };
  assert.equal(acpWorkerTerminationConfirmed(activity, [], 'codex', 'session-1', 'turn-1'), false);
  activity.active = [];
  assert.equal(acpWorkerTerminationConfirmed(activity, [], 'codex', 'session-1', 'turn-1'), false);
  assert.equal(
    acpWorkerTerminationConfirmed(
      activity,
      [
        {
          agent: 'codex',
          sessionId: 'session-1',
          directory: '/repo',
          turnId: 'turn-1',
          text: 'ship',
        },
      ],
      'codex',
      'session-1',
      'turn-1',
    ),
    true,
  );
});

void test('OpenCode fencing cancels queued work when interrupt reports false', async () => {
  const events: string[] = [];
  let queued = ['inbox-1'];
  let inspections = 0;
  const stopped = await confirmOpenCodeWorkerStopped(
    async () => {
      events.push('interrupt:false');
      return { interrupted: false };
    },
    async () => {
      inspections++;
      return { running: false, queued: [...queued] };
    },
    async (id) => {
      events.push(`cancel:${id}`);
      queued = queued.filter((item) => item !== id);
    },
    async () => undefined,
    4,
  );

  assert.equal(stopped, true);
  assert.equal(inspections, 3);
  assert.deepEqual(events, ['interrupt:false', 'cancel:inbox-1']);
});

void test('OpenCode fencing does not settle while execution stays active', async () => {
  let interruptions = 0;
  const stopped = await confirmOpenCodeWorkerStopped(
    async () => {
      interruptions++;
      return { interrupted: false };
    },
    async () => ({ running: true, queued: [] }),
    async () => undefined,
    async () => undefined,
    2,
  );

  assert.equal(stopped, false);
  assert.equal(interruptions, 3);
});

void test('OpenCode fencing waits for a late prompt dispatch before trusting idle state', async () => {
  const dispatches = createPromptDispatchTracker();
  let acknowledgePrompt!: () => void;
  void dispatches.track(
    'run:issue',
    () =>
      new Promise<void>((resolve) => {
        acknowledgePrompt = resolve;
      }),
  );
  let running = false;
  let pauses = 0;
  let inspections = 0;
  let interruptions = 0;
  const stopped = await confirmOpenCodeWorkerStopped(
    async () => {
      interruptions++;
      const interrupted = running;
      if (running) running = false;
      return { interrupted };
    },
    async () => {
      inspections++;
      return { running, queued: [] };
    },
    async () => undefined,
    async () => {
      pauses++;
      if (pauses === 2) {
        running = true;
        acknowledgePrompt();
        await Promise.resolve();
      }
    },
    6,
    () => dispatches.pending('run:issue'),
  );

  assert.equal(stopped, true);
  assert.equal(inspections, 2);
  assert.equal(interruptions, 2);
  assert.equal(pauses, 3);
});

void test('OpenCode fencing fails closed while prompt dispatch remains unacknowledged', async () => {
  let inspections = 0;
  const stopped = await confirmOpenCodeWorkerStopped(
    async () => ({ interrupted: false }),
    async () => {
      inspections++;
      return { running: false, queued: [] };
    },
    async () => undefined,
    async () => undefined,
    3,
    () => true,
  );

  assert.equal(stopped, false);
  assert.equal(inspections, 0);
});

void test('persisted dispatch admission requires its exact prompt ID', () => {
  const unrelatedInbox = new Set(['other-turn']);
  const unrelatedMessages = new Set(['old-identical-prompt']);
  assert.equal(
    promptDispatchAdmissionVisible('delayed-turn', unrelatedInbox, unrelatedMessages),
    false,
  );
  assert.equal(
    promptDispatchAdmissionVisible('delayed-turn', new Set(['delayed-turn']), unrelatedMessages),
    true,
  );
  assert.equal(
    promptDispatchAdmissionVisible('delayed-turn', unrelatedInbox, new Set(['delayed-turn'])),
    true,
  );
});

void test('parked OpenCode prompts resume before their admission fence clears', async () => {
  let delivery: 'parked' | 'steered' = 'parked';
  let running = false;
  let persisted: 'queued' | 'working' | null = null;
  const authorization = {
    ...stalePaneAuthorization(),
    authorized: () => true,
  };

  await recoverOpenCodePromptAdmission(
    'queued',
    authorization,
    async () => {
      delivery = 'steered';
    },
    async () => {
      assert.equal(delivery, 'steered');
      running = true;
    },
    async () => {
      delivery = 'parked';
    },
    async (state) => {
      assert.equal(running, true);
      persisted = state;
    },
  );

  assert.equal(delivery, 'steered');
  assert.equal(running, true);
  assert.equal(persisted, 'queued');
});

void test('parked OpenCode prompts stay fenced when ownership expires during activation', async () => {
  let authorized = true;
  let running = false;
  let persisted = false;
  let compensated = false;
  const authorization = {
    ...stalePaneAuthorization(),
    authorized: () => authorized,
  };

  await assert.rejects(
    recoverOpenCodePromptAdmission(
      'queued',
      authorization,
      async () => {
        authorized = false;
      },
      async () => {
        running = true;
      },
      async () => {
        compensated = true;
      },
      async () => {
        persisted = true;
      },
    ),
    /authorization expired before prompt dispatch/,
  );

  assert.equal(running, false);
  assert.equal(persisted, false);
  assert.equal(compensated, true);
});

void test('ACP coordination preserves its worker when the claim expired during the wait', async () => {
  let worker = 'original worker';

  await assert.rejects(
    beginAuthorizedCoordinationPrompt(
      () => stalePaneAuthorization(),
      async () => {
        worker = 'coordination turn';
      },
      async () => {
        worker = 'original worker';
      },
      () => Promise.resolve(),
    ),
    /authorization expired before prompt dispatch/,
  );

  assert.equal(worker, 'original worker');
});

void test('ACP coordination restores its worker when the claim expires before dispatch', async () => {
  let checks = 0;
  let worker = 'original worker';
  const authorization = {
    ...stalePaneAuthorization(),
    authorized: () => ++checks === 1,
  };

  await assert.rejects(
    beginAuthorizedCoordinationPrompt(
      () => authorization,
      async () => {
        worker = 'coordination turn';
      },
      async () => {
        worker = 'original worker';
      },
      () => Promise.resolve(),
    ),
    /authorization expired before prompt dispatch/,
  );

  assert.equal(worker, 'original worker');
});

for (const scenario of [
  {
    name: 'queued steer remains visible',
    admission: 'queued' as const,
    expected: { state: 'queued', dispatchPending: false },
  },
  {
    name: 'delivered steer remains visible',
    admission: 'working' as const,
    expected: { state: 'working', dispatchPending: false },
  },
  {
    name: 'cancelled steer is absent',
    admission: null,
    expected: { state: 'starting', turnId: null, dispatchPending: false },
  },
]) {
  void test(`OpenCode compensation ${scenario.name}`, () => {
    assert.deepEqual(
      compensatedOpenCodePromptReceiptChanges(scenario.admission),
      scenario.expected,
    );
  });
}

void test('OpenCode recovery rejects receipts without a persisted prompt', () => {
  assert.equal(
    openCodePromptRecoveryFailure('opencode:session-one', null),
    'Recovered OpenCode worker has no persisted prompt.',
  );
  assert.equal(openCodePromptRecoveryFailure('opencode:session-one', 'ship it'), null);
});

void test('stale recovery completion cannot restore a fenced shipping issue', async () => {
  let authorized = true;
  let transitioned = false;
  const recovery = Promise.withResolvers<void>();
  const authorization = {
    ...stalePaneAuthorization(),
    authorized: () => authorized,
  };
  const completion = completeAuthorizedPromptRecovery(
    authorization,
    () => recovery.promise,
    async () => {
      transitioned = true;
    },
  );

  authorized = false;
  recovery.resolve();

  await assert.rejects(completion, /authorization expired before prompt dispatch/);
  assert.equal(transitioned, false);
});

void test('forced claim validation ignores a cached heartbeat deadline', () => {
  assert.equal(claimHeartbeatDue(100, 200), false);
  assert.equal(claimHeartbeatDue(100, 200, true), true);
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
  assert.equal(shipping.issues[0].checkpoint?.taskId, 'first');
  assert.equal(shipping.issues[0].checkpoint?.source, graph.issues[0].url);
  assert.equal(shipping.issues[0].validationPolicyRequired, true);
});

void test('adopts an already-running direct Ship It thread', () => {
  const branch = registeredShipBranch(
    [{ path: '/repo/worktrees/gateway-fix', branch: 'fix/gateway', present: true }],
    '/repo/worktrees/gateway-fix',
  );
  const adopted = adoptDirectShipRun([], {
    id: 'direct-run',
    project: '/repo',
    directory: '/repo/worktrees/gateway-fix',
    branch,
    repository: 'kumahq/kuma',
    number: 18976,
    provider: 'codex',
    threadId: 'acp:codex:running-thread',
    workerModel: 'gpt-5.6-luna',
    approvedAt: 100,
  });

  const issue = adopted[0].issues[0];
  assert.equal(adopted[0].remote, 'kumahq/kuma');
  assert.equal(adopted[0].repository, '/repo');
  assert.equal(issue.url, 'https://github.com/kumahq/kuma/issues/18976');
  assert.equal(issue.state, 'working');
  assert.equal(issue.branch, 'fix/gateway');
  assert.equal(issue.stage, 'implementing');
  assert.equal(issue.workerModel, 'gpt-5.6-luna');
  assert.equal(issue.checkpoint?.taskId, 'kumahq/kuma#18976');
  assert.equal(issue.checkpoint?.source, issue.url);
  assert.equal(issue.validationPolicyRequired, true);
  assert.equal(
    shipOwner(adopted, '/repo/worktrees/gateway-fix', 'acp:codex:running-thread')?.issue,
    issue,
  );
});

void test('rejects a direct Ship worktree without a registered branch', () => {
  assert.throws(
    () =>
      registeredShipBranch(
        [{ path: '/repo/worktrees/gateway-fix', branch: null, present: true }],
        '/repo/worktrees/gateway-fix',
      ),
    /no registered branch/,
  );
});

void test('direct Ship It shares one exact claim before the worker prompt', async () => {
  const issue = adoptDirectShipRun([], {
    id: 'direct-run',
    project: '/repo',
    directory: '/repo/worktree',
    repository: 'owner/repo',
    number: 271,
    provider: 'codex',
    threadId: 'acp:codex:worker',
    approvedAt: 100,
  })[0].issues[0];
  const order: string[] = [];
  const claim = {
    id: 'claim-271',
    holder: 'Sail',
    task: 'ship:direct-run:owner/repo#271',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:00:00.000Z',
    expiresAt: '2026-10-07T10:02:00.000Z',
    status: 'active' as const,
    commentId: 1,
  };
  await persistAcquiredClaim(
    claim,
    async (acquired) => {
      issue.claim = acquired;
      order.push('persist claim');
    },
    async () => order.push('release claim'),
  );
  const prompt = `/ship-it ${issue.url}${directShipClaimPrompt(issue.claim!)}`;
  order.push('send prompt');
  assert.deepEqual(order, ['persist claim', 'send prompt']);
  assert.match(prompt, /claim-271 for task ship:direct-run:owner\/repo#271/);
  assert.match(prompt, /do not acquire another claim/);
});

void test('failed claim persistence compensates the remote acquisition', async () => {
  const claim = {
    id: 'claim-271',
    holder: 'Sail',
    task: 'ship:271',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:00:00.000Z',
    expiresAt: '2026-10-07T10:02:00.000Z',
    status: 'active' as const,
    commentId: 1,
  };
  let released = false;
  await assert.rejects(
    persistAcquiredClaim(
      claim,
      async () => {
        throw new Error('disk full');
      },
      async (acquired) => {
        assert.equal(acquired, claim);
        released = true;
      },
    ),
    /disk full/,
  );
  assert.equal(released, true);
});

void test('failed direct run holds a new claim through the prompt handoff', async () => {
  const issue = adoptDirectShipRun([], {
    id: 'direct-run',
    project: '/repo',
    directory: '/repo/worktree',
    repository: 'owner/repo',
    number: 271,
    provider: 'codex',
    threadId: 'acp:codex:worker',
    approvedAt: 100,
  })[0].issues[0];
  issue.state = 'failed';
  issue.workerSettled = true;
  issue.error = 'Worker failed.';
  const claim = {
    id: 'retry-claim',
    holder: 'Sail',
    task: 'ship:direct-run:owner/repo#271',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:00:00.000Z',
    expiresAt: '2026-10-07T10:02:00.000Z',
    status: 'active' as const,
    commentId: 2,
  };
  let released = false;
  await persistAcquiredClaim(
    claim,
    async (acquired) => {
      Object.assign(issue, directClaimHandoffChanges(issue, acquired));
      assert.equal(issue.state, 'working');
      assert.equal(issue.claimHandoffPending, true);
      await refreshShippingIssueAfterClaim(
        issue,
        async () => {
          if (issue.state === 'failed' && !issue.claimHandoffPending) released = true;
          return true;
        },
        async () => true,
        async () => {
          if (!directClaimHandoffWaiting(issue, 'failed', 999, 1_000)) issue.state = 'failed';
        },
      );
    },
    async () => {
      released = true;
    },
  );
  assert.equal(released, false);
  assert.equal(directClaimHandoffWaiting(issue, 'working', 999, 1_000), false);
  assert.equal(directClaimHandoffWaiting(issue, 'failed', 1_000, 1_000), false);
});

void test('expiry during failed-run handoff stops the new worker before releasing its claim', async () => {
  const issue = run().issues[0];
  issue.state = 'working';
  issue.claimHandoffPending = true;
  issue.claim = {
    id: 'handoff-claim',
    holder: 'Sail',
    task: 'ship:direct-run:owner/repo#271',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:00:00.000Z',
    expiresAt: '2026-10-07T10:02:00.000Z',
    status: 'active',
    commentId: 2,
  };
  const events: string[] = [];
  let workerLive = false;
  let claimed = true;
  let monotonicNow = 999;

  await refreshShippingIssueAfterClaim(
    issue,
    async () => {
      events.push('claim held');
      return true;
    },
    async () => true,
    async () => {
      workerLive = true;
      monotonicNow++;
      const continued = await settleDirectClaimHandoff(
        issue,
        'working',
        async () => {
          events.push('stop worker');
          workerLive = false;
          events.push('release claim');
          assert.equal(workerLive, false);
          claimed = false;
          issue.claimHandoffPending = false;
        },
        async () => {
          events.push('end handoff');
          issue.claimHandoffPending = false;
        },
        monotonicNow,
        1_000,
      );
      assert.equal(continued, false);
    },
  );

  assert.deepEqual(events, ['claim held', 'stop worker', 'release claim']);
  assert.equal(workerLive, false);
  assert.equal(claimed, false);
  assert.equal(issue.claimHandoffPending, false);
});

void test('direct prompt generation fences a stalled local producer', () => {
  const issue = run().issues[0];
  issue.state = 'working';
  issue.claim = {
    id: 'retry-claim',
    holder: 'Sail',
    task: 'ship:direct-run:owner/repo#271',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:00:00.000Z',
    expiresAt: '2026-10-07T10:02:00.000Z',
    status: 'active',
    commentId: 2,
  };

  assert.equal(directShipPromptAuthorized(issue, issue.claim.id, 4, 4, 999, 1_000), true);
  issue.state = 'starting';
  assert.equal(directShipPromptAuthorized(issue, issue.claim.id, 4, 4, 999, 1_000), true);
  assert.equal(directShipPromptAuthorized(issue, issue.claim.id, 4, 5, 999, 1_000), false);
  assert.equal(directShipPromptAuthorized(issue, issue.claim.id, 4, 4, 1_000, 1_000), false);
});

function stalePaneAuthorization(): DirectShipAuthorization {
  return {
    claim: {
      id: 'stale-pane-claim',
      holder: 'Sail',
      task: 'ship:direct-run:owner/repo#271',
      acquiredAt: '2026-10-07T10:00:00.000Z',
      heartbeatAt: '2026-10-07T10:00:00.000Z',
      expiresAt: '2026-10-07T10:02:00.000Z',
      status: 'active',
      commentId: 2,
    },
    key: 'direct-run:owner/repo#271',
    generation: 4,
    authorized: () => false,
  };
}

void test('OpenCode pane rejects stale authorization after snapshot tracking stalls', () => {
  let dispatched = false;
  assert.throws(
    () =>
      dispatchAuthorizedDirectShipPrompt(stalePaneAuthorization(), () => {
        dispatched = true;
      }),
    /authorization expired before prompt dispatch/,
  );
  assert.equal(dispatched, false);
});

void test('ACP workspace rejects stale authorization after snapshot tracking stalls', () => {
  let dispatched = false;
  assert.throws(
    () =>
      dispatchAuthorizedDirectShipPrompt(stalePaneAuthorization(), () => {
        dispatched = true;
      }),
    /authorization expired before prompt dispatch/,
  );
  assert.equal(dispatched, false);
});

void test('dispatch boundary rejects authorization invalidated after the caller check', () => {
  let checks = 0;
  let dispatched = false;
  const authorization = {
    ...stalePaneAuthorization(),
    authorized: () => ++checks === 1,
    dispatch: <T>(start: () => T) => start(),
  };

  assert.throws(
    () =>
      dispatchAuthorizedDirectShipPrompt(authorization, () => {
        dispatched = true;
      }),
    /authorization expired before prompt dispatch/,
  );
  assert.equal(dispatched, false);
});

void test('scheduled worker launch rejects a claim invalidated during startup awaits', () => {
  assert.throws(
    () => assertDirectShipPromptAuthorization(stalePaneAuthorization()),
    /authorization expired before prompt dispatch/,
  );
});

for (const producer of [
  'OpenCode recovery',
  'ACP recovery',
  'OpenCode coordination delivery',
  'ACP coordination delivery',
]) {
  void test(`${producer} rejects a claim invalidated during reconnect`, () => {
    let dispatched = false;
    assert.throws(
      () =>
        dispatchAuthorizedDirectShipPrompt(stalePaneAuthorization(), () => {
          dispatched = true;
        }),
      /authorization expired before prompt dispatch/,
    );
    assert.equal(dispatched, false);
  });
}

void test('terminal claim release waits for worker settlement and completed fencing', () => {
  const issue = run().issues[0];
  issue.state = 'merged';
  issue.workerSettled = false;
  assert.equal(terminalClaimReleaseReady(issue), false);

  issue.workerSettled = true;
  issue.claimFencePending = true;
  assert.equal(terminalClaimReleaseReady(issue), false);

  issue.claimFencePending = false;
  assert.equal(terminalClaimReleaseReady(issue, false, true), true);
  assert.equal(terminalClaimReleaseReady(issue, true, true), false);
  assert.equal(terminalClaimReleaseReady(issue, false, false), false);
  issue.dispatchFencePending = true;
  assert.equal(terminalClaimReleaseReady(issue), false);
  issue.dispatchFencePending = false;
  assert.equal(workerStateSettled('working'), false);
  assert.equal(workerStateSettled('unavailable'), false);
  assert.equal(workerStateSettled('completed'), true);
  assert.equal(workerStateSettled('completed', true), false);
});

void test('terminal polling retains the claim while a direct prompt POST is pending', async () => {
  const issue = run().issues[0];
  issue.state = 'failed';
  issue.workerSettled = true;
  const dispatches = createPromptDispatchTracker();
  let acknowledge!: () => void;
  void dispatches.track(
    'direct:issue',
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );

  assert.equal(terminalClaimReleaseReady(issue, dispatches.pending('direct:issue'), true), false);
  acknowledge();
  await Promise.resolve();
  assert.equal(terminalClaimReleaseReady(issue, dispatches.pending('direct:issue'), true), true);
});

void test('claim loss stops every task-owned thread before release', async () => {
  const live = new Set(['owner', 'checkpoint']);

  await fenceShippingTaskThreads(['owner', 'checkpoint', 'checkpoint'], async (threadId) => {
    live.delete(threadId);
  });
  const claimReleased = live.size === 0;

  assert.deepEqual([...live], []);
  assert.equal(claimReleased, true);
});

void test('resume fencing stops every worker before authoritative revalidation', async () => {
  const events: string[] = [];

  assert.equal(
    await fenceResumedShippingClaim(
      async () => {
        events.push('stop workers');
      },
      async () => {
        events.push('revalidate claim');
        return true;
      },
      async () => {
        events.push('settle interrupted worker');
      },
    ),
    true,
  );
  assert.deepEqual(events, ['stop workers', 'revalidate claim', 'settle interrupted worker']);
});

void test('resume fencing retries worker termination before revalidation', async () => {
  const events: string[] = [];
  let attempts = 0;
  const attempt = () =>
    fenceResumedShippingClaim(
      async () => {
        events.push('stop workers');
        if (++attempts === 1) throw new Error('still running');
      },
      async () => {
        events.push('revalidate claim');
        return true;
      },
      async () => events.push('settle interrupted worker'),
    );

  await assert.rejects(attempt(), /still running/);
  assert.equal(await attempt(), true);
  assert.deepEqual(events, [
    'stop workers',
    'stop workers',
    'revalidate claim',
    'settle interrupted worker',
  ]);
});

void test('a copied claim cannot authorize another Sail instance', () => {
  const claim = {
    id: 'claim-1',
    instanceId: 'instance-a',
    holder: 'Sail A',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active' as const,
    commentId: 1,
  };

  assert.equal(shippingClaimOwnedByInstance(claim, 'instance-a'), true);
  assert.equal(shippingClaimOwnedByInstance(claim, 'instance-b'), false);
});

void test('a foreign active run is observed without recovering or stopping its worker', async () => {
  const issue = run().issues[0];
  issue.state = 'working';
  issue.claim = {
    id: 'claim-1',
    instanceId: 'instance-a',
    holder: 'Sail A',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active',
    commentId: 1,
  };
  const events: string[] = [];

  await refreshShippingIssueAfterClaim(
    issue,
    async () => {
      events.push('refresh claim');
      return true;
    },
    async () => {
      events.push('acquire claim');
      return true;
    },
    async () => events.push('recover worker'),
    async () => events.push('stop worker'),
    async () => events.push('retry validation'),
    false,
  );

  assert.deepEqual(events, []);
  assert.equal(issue.state, 'working');
  assert.equal(issue.claim.instanceId, 'instance-a');
});

void test('an expired foreign claim fences its orphaned OpenCode worker before takeover', async () => {
  const shippingRun = run();
  const issue = shippingRun.issues[0];
  issue.state = 'working';
  issue.threadId = 'opencode:orphaned-session';
  issue.receiptId = 'orphaned-receipt';
  issue.claim = {
    id: 'claim-1',
    instanceId: 'dead-instance',
    holder: 'Sail OpenCode',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active',
    commentId: 1,
  };
  let workerRunning = true;

  const result = await fencePredecessorWorkerBeforeTakeover(
    async () => ({ claim: issue.claim!, active: false, remainingLeaseMillis: 0 }),
    async () => {
      workerRunning = false;
    },
    async () => undefined,
  );
  Object.assign(issue, predecessorTakeoverChanges(issue));

  assert.equal(result.fenced, true);
  assert.equal(workerRunning, false);
  assert.equal(issue.state, 'pending');
  assert.equal(issue.claim, undefined);
  assert.equal(issue.threadId, null);
  assert.equal(issue.receiptId, null);
  assert.deepEqual(
    readyShipIssues(shippingRun).map((candidate) => candidate.id),
    ['first', 'second'],
  );
});

void test('a recovered claim uses the server-relative remaining lease despite wall clock skew', () => {
  const deadlines = recoveredClaimLeaseDeadlines(5_000, 9_000_000, 30_000);

  assert.deepEqual(deadlines, {
    monotonic: 35_000,
    wall: 9_030_000,
  });
});

void test('an expired recovered claim is fenced immediately', () => {
  const deadlines = recoveredClaimLeaseDeadlines(5_000, 9_000_000, 0);

  assert.deepEqual(deadlines, {
    monotonic: 5_000,
    wall: 9_000_000,
  });
});

void test('a released predecessor claim preserves settled terminal cleanup state', async () => {
  const shipping = run();
  const issue = shipping.issues[0];
  issue.state = 'merged';
  issue.workerSettled = true;
  issue.receiptId = 'settled-receipt';
  issue.threadId = 'settled-thread';
  issue.claim = {
    id: 'claim-1',
    holder: 'Sail A',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active',
    commentId: 1,
  };

  const result = await fencePredecessorWorkerBeforeTakeover(
    async () => ({ claim: issue.claim!, active: false, remainingLeaseMillis: 0 }),
    async () => {
      if (!recoveredClaimWorkerFenceRequired(issue, true)) return;
      throw new Error('OpenCode is unavailable; stop the worker manually.');
    },
    async () => undefined,
  );
  Object.assign(issue, predecessorTakeoverChanges(issue));

  assert.equal(result.fenced, true);
  assert.equal(issue.state, 'merged');
  assert.equal(issue.claim, undefined);
  assert.equal(issue.receiptId, 'settled-receipt');
  assert.equal(issue.threadId, 'settled-thread');
  assert.equal(recoveredClaimWorkerFenceRequired(issue, true), false);
  assert.deepEqual(
    readyShipIssues(shipping).map((candidate) => candidate.id),
    ['second', 'dependent'],
  );
});

void test('a terminal issue with a live checkpoint still fences its recovered worker', () => {
  const issue = run().issues[0];
  issue.state = 'merged';
  issue.workerSettled = true;
  issue.checkpointThreadIds = ['checkpoint'];

  assert.equal(recoveredClaimWorkerFenceRequired(issue, false), true);
});

void test('a recovered claim keeps its lease fence until observation replaces it', async () => {
  let resolveObservation!: (observation: ShippingClaimObservation) => void;
  const observation = new Promise<ShippingClaimObservation>((resolve) => {
    resolveObservation = resolve;
  });
  let leaseMillis = 45_000;

  const reconciliation = fencePredecessorWorkerBeforeTakeover(
    () => observation,
    async () => undefined,
    async () => undefined,
    async ({ observation: current }) => {
      leaseMillis = current.remainingLeaseMillis;
    },
  );

  assert.equal(leaseMillis, 45_000);
  resolveObservation({
    claim: {
      id: 'claim-1',
      holder: 'Sail A',
      task: 'issue-11',
      acquiredAt: '2026-10-07T10:00:00.000Z',
      heartbeatAt: '2026-10-07T10:01:00.000Z',
      expiresAt: '2026-10-07T10:03:00.000Z',
      status: 'active',
      commentId: 1,
    },
    active: true,
    remainingLeaseMillis: 30_000,
  });
  await reconciliation;
  assert.equal(leaseMillis, 30_000);
});

void test('a failed recovered claim observation leaves its lease fence armed', async () => {
  let rejectObservation!: (cause: Error) => void;
  const observation = new Promise<ShippingClaimObservation>((_resolve, reject) => {
    rejectObservation = reject;
  });
  let leaseFenceArmed = true;

  const reconciliation = fencePredecessorWorkerBeforeTakeover(
    () => observation,
    async () => undefined,
    async () => undefined,
    async () => {
      leaseFenceArmed = false;
    },
  );

  rejectObservation(new Error('observation timed out'));
  await assert.rejects(reconciliation, /observation timed out/);
  assert.equal(leaseFenceArmed, true);
});

void test('an orphan stop failure retains the predecessor takeover fence', async () => {
  const issue = run().issues[0];
  issue.claim = {
    id: 'claim-1',
    instanceId: 'dead-instance',
    holder: 'Sail OpenCode',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active',
    commentId: 1,
  };
  const events: string[] = [];

  await assert.rejects(
    fencePredecessorWorkerBeforeTakeover(
      async () => {
        events.push('reserve takeover fence');
        return { claim: issue.claim!, active: false, remainingLeaseMillis: 0 };
      },
      async () => {
        events.push('stop worker');
        throw new Error('worker still running');
      },
      async () => events.push('release takeover fence'),
    ),
    /worker still running/,
  );

  assert.deepEqual(events, ['reserve takeover fence', 'stop worker']);
});

void test('resume contention retries validation without releasing the claim', async () => {
  const issue = run().issues[0];
  issue.state = 'working';
  issue.claimFencePending = true;
  issue.claimRevalidationPending = true;
  const events: string[] = [];

  await refreshShippingIssueAfterClaim(
    issue,
    async () => {
      events.push('ordinary refresh');
      return true;
    },
    async () => {
      events.push('acquire');
      return true;
    },
    async () => events.push('worker'),
    async () => events.push('release claim'),
    async () => events.push('retry validation'),
  );

  assert.deepEqual(events, ['retry validation']);
});

void test('resume settlement preserves a merged delivery', () => {
  const issue = run().issues[0];
  issue.state = 'merged';
  issue.claimFencePending = true;
  issue.claimRevalidationPending = true;

  Object.assign(issue, resumedShippingIssueChanges(issue));

  assert.equal(issue.state, 'merged');
  assert.equal(issue.claimFencePending, false);
  assert.equal(issue.claimRevalidationPending, false);
  assert.equal(issue.workerSettled, true);
});

void test('merged issue retains its claim while a checkpoint worker is live', () => {
  const issue = run().issues[0];
  issue.state = 'merged';
  issue.workerSettled = true;
  issue.threadId = 'owner';
  issue.checkpointThreadIds = ['checkpoint'];

  const releaseReady = terminalClaimReleaseReady(issue, false, false);

  assert.equal(releaseReady, false);
});

void test('expired lease fences while heartbeat transport remains hung', async () => {
  let finishHeartbeat!: () => void;
  let heartbeatSettled = false;
  const heartbeat = new Promise<void>((resolve) => {
    finishHeartbeat = resolve;
  }).then(() => {
    heartbeatSettled = true;
    return undefined;
  });
  let workerLive = true;

  const fenced = await fenceExpiredShippingLease(120_000, 120_000, async () => {
    workerLive = false;
  });

  assert.equal(fenced, true);
  assert.equal(workerLive, false);
  assert.equal(heartbeatSettled, false);
  finishHeartbeat();
  await heartbeat;
});

void test('wall elapsed lease fences after WebKit monotonic time pauses', async () => {
  let workerLive = true;

  const fenced = await fenceExpiredShippingLease(
    501,
    120_500,
    async () => {
      workerLive = false;
    },
    130_000,
    130_000,
  );

  assert.equal(fenced, true);
  assert.equal(workerLive, false);
});

void test('stalled prompt recovery does not block heartbeats beyond the original lease', async () => {
  const issue = run().issues[0];
  issue.state = 'working';
  issue.claim = {
    id: 'recovery-claim',
    holder: 'Sail',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active',
    commentId: 1,
  };
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  let fireTimeout!: () => void;
  const timeout = new Promise<void>((resolve) => {
    fireTimeout = resolve;
  });
  const recovery = boundedPromptDispatch(prompt, timeout);
  const heartbeatTimes = [0, 45_000, 90_000, 135_000];
  const observed: number[] = [];

  await Promise.all(
    heartbeatTimes.map((elapsed) =>
      refreshShippingIssueAfterClaim(
        issue,
        async () => {
          observed.push(elapsed);
          return true;
        },
        async () => true,
        async () => undefined,
      ),
    ),
  );

  assert.deepEqual(observed, heartbeatTimes);
  assert.ok(observed.at(-1)! > 120_000);
  fireTimeout();
  assert.deepEqual(await recovery, { status: 'timed_out' });
  finishPrompt();
});

void test('timed out recovery aborts transport and cancels a late parked prompt', async () => {
  const dispatches = createPromptDispatchTracker();
  const controller = new AbortController();
  const prompt = dispatches.track(
    'run:issue',
    () =>
      new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  );
  let fireTimeout!: () => void;
  const timeout = new Promise<void>((resolve) => {
    fireTimeout = resolve;
  });
  const recovery = boundedPromptDispatch(prompt, timeout, () => controller.abort());

  fireTimeout();
  assert.deepEqual(await recovery, { status: 'timed_out' });
  await Promise.resolve();
  assert.equal(dispatches.pending('run:issue'), false);

  let queued: string[] = [];
  let pauses = 0;
  const cancelled: string[] = [];
  const stopped = await confirmOpenCodeWorkerStopped(
    async () => ({ interrupted: false }),
    async () => ({ running: false, queued: [...queued] }),
    async (id) => {
      cancelled.push(id);
      queued = queued.filter((item) => item !== id);
    },
    async () => {
      pauses++;
      if (pauses === 1) queued = ['late-parked-post'];
    },
    8,
  );

  assert.equal(stopped, true);
  assert.deepEqual(cancelled, ['late-parked-post']);
});

void test('handoff lease uses server duration on a monotonic clock', async () => {
  const issue = run().issues[0];
  issue.state = 'working';
  issue.claimHandoffPending = true;
  const claim = {
    id: 'handoff-claim',
    holder: 'Sail',
    task: 'ship:direct-run:owner/repo#271',
    acquiredAt: '2099-01-01T00:00:00.000Z',
    heartbeatAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:02:00.000Z',
    status: 'active' as const,
    commentId: 2,
  };
  issue.claim = claim;
  const deadline = claimMonotonicLeaseDeadline(500, claim);
  assert.equal(deadline, 120_500);

  let fenced = false;
  assert.equal(
    await settleDirectClaimHandoff(
      issue,
      'working',
      async () => {
        fenced = true;
      },
      async () => {
        issue.claimHandoffPending = false;
      },
      deadline,
      deadline,
    ),
    false,
  );
  assert.equal(fenced, true);
});

void test('initial heartbeat uses server-validated lease remaining under client clock skew', () => {
  const claim = {
    id: 'skewed-claim',
    holder: 'Sail',
    task: 'issue-11',
    acquiredAt: '2026-10-07T09:58:30.000Z',
    heartbeatAt: '2026-10-07T09:58:30.000Z',
    expiresAt: '2026-10-07T10:00:30.000Z',
    status: 'active' as const,
    commentId: 3,
    commentUpdatedAtMillis: Date.parse('2026-10-07T10:00:00.000Z'),
  };

  const leaseDeadline = claimMonotonicLeaseDeadline(1_000, claim);
  const heartbeatDeadline = nextClaimHeartbeatDeadline(1_100, leaseDeadline);
  assert.equal(leaseDeadline, 31_000);
  assert.equal(heartbeatDeadline, 16_050);
  assert.equal(claimHeartbeatDue(16_049, heartbeatDeadline), false);
  assert.equal(claimHeartbeatDue(16_050, heartbeatDeadline), true);
});

void test('detects WebKit clock suspension before a stale lease can authorize dispatch', () => {
  assert.equal(shippingClockWasSuspended(10_000, 500, 130_000, 501), true);
  assert.equal(shippingClockWasSuspended(10_000, 500, 11_000, 1_500), false);
  assert.equal(shippingClockWasSuspended(10_000, 500, 9_000, 501), false);
});
void test('fills in the recovered direct worker model without duplicating the run', () => {
  const input = {
    id: 'direct-run',
    project: '/repo',
    directory: '/repo/worktrees/gateway-fix',
    branch: 'fix/gateway',
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

  const switched = adoptDirectShipRun(recovered, {
    ...input,
    id: 'third-run',
    workerModel: 'provider:replacement-model',
  });
  assert.equal(switched.length, 1);
  assert.equal(switched[0].issues[0].workerModel, 'provider:replacement-model');
});

void test('concurrent direct adoptions keep both runs when registrations finish out of order', async () => {
  let finishFirst!: (worktrees: [{ path: string; branch: string; present: true }]) => void;
  let finishSecond!: (worktrees: [{ path: string; branch: string; present: true }]) => void;
  const firstRegistration = new Promise<[{ path: string; branch: string; present: true }]>(
    (resolve) => (finishFirst = resolve),
  );
  const secondRegistration = new Promise<[{ path: string; branch: string; present: true }]>(
    (resolve) => (finishSecond = resolve),
  );
  let runs: ReturnType<typeof adoptDirectShipRun> = [];
  let saved: ReturnType<typeof adoptDirectShipRun> = [];
  const getRuns = () => runs;
  const setRuns = (value: typeof runs) => (runs = value);
  const saveRuns = async () => {
    saved = runs;
  };
  const common = {
    project: '/repo',
    repository: 'owner/repo',
    provider: 'codex' as const,
    approvedAt: 100,
  };

  const first = adoptRegisteredDirectShipRun(
    firstRegistration,
    { ...common, id: 'first', directory: '/repo/first', number: 11, threadId: 'acp:codex:one' },
    getRuns,
    setRuns,
    saveRuns,
  );
  const second = adoptRegisteredDirectShipRun(
    secondRegistration,
    { ...common, id: 'second', directory: '/repo/second', number: 12, threadId: 'acp:codex:two' },
    getRuns,
    setRuns,
    saveRuns,
  );
  finishSecond([{ path: '/repo/second', branch: 'fix/two', present: true }]);
  await second;
  finishFirst([{ path: '/repo/first', branch: 'fix/one', present: true }]);
  await first;

  assert.deepEqual(
    runs.map((item) => [item.id, item.issues[0].branch]),
    [
      ['second', 'fix/two'],
      ['first', 'fix/one'],
    ],
  );
  assert.equal(saved.length, 2);
});

void test('concurrent adoption of one thread keeps one run', async () => {
  let finish!: (worktrees: [{ path: string; branch: string; present: true }]) => void;
  const delayedRegistration = new Promise<[{ path: string; branch: string; present: true }]>(
    (resolve) => (finish = resolve),
  );
  let runs: ReturnType<typeof adoptDirectShipRun> = [];
  let saved: ReturnType<typeof adoptDirectShipRun> = [];
  const getRuns = () => runs;
  const setRuns = (value: typeof runs) => (runs = value);
  const saveRuns = async () => {
    saved = runs;
  };
  const input = {
    id: 'first',
    project: '/repo',
    directory: '/repo/first',
    repository: 'owner/repo',
    number: 11,
    provider: 'codex' as const,
    threadId: 'acp:codex:one',
    approvedAt: 100,
  };

  const first = adoptRegisteredDirectShipRun(
    delayedRegistration,
    input,
    getRuns,
    setRuns,
    saveRuns,
  );
  const second = adoptRegisteredDirectShipRun(
    delayedRegistration,
    { ...input, id: 'second' },
    getRuns,
    setRuns,
    saveRuns,
  );
  finish([{ path: '/repo/first', branch: 'fix/one', present: true }]);
  await Promise.all([first, second]);

  assert.equal(runs.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(runs[0].issues[0].threadId, 'acp:codex:one');
});

void test('same-thread retry continues with its existing failed shipping run', async () => {
  const input = {
    id: 'first',
    project: '/repo',
    directory: '/repo/first',
    repository: 'owner/repo',
    number: 11,
    provider: 'codex' as const,
    threadId: 'acp:codex:one',
    workerModel: 'openai:gpt-5',
    approvedAt: 100,
  };
  const runs = adoptDirectShipRun([], input);
  runs[0].issues[0].state = 'failed';
  let current = runs;

  const adopted = await adoptRegisteredDirectShipRun(
    Promise.resolve([{ path: '/repo/first', branch: 'fix/one', present: true }]),
    { ...input, id: 'retry', approvedAt: 200 },
    () => current,
    (value) => (current = value),
    async () => {},
  );

  assert.equal(adopted, true);
  assert.equal(current.length, 1);
  assert.equal(current[0].issues[0].state, 'failed');
});

void test('same-thread retry waits for the monitor heartbeat before renewing', async () => {
  const operations = new Map<string, Promise<void>>();
  let revision = 0;
  let retrySubmittedRevision: number | null = null;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let secondEntered = false;

  const first = serializeShippingClaimOperation(operations, 'run:issue', async () => {
    firstStarted();
    const submitted = revision;
    await firstBlocked;
    revision = submitted + 1;
  });
  await firstEntered;
  const second = serializeShippingClaimOperation(operations, 'run:issue', async () => {
    secondEntered = true;
    const submitted = revision;
    retrySubmittedRevision = submitted;
    revision = submitted + 1;
  });

  await Promise.resolve();
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(revision, 2);
  assert.equal(retrySubmittedRevision, 1);
  assert.equal(operations.size, 0);
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

void test('fences a worker only when its monotonic lease expires or ownership is lost', () => {
  const claim = {
    id: 'claim-1',
    holder: 'Sail',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active' as const,
    commentId: 1,
  };

  assert.equal(
    claimRefreshRequiresFence(claim, new Error('temporary network failure'), 119_999, 120_000),
    false,
  );
  assert.equal(
    claimRefreshRequiresFence(
      claim,
      new Error('Shipping claim was superseded by another worker.'),
      119_999,
      120_000,
    ),
    true,
  );
  assert.equal(
    claimRefreshRequiresFence(claim, new Error('temporary network failure'), 120_000, 120_000),
    true,
  );
  assert.equal(
    claimRefreshRequiresFence(
      claim,
      new Error('Shipping claim fence is no longer owned by this claim.'),
      119_999,
      120_000,
    ),
    true,
  );
  assert.equal(
    claimRefreshRequiresFence(
      claim,
      new Error('Shipping claim fence revision is stale.'),
      119_999,
      120_000,
    ),
    false,
  );
  assert.equal(
    claimRefreshRequiresFence(
      claim,
      new Error('Another claimant is reconciling the shipping claim.'),
      119_999,
      120_000,
    ),
    false,
  );
  assert.equal(
    claimRefreshRequiresFence(
      claim,
      new Error('Shipping claim update revision is stale.'),
      119_999,
      120_000,
    ),
    true,
  );
});

void test('a fast local wall clock does not fence a server-valid lease after heartbeat failure', () => {
  const claim = {
    id: 'claim-1',
    holder: 'Sail',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active' as const,
    commentId: 1,
  };

  assert.equal(
    claimRefreshRequiresFence(claim, new Error('temporary network failure'), 60_000, 120_000),
    false,
  );
});

void test('closed pull request fences every worker without a terminal state', () => {
  assert.equal(closedPullRequestRequiresFence('working'), true);
  assert.equal(closedPullRequestRequiresFence('waiting'), true);
  assert.equal(closedPullRequestRequiresFence('queued'), true);
  assert.equal(closedPullRequestRequiresFence('unavailable'), true);
  assert.equal(closedPullRequestRequiresFence('completed'), false);
  assert.equal(closedPullRequestRequiresFence('failed'), false);
  assert.equal(closedPullRequestRequiresFence('interrupted'), false);
});

void test('closed pull request fails only after worker fencing settles', async () => {
  const events: string[] = [];
  assert.equal(
    await settleClosedPullRequest(
      'working',
      async () => {
        events.push('fence');
        return true;
      },
      async () => events.push('fail'),
    ),
    true,
  );
  assert.deepEqual(events, ['fence', 'fail']);

  events.length = 0;
  assert.equal(
    await settleClosedPullRequest(
      'working',
      async () => {
        events.push('fence pending');
        return false;
      },
      async () => events.push('fail'),
    ),
    false,
  );
  assert.deepEqual(events, ['fence pending']);
});

void test('stale owner settles locally when successor rejects claim release', () => {
  const claim = {
    id: 'stale-claim',
    holder: 'Sail A',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active' as const,
    commentId: 1,
  };
  assert.deepEqual(
    settledLostClaimFence(
      claim,
      new Error('Shipping claim fence is no longer owned by this claim.'),
    ),
    {
      state: 'failed',
      claim: undefined,
      claimFencePending: false,
      claimRevalidationPending: false,
      claimHandoffPending: false,
      workerSettled: true,
      refreshError: null,
    },
  );
  assert.equal(settledLostClaimFence(claim, new Error('temporary network failure')), null);
});

void test('revalidates a recovered claim before touching its worker', async () => {
  const issue = run().issues[0];
  issue.state = 'starting';
  issue.claim = {
    id: 'persisted-claim',
    holder: 'Sail',
    task: 'issue-11',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active',
    commentId: 1,
  };
  const events: string[] = [];

  await refreshShippingIssueAfterClaim(
    issue,
    async (revalidate) => {
      events.push(`claim:${revalidate}`);
      return false;
    },
    async () => {
      events.push('acquire');
      return true;
    },
    async () => events.push('worker'),
  );
  assert.deepEqual(events, ['claim:true']);

  await refreshShippingIssueAfterClaim(
    issue,
    async (revalidate) => {
      events.push(`claim-held:${revalidate}`);
      return true;
    },
    async () => {
      events.push('acquire-held');
      return true;
    },
    async () => events.push('worker-held'),
  );
  assert.deepEqual(events.slice(-2), ['claim-held:true', 'worker-held']);
});

void test('acquires a claim before recovering a legacy worker receipt', async () => {
  await Promise.all(
    (['starting', 'working'] as const).map(async (state) => {
      const issue = run().issues[0];
      issue.state = state;
      const events: string[] = [];
      await refreshShippingIssueAfterClaim(
        issue,
        async () => {
          events.push('refresh-claim');
          return true;
        },
        async () => {
          events.push('acquire');
          return false;
        },
        async () => events.push('worker'),
      );
      assert.deepEqual(events, ['acquire'], state);
    }),
  );

  const issue = run().issues[0];
  issue.state = 'working';
  const events: string[] = [];
  await refreshShippingIssueAfterClaim(
    issue,
    async () => {
      events.push('refresh-held');
      return true;
    },
    async () => {
      events.push('acquire-held');
      return true;
    },
    async () => events.push('worker-held'),
  );
  assert.deepEqual(events.slice(-2), ['acquire-held', 'worker-held']);
});

void test('keeps a heartbeat failure nonterminal until persisted fencing succeeds', async () => {
  const issue = run().issues[0];
  issue.state = 'working';
  issue.claimFencePending = true;
  const events: string[] = [];

  await refreshShippingIssueAfterClaim(
    issue,
    async () => {
      events.push('refresh-claim');
      return true;
    },
    async () => {
      events.push('acquire');
      return true;
    },
    async () => events.push('worker'),
    async () => events.push('fence-failed'),
  );
  assert.equal(issue.claimFencePending, true);
  assert.equal(issue.state, 'working');
  await refreshShippingIssueAfterClaim(
    issue,
    async () => {
      events.push('refresh-claim');
      return true;
    },
    async () => {
      events.push('acquire');
      return true;
    },
    async () => events.push('worker'),
    async () => {
      events.push('fence-succeeded');
      issue.claimFencePending = false;
      issue.state = 'failed';
    },
  );

  assert.deepEqual(events, ['fence-failed', 'fence-succeeded']);
  assert.equal(issue.state, 'failed');
});

void test('heartbeat deadlines use monotonic elapsed time across wall-clock jumps', () => {
  const deadline = nextClaimHeartbeatDeadline(10_000);

  assert.equal(claimHeartbeatDue(10_001, deadline), false);
  assert.equal(claimHeartbeatDue(54_999, deadline), false);
  assert.equal(claimHeartbeatDue(55_000, deadline), true);
  assert.equal(claimHeartbeatDue(1, undefined), true);
});

void test('worker cancellation deadline depends only on monotonic time', () => {
  assert.equal(monotonicDeadlineExpired(4_999, 5_000), false);
  assert.equal(monotonicDeadlineExpired(5_000, 5_000), true);
});

void test('a verified heartbeat cannot return before durable persistence', async () => {
  const claim = {
    id: 'claim-1',
    holder: 'Sail A',
    task: 'issue-271',
    acquiredAt: '2026-10-07T10:00:00.000Z',
    heartbeatAt: '2026-10-07T10:01:00.000Z',
    expiresAt: '2026-10-07T10:03:00.000Z',
    status: 'active' as const,
    commentId: 7,
    commentUpdatedAtMillis: Date.parse('2026-10-07T10:01:00.000Z'),
  };
  let releasePersist!: () => void;
  const persisted = new Promise<void>((resolve) => (releasePersist = resolve));
  let returned = false;
  const renewal = persistVerifiedHeartbeat(claim, async () => persisted).then((active) => {
    returned = true;
    return active;
  });

  await Promise.resolve();
  assert.equal(returned, false);
  releasePersist();
  assert.equal(await renewal, true);
  assert.equal(returned, true);
});

void test('launch persistence failure stops worker before claim release', async () => {
  const order: string[] = [];
  const outcome = await persistStartedShippingWorker(
    'acp:codex:session',
    async () => {
      order.push('persist working');
      throw new Error('disk full');
    },
    async () => {
      order.push('stop worker');
    },
    async () => {
      order.push('persist fence');
    },
  );
  assert.deepEqual(order, ['persist working', 'stop worker']);
  assert.equal(outcome?.fencePending, false);

  order.length = 0;
  const fencing = await persistStartedShippingWorker(
    'acp:codex:session',
    async () => {
      order.push('persist working');
      throw new Error('disk full');
    },
    async () => {
      order.push('stop worker');
      throw new Error('worker unavailable');
    },
    async (threadId) => {
      order.push(`persist fence ${threadId}`);
    },
  );
  assert.deepEqual(order, ['persist working', 'stop worker', 'persist fence acp:codex:session']);
  assert.equal(fencing?.fencePending, true);
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

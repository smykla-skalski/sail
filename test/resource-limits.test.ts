import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceQueue } from '../src/lib/resource-queue.ts';
import { isSetting } from '../src/lib/settings.ts';
import {
  acp,
  rememberSessionState,
  sessionState,
  trackLiveTranscript,
  tracksLiveTranscript,
} from '../src/lib/acp.ts';
import { acpPlans } from '../src/lib/acp-plans.ts';
import {
  loadNativePlan,
  loadStructuredQuestions,
  saveNativePlan,
  saveStructuredQuestions,
} from '../src/lib/planning-state.ts';
import {
  defaultResourceLimits,
  pressureReasonsForResults,
  resourceLimitKeys,
  resourceQueues,
  setReefAdmissionEnabled,
} from '../src/lib/resource-limits.ts';
import {
  defaultPressureThresholds,
  parsePressureThreshold,
  pressureBlockers,
  pressureReason,
  type MachineReading,
} from '../src/lib/machine-pressure.ts';

const healthy: MachineReading = {
  totalMemory: 100,
  availableMemory: 20,
  totalSwap: 100,
  usedSwap: 20,
  totalDisk: 100,
  availableDisk: 20,
};

void test('idle Reef admission bypasses agent/browser pressure and restores it when disabled', () => {
  try {
    setReefAdmissionEnabled(true);
    assert.equal(resourceQueues.agent.reason, null);
    assert.equal(resourceQueues.browser.reason, null);
    assert.equal(resourceQueues.validation.reason, 'Checking machine pressure…');
  } finally {
    setReefAdmissionEnabled(false);
  }
  assert.equal(resourceQueues.agent.reason, 'Checking machine pressure…');
  assert.equal(resourceQueues.browser.reason, 'Checking machine pressure…');
});

void test('pressure thresholds include the boundary and recover above it', () => {
  assert.match(
    pressureReason({ ...healthy, availableMemory: 10 }, defaultPressureThresholds)!,
    /free memory at or below 10%/,
  );
  assert.equal(
    pressureReason({ ...healthy, availableMemory: 10.01 }, defaultPressureThresholds),
    null,
  );
  assert.match(
    pressureReason({ ...healthy, usedSwap: 70 }, defaultPressureThresholds)!,
    /swap use at or above 70%/,
  );
  assert.equal(pressureReason({ ...healthy, usedSwap: 69.99 }, defaultPressureThresholds), null);
  assert.match(
    pressureReason({ ...healthy, availableDisk: 2 }, defaultPressureThresholds)!,
    /free disk at or below 2%/,
  );
  assert.equal(
    pressureReason({ ...healthy, availableDisk: 2.01 }, defaultPressureThresholds),
    null,
  );
});

void test('invalid readings queue starts and report every affected reading', () => {
  const reason = pressureReason(
    { ...healthy, totalMemory: 0, usedSwap: 101, availableDisk: -1 },
    defaultPressureThresholds,
  );
  assert.match(reason!, /memory reading unavailable/);
  assert.match(reason!, /swap reading unavailable/);
  assert.match(reason!, /disk reading unavailable/);
  assert.equal(
    pressureReason({ ...healthy, totalSwap: 0, usedSwap: 0 }, defaultPressureThresholds),
    null,
  );
});

void test('pressure blockers separate host readings from workspace disk readings', () => {
  assert.deepEqual(
    pressureBlockers(
      { ...healthy, availableMemory: 10, availableDisk: 2 },
      defaultPressureThresholds,
    ),
    { host: ['free memory at or below 10%'], disk: 'free disk at or below 2%' },
  );
});

void test('configured thresholds parse strictly and zero disables each threshold', () => {
  assert.equal(parsePressureThreshold('0', 10), 0);
  assert.equal(parsePressureThreshold('101', 10), 10);
  assert.equal(parsePressureThreshold('-1', 10), 10);
  assert.equal(
    pressureReason(
      { ...healthy, availableMemory: 0, usedSwap: 100, availableDisk: 0 },
      { memoryFreePercent: 0, swapUsedPercent: 0, diskFreePercent: 0 },
    ),
    null,
  );
  assert.equal(
    pressureReason(
      { ...healthy, totalMemory: 0, usedSwap: 101, totalDisk: 0 },
      { memoryFreePercent: 0, swapUsedPercent: 0, diskFreePercent: 0 },
    ),
    null,
  );
  assert.deepEqual(
    pressureBlockers(
      { ...healthy, totalMemory: 0, usedSwap: 101, totalDisk: 0 },
      { memoryFreePercent: 0, swapUsedPercent: 70, diskFreePercent: 0 },
    ),
    { host: ['swap reading unavailable'], disk: null },
  );
});

void test('failed readings block only enabled pressure checks', () => {
  const failed: PromiseSettledResult<MachineReading>[] = [
    { status: 'rejected', reason: new Error('unavailable') },
  ];
  const directory = ['/workspace'];
  assert.deepEqual(
    pressureReasonsForResults(failed, directory, {
      memoryFreePercent: 0,
      swapUsedPercent: 0,
      diskFreePercent: 0,
    }),
    { reason: null, directoryReasons: new Map() },
  );
  assert.deepEqual(
    pressureReasonsForResults(failed, directory, {
      memoryFreePercent: 0,
      swapUsedPercent: 0,
      diskFreePercent: 2,
    }),
    {
      reason: null,
      directoryReasons: new Map([['/workspace', '/workspace: machine reading unavailable']]),
    },
  );
  assert.deepEqual(
    pressureReasonsForResults(failed, directory, {
      memoryFreePercent: 10,
      swapUsedPercent: 0,
      diskFreePercent: 0,
    }),
    {
      reason: 'Waiting for machine pressure: host readings unavailable.',
      directoryReasons: new Map(),
    },
  );
});

void test('pressure recovery starts queued work without disturbing active work', async () => {
  const queue = new ResourceQueue(2);
  const first = await queue.acquire('active');
  queue.setBlockedReason('Waiting for machine pressure: free disk at or below 2%.');
  const second = queue.acquire('queued');
  assert.equal(await settled(second), false);
  assert.equal(queue.status.active, 1);
  queue.setBlockedReason(null);
  const releaseSecond = await second;
  assert.equal(queue.status.active, 2);
  first();
  releaseSecond();
  assert.equal(queue.status.active, 0);
});

void test('queued work retains its workspace disk until admission', async () => {
  const queue = new ResourceQueue(1, 'Checking machine pressure…');
  const pending = queue.acquire('external', '/Volumes/work');
  assert.deepEqual(queue.waitingDirectories(), ['/Volumes/work']);
  queue.setBlockedReason(null);
  const release = await pending;
  assert.deepEqual(queue.waitingDirectories(), []);
  release();
});

void test('a blocked volume does not delay another volume and recovers in queue order', async () => {
  const queue = new ResourceQueue(1, 'Checking machine pressure…');
  const blocked = queue.acquire('blocked', '/Volumes/full');
  const healthyWork = queue.acquire('healthy', '/Volumes/healthy');
  queue.setDirectoryReasons(new Map([['/Volumes/full', 'Disk pressure on /Volumes/full']]));
  queue.setBlockedReason(null);
  assert.equal(queue.reasonFor('blocked'), 'Disk pressure on /Volumes/full');
  const releaseHealthy = await healthyWork;
  assert.equal(await settled(blocked), false);
  releaseHealthy();
  queue.setDirectoryReasons(new Map());
  const releaseBlocked = await blocked;
  releaseBlocked();
  assert.equal(queue.status.active, 0);
});

void test('cancelled agent connection never reaches process startup', async () => {
  resourceQueues.agent.setBlockedReason(
    'Waiting for machine pressure: free memory at or below 10%.',
  );
  const controller = new AbortController();
  try {
    const pending = acp.connect('codex', '/repo', undefined, { signal: controller.signal });
    assert.equal(await settled(pending), false);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    resourceQueues.agent.setBlockedReason('Checking machine pressure…');
  }
});

void test('E2E job limit loads with user settings, unlike test-only E2E keys', () => {
  assert.equal(isSetting('sai-e2e-job-limit'), true);
  assert.equal(isSetting('sai-e2e-delete-worktree'), false);
});

void test('validation capacity has a durable setting and conservative default', () => {
  assert.equal(isSetting(resourceLimitKeys.validation), true);
  assert.equal(defaultResourceLimits.validation, 1);
  assert.ok(resourceQueues.validation instanceof ResourceQueue);
});

void test('queued agent startup can be cancelled before acquiring a slot', async () => {
  resourceQueues.agent.setLimit(0);
  const limits: (number | null)[] = [];
  try {
    const pending = acp.prompt('codex', '/repo', 'queued-startup', 'prompt', 'turn', [], (limit) =>
      limits.push(limit),
    );
    assert.equal(await settled(pending), false);
    assert.equal(acp.cancelQueuedTurn('codex', '/repo', 'queued-startup', 'turn'), true);
    await assert.rejects(pending, /cancelled/);
    assert.equal(limits[0], 0);
    assert.equal(limits.at(-1), null);
    assert.ok(limits.slice(0, -1).every((limit) => limit === 0));
    assert.equal(resourceQueues.agent.status.active, 0);
  } finally {
    resourceQueues.agent.setLimit(4);
  }
});

void test('Stop cancels queued workspace turns with or without a session', async () => {
  resourceQueues.agent.setLimit(0);
  try {
    const stopQueuedTurn = async (sessionId: string | null) => {
      const pending = acp.acquireTurnSlot('workspace-turn', undefined, '/repo');
      assert.equal(await settled(pending), false);
      assert.equal(acp.cancelQueuedTurn('codex', '/repo', sessionId, 'workspace-turn'), true);
      await assert.rejects(pending, /cancelled/);
      assert.equal(resourceQueues.agent.status.waiting, 0);
    };
    await stopQueuedTurn(null);
    await stopQueuedTurn('existing-session');
    resourceQueues.agent.setLimit(1);
    assert.equal(resourceQueues.agent.status.active, 0);
  } finally {
    resourceQueues.agent.setLimit(4);
  }
});

void test('cancelling a queued owned prompt prevents late dispatch', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const invoked: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'machine_pressure') return healthy;
          invoked.push(command);
          return undefined;
        },
      },
    },
  });
  resourceQueues.agent.setLimit(0);
  try {
    const prompt = acp.prompt('codex', '/repo', 'owned-session', 'work', 'queued-turn');
    assert.equal(await settled(prompt), false);
    await acp.cancel('codex', '/repo', 'owned-session', null);
    resourceQueues.agent.setLimit(1);
    await assert.rejects(prompt, /cancelled/i);
    assert.ok(!invoked.includes('acp_prompt'));
  } finally {
    resourceQueues.agent.setLimit(4);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

void test('closed pane turns run when retained and cancel before deletion', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const settings = new Map<string, string>();
  const invokes: { command: string; waiting: number }[] = [];
  let forgetGate: Promise<void> | undefined;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'machine_pressure') return healthy;
          invokes.push({ command, waiting: resourceQueues.agent.status.waiting });
          if (command === 'acp_forget_session') await forgetGate;
          return undefined;
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => settings.get(key) ?? null,
      setItem: (key: string, value: string) => settings.set(key, value),
    },
  });
  resourceQueues.agent.setLimit(0);
  try {
    const retained = acp.acquireTurnSlot('retained-turn', undefined, '/repo', {
      agent: 'codex',
      sessionId: 'retained-thread',
    });
    assert.equal(await settled(retained), false);
    resourceQueues.agent.setLimit(1);
    const releaseRetained = await retained;
    assert.equal(resourceQueues.agent.status.active, 1);
    releaseRetained();
    resourceQueues.agent.setLimit(0);

    const queued = acp.acquireTurnSlot('closed-pane-turn', undefined, '/repo', {
      agent: 'codex',
      sessionId: 'saved-thread',
    });
    assert.equal(await settled(queued), false);
    assert.equal(resourceQueues.agent.status.waiting, 1);

    // Closing the pane leaves the turn queued; deletion happens after reopening the thread.
    await acp.forget('codex', '/repo', 'saved-thread');
    await assert.rejects(queued, /cancelled/);
    assert.deepEqual(invokes, [{ command: 'acp_forget_session', waiting: 0 }]);
    resourceQueues.agent.setLimit(1);
    assert.equal(resourceQueues.agent.status.active, 0);
    const release = await acp.acquireTurnSlot('granted-turn', undefined, '/repo', {
      agent: 'codex',
      sessionId: 'granted-thread',
    });
    try {
      await acp.forget('codex', '/repo', 'granted-thread');
      await assert.rejects(
        acp.prompt(
          'codex',
          '/repo',
          'granted-thread',
          'late prompt',
          'granted-turn',
          [],
          undefined,
          true,
        ),
        /cancelled/,
      );
    } finally {
      release();
    }

    const scope = { agent: 'codex' as const, directory: '/repo', sessionId: 'saved-state-thread' };
    const nativePlan = {
      provider: 'codex' as const,
      markdown: 'Keep the plan',
      updated: 1,
      tasks: [{ title: 'One step', status: 'pending' }],
    };
    const questions = [
      { id: 'question-1', sessionId: scope.sessionId, message: 'Keep the question?', schema: {} },
    ];
    rememberSessionState(scope.agent, scope.directory, scope.sessionId, { configOptions: [] });
    trackLiveTranscript(scope.agent, scope.directory, scope.sessionId, [], true);
    saveNativePlan(scope, nativePlan);
    saveStructuredQuestions(scope, questions);
    const plans = acpPlans();
    assert.match(
      plans.runTool(scope, 'sail_plan_propose', {
        title: 'Keep history',
        summary: 'A saved plan.',
        sequence: ['User->>Agent: plan', 'Agent-->>User: review'],
        overview: ['Agent[agent] --> Plan[plan]'],
        steps: [{ id: 'step-1', title: 'Work', detail: 'Do the work.', files: ['file.ts'] }],
      }),
      /Plan v1/,
    );
    plans.runTool(scope, 'sail_plan_ask', {
      questions: [{ id: 'question-2', question: 'Proceed?', kind: 'confirm' }],
    });
    const savedPlan = plans.snapshot(scope);
    const savedHistory = plans.history(scope);
    assert.equal(savedHistory.length, 1);

    let rejectForget: ((error: Error) => void) | undefined;
    forgetGate = new Promise<void>((_resolve, reject) => {
      rejectForget = reject;
    });
    const failedForget = acp.forget(scope.agent, scope.directory, scope.sessionId);
    assert.equal(
      sessionState(scope.agent, scope.directory, scope.sessionId)?.configOptions?.length,
      0,
    );
    assert.equal(tracksLiveTranscript(scope.agent, scope.directory, scope.sessionId), true);
    assert.deepEqual(loadNativePlan(scope), nativePlan);
    assert.deepEqual(loadStructuredQuestions(scope), questions);
    assert.deepEqual(plans.snapshot(scope), savedPlan);
    assert.deepEqual(plans.history(scope), savedHistory);
    rejectForget!(new Error('cancel timed out'));
    await assert.rejects(failedForget, /cancel timed out/);
    assert.equal(tracksLiveTranscript(scope.agent, scope.directory, scope.sessionId), true);
    assert.deepEqual(loadNativePlan(scope), nativePlan);
    assert.deepEqual(loadStructuredQuestions(scope), questions);
    assert.deepEqual(plans.snapshot(scope), savedPlan);
    assert.deepEqual(plans.history(scope), savedHistory);

    forgetGate = undefined;
    await acp.forget(scope.agent, scope.directory, scope.sessionId);
    assert.equal(sessionState(scope.agent, scope.directory, scope.sessionId), undefined);
    assert.equal(tracksLiveTranscript(scope.agent, scope.directory, scope.sessionId), false);
    assert.equal(loadNativePlan(scope), null);
    assert.deepEqual(loadStructuredQuestions(scope), []);
    assert.deepEqual(plans.snapshot(scope), { plan: null, questions: null });
    assert.deepEqual(plans.history(scope), []);
  } finally {
    resourceQueues.agent.setLimit(4);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

async function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
  ]);
}

void test('zero pauses new work and cancellation never starts it', async () => {
  const queue = new ResourceQueue(0);
  const pending = queue.acquire('first');
  assert.equal(await settled(pending), false);
  assert.deepEqual(queue.status, { active: 0, waiting: 1, limit: 0 });
  assert.equal(queue.cancel('first'), true);
  await assert.rejects(pending, /cancelled/);
  queue.setLimit(1);
  assert.equal(queue.status.active, 0);
});

void test('one slot starts queued work in launch order', async () => {
  const queue = new ResourceQueue(1);
  const first = await queue.acquire('first');
  const second = queue.acquire('second');
  const third = queue.acquire('third');
  assert.equal(await settled(second), false);
  first();
  const releaseSecond = await second;
  assert.equal(await settled(third), false);
  releaseSecond();
  (await third)();
  assert.deepEqual(queue.status, { active: 0, waiting: 0, limit: 1 });
});

void test('the configured maximum runs and one above it waits', async () => {
  const queue = new ResourceQueue(3);
  const releases = await Promise.all([0, 1, 2].map((index) => queue.acquire(String(index))));
  const extra = queue.acquire('extra');
  assert.deepEqual(queue.status, { active: 3, waiting: 1, limit: 3 });
  releases[0]();
  const releaseExtra = await extra;
  releases[1]();
  releases[2]();
  releaseExtra();
  assert.equal(queue.status.active, 0);
});

void test('lowering a limit keeps active work and blocks new starts', async () => {
  const queue = new ResourceQueue(2);
  const first = await queue.acquire('first');
  const second = await queue.acquire('second');
  queue.setLimit(1);
  const third = queue.acquire('third');
  first();
  assert.equal(await settled(third), false);
  second();
  (await third)();
  assert.equal(queue.status.active, 0);
});

void test('restored work holds capacity until its receipt releases it', async () => {
  const queue = new ResourceQueue(1);
  queue.restoreActive('restored');
  queue.restoreActive('restored');
  assert.deepEqual(queue.status, { active: 1, waiting: 0, limit: 1 });
  assert.equal(queue.isActive('restored'), true);

  const pending = queue.acquire('queued');
  assert.equal(await settled(pending), false);
  assert.equal(queue.release('restored'), true);
  assert.equal(queue.release('restored'), false);
  const release = await pending;
  assert.equal(queue.isActive('queued'), true);
  release();
  assert.deepEqual(queue.status, { active: 0, waiting: 0, limit: 1 });
});

void test('cancelled capacity never starts after an active receipt releases', async () => {
  const queue = new ResourceQueue(1);
  const releaseActive = await queue.acquire('active');
  const cancelled = queue.acquire('cancelled');
  assert.equal(queue.cancel('cancelled'), true);
  await assert.rejects(cancelled, /cancelled/);
  releaseActive();
  assert.deepEqual(queue.status, { active: 0, waiting: 0, limit: 1 });
});

void test('capacity request identifiers cannot be active or queued twice', async () => {
  const queue = new ResourceQueue(1);
  const release = await queue.acquire('same');
  await assert.rejects(queue.acquire('same'), /already exists/);
  const waiting = queue.acquire('waiting');
  await assert.rejects(queue.acquire('waiting'), /already exists/);
  assert.equal(queue.cancel('waiting'), true);
  await assert.rejects(waiting, /cancelled/);
  release();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PermissionRequest } from '@opencode/client';
import { OpenCodePermissionRejectionCoordinator } from '../src/lib/opencode-permission-resolution.ts';

function permission(id: string, sessionID = 'session-1'): PermissionRequest {
  return { id, sessionID, action: 'read', resources: [`/workspace/${id}`] };
}

await test('session rejection audits requests whose events arrive on the next macrotask', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected');
  const arrivedDuringReply = permission('arrived-during-reply');
  const recorded: string[] = [];

  const settled = await coordinator.reject({
    selected,
    list: async () => [selected],
    reply: async () => {
      setTimeout(() => {
        coordinator.settle('session-1', arrivedDuringReply.id, 'reject');
        coordinator.observe(arrivedDuringReply);
        coordinator.settle('session-1', selected.id, 'reject');
      }, 0);
    },
    record: (request) => recorded.push(request.id),
  });

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected', 'arrived-during-reply'],
  );
  assert.deepEqual(recorded, ['arrived-during-reply', 'selected']);
});

await test('manual allow records an authoritative event when the HTTP response is lost', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const allowed = permission('allowed-before-response-loss');
  const recorded: string[] = [];

  await assert.rejects(
    coordinator.resolvePendingAutomatically(
      {
        selected: allowed,
        decision: 'always',
        reply: async () => {
          coordinator.settle(allowed.sessionID, allowed.id, 'always');
          throw new Error('response lost');
        },
        record: (request, reply) => recorded.push(`${request.id}:${reply}`),
      },
      () => false,
    ),
    /response lost/,
  );

  assert.deepEqual(recorded, ['allowed-before-response-loss:always']);
});

await test('stale manual allow preserves an authoritative rejection', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const rejected = permission('rejected-before-stale-allow');
  const recorded: string[] = [];

  const pending = await coordinator.resolvePendingAutomatically(
    {
      selected: rejected,
      decision: 'once',
      reply: async () => {
        coordinator.settle(rejected.sessionID, rejected.id, 'reject');
        throw new Error('permission not found');
      },
      record: (request, reply) => recorded.push(`${request.id}:${reply}`),
    },
    (cause) => cause instanceof Error && cause.message === 'permission not found',
  );

  assert.equal(pending, false);
  assert.deepEqual(recorded, ['rejected-before-stale-allow:reject']);
});

await test('reconnect inventory settles a rejection whose reply event was lost', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-during-disconnect');
  const inventories = [
    async () => [selected],
    async () => {
      throw new Error('event stream disconnected');
    },
  ];
  const recorded: string[] = [];
  let finished = false;
  const rejection = coordinator
    .reject({
      selected,
      list: () => inventories.shift()!(),
      reply: async () => undefined,
      record: (request) => recorded.push(request.id),
    })
    .then((settled) => {
      finished = true;
      return settled;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(finished, false);

  await coordinator.reconcile(async () => []);
  const settled = await rejection;

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected-during-disconnect'],
  );
  assert.deepEqual(recorded, ['selected-during-disconnect']);
});

await test('session rejection waits for a delayed authoritative allow', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-delayed-allow');
  const allowed = permission('allowed-after-macrotask');
  const recorded: string[] = [];
  let finished = false;
  const rejection = coordinator
    .reject({
      selected,
      list: async () => [selected, allowed],
      reply: async () => undefined,
      record: (request) => recorded.push(request.id),
    })
    .then((settled) => {
      finished = true;
      return settled;
    });

  coordinator.settle(selected.sessionID, selected.id, 'reject');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(finished, false);
  assert.deepEqual(recorded, ['selected-delayed-allow']);

  coordinator.settle(allowed.sessionID, allowed.id, 'once');
  const settled = await rejection;

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected-delayed-allow'],
  );
  assert.deepEqual(recorded, ['selected-delayed-allow']);
});

await test('session rejection excludes requests replied while rejection is pending', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected');
  const separatelyReplied = permission('separately-replied');
  const recorded: string[] = [];

  const settled = await coordinator.reject({
    selected,
    list: async () => [selected, separatelyReplied],
    reply: async () => {
      coordinator.settle('session-1', 'separately-replied', 'once');
      coordinator.settle('session-1', selected.id, 'reject');
    },
    record: (request) => recorded.push(request.id),
  });

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected'],
  );
  assert.deepEqual(recorded, ['selected']);
});

await test('successful allow reply is authoritative before its delayed event', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const rejected = permission('rejected-before-delayed-allow');
  const allowed = permission('allowed-before-delayed-event');
  const recorded: string[] = [];
  let inventory = 0;

  const rejection = coordinator.reject({
    selected: rejected,
    list: async () => (inventory++ === 0 ? [rejected, allowed] : []),
    reply: async () => {
      coordinator.settle(rejected.sessionID, rejected.id, 'reject');
      await coordinator.resolveAutomatically({
        selected: allowed,
        decision: 'once',
        reply: async () => undefined,
        record: (request, reply) => recorded.push(`${request.id}:${reply}`),
      });
    },
    record: (request) => recorded.push(`${request.id}:reject`),
  });

  const settled = await rejection;
  coordinator.settle(allowed.sessionID, allowed.id, 'once');

  assert.deepEqual(
    settled.map((request) => request.id),
    ['rejected-before-delayed-allow'],
  );
  assert.deepEqual(recorded, [
    'allowed-before-delayed-event:once',
    'rejected-before-delayed-allow:reject',
  ]);
});

await test('session rejection audits events delivered after the rejection request returns', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-late');
  const arrivedLater = permission('arrived-later');
  const recorded: string[] = [];

  await coordinator.reject({
    selected,
    list: async () => [selected],
    reply: async () => coordinator.settle('session-1', selected.id, 'reject'),
    record: (request) => recorded.push(request.id),
  });
  coordinator.settle('session-1', selected.id, 'reject');
  coordinator.settle('session-1', arrivedLater.id, 'reject');
  coordinator.observe(arrivedLater);

  assert.deepEqual(recorded, ['selected-late', 'arrived-later']);
});

await test('stale inventory cannot relabel an allowed request as rejected', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-stale-list');
  const allowed = permission('allowed-during-list');
  const inventory = Promise.withResolvers<PermissionRequest[]>();
  const recorded: string[] = [];

  const rejection = coordinator.reject({
    selected,
    list: () => inventory.promise,
    reply: async () => undefined,
    record: (request) => recorded.push(request.id),
  });
  coordinator.settle('session-1', allowed.id, 'once');
  coordinator.observe(allowed);
  inventory.resolve([selected, allowed]);
  coordinator.settle('session-1', selected.id, 'reject');
  const settled = await rejection;

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected-stale-list'],
  );
  assert.deepEqual(recorded, ['selected-stale-list']);
});

await test('an earlier allow remains authoritative for a later stale rejection inventory', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-after-allow');
  const allowed = permission('allowed-before-rejection');
  const recorded: string[] = [];

  coordinator.observe(allowed);
  coordinator.settle('session-1', allowed.id, 'once');
  const settled = await coordinator.reject({
    selected,
    list: async () => [selected, allowed],
    reply: async () => coordinator.settle('session-1', selected.id, 'reject'),
    record: (request) => recorded.push(request.id),
  });

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected-after-allow'],
  );
  assert.deepEqual(recorded, ['selected-after-allow']);
});

await test('expired allow decisions cannot be relabeled by stale inventory', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator({ maxRequests: 1 });
  const selected = permission('selected-bounded');
  const expired = permission('allowed-expired');
  const retained = permission('allowed-retained');
  const recorded: string[] = [];

  coordinator.settle('session-1', expired.id, 'once');
  coordinator.settle('session-1', retained.id, 'once');
  const settled = await coordinator.reject({
    selected,
    list: async () => [selected, expired, retained],
    reply: async () => coordinator.settle('session-1', selected.id, 'reject'),
    record: (request) => recorded.push(request.id),
  });

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected-bounded'],
  );
  assert.deepEqual(recorded, ['selected-bounded']);
});

await test('overflowed tombstone history fails closed for every session', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator({ maxSessions: 1 });
  coordinator.settle('expired-session', 'allowed-expired', 'once');
  coordinator.settle('retained-session', 'allowed-retained', 'once');
  coordinator.settle('overflow-session', 'allowed-overflow', 'once');
  const selected = permission('selected-fresh', 'fresh-session');
  const collateral = permission('collateral-fresh', 'fresh-session');
  const recorded: string[] = [];

  const settled = await coordinator.reject({
    selected,
    list: async () => [selected, collateral],
    reply: async () => coordinator.settle('fresh-session', selected.id, 'reject'),
    record: (request) => recorded.push(request.id),
  });

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected-fresh'],
  );
  assert.deepEqual(recorded, ['selected-fresh']);
});

await test('failed inventory reads discard rejection settlement state', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-list-failure', 'session-list-failure');
  const recorded: string[] = [];

  await assert.rejects(
    coordinator.reject({
      selected,
      list: async () => {
        throw new Error('list failed');
      },
      reply: async () => undefined,
      record: (request) => recorded.push(request.id),
    }),
    /list failed/,
  );
  coordinator.settle(selected.sessionID, selected.id, 'reject');
  coordinator.observe(selected);

  assert.deepEqual(recorded, []);
});

await test('confirmed rejection events survive an ambiguous reply failure', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-reply-failure', 'session-reply-failure');
  const recorded: string[] = [];

  await assert.rejects(
    coordinator.reject({
      selected,
      list: async () => [selected],
      reply: async () => {
        coordinator.settle(selected.sessionID, selected.id, 'reject');
        throw new Error('reply failed');
      },
      record: (request) => recorded.push(request.id),
    }),
    /reply failed/,
  );

  assert.deepEqual(recorded, ['selected-reply-failure']);
});

await test('failed reply transactions audit rejection events delivered later', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const selected = permission('selected-late-failure', 'session-late-failure');
  const recorded: string[] = [];

  await assert.rejects(
    coordinator.reject({
      selected,
      list: async () => [selected],
      reply: async () => {
        throw new Error('reply failed');
      },
      record: (request) => recorded.push(request.id),
    }),
    /reply failed/,
  );
  coordinator.settle(selected.sessionID, selected.id, 'reject');
  coordinator.observe(selected);

  assert.deepEqual(recorded, ['selected-late-failure']);
});

await test('ambiguous reply eviction retains a fallback audit path', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator({ maxSessions: 1 });
  const first = permission('first-capacity', 'session-first-capacity');
  const second = permission('second-capacity', 'session-second-capacity');
  const recorded: string[] = [];

  await assert.rejects(
    coordinator.reject({
      selected: first,
      list: async () => [first],
      reply: async () => {
        throw new Error('reply failed');
      },
      record: (request) => recorded.push(request.id),
    }),
    /reply failed/,
  );
  await assert.rejects(
    coordinator.reject({
      selected: second,
      list: async () => [second],
      reply: async () => {
        throw new Error('reply failed');
      },
      record: (request) => recorded.push(request.id),
    }),
    /reply failed/,
  );
  coordinator.settle(first.sessionID, first.id, 'reject', (request) => recorded.push(request.id));

  assert.deepEqual(recorded, ['first-capacity']);
});

await test('129 failed reply sessions retain the evicted session audit context', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator();
  const requests = Array.from({ length: 129 }, (_, index) =>
    permission(`request-${index}`, `session-${index}`),
  );
  const recorded: string[] = [];

  await Promise.all(
    requests.map((selected) =>
      assert.rejects(
        coordinator.reject({
          selected,
          list: async () => [selected],
          reply: async () => {
            throw new Error('reply failed');
          },
          record: (request) => recorded.push(request.id),
        }),
        /reply failed/,
      ),
    ),
  );
  coordinator.observe(requests[0]);
  coordinator.settle(requests[0].sessionID, requests[0].id, 'reject');

  assert.deepEqual(recorded, ['request-0']);
});

await test('confirmed failed replies survive completed-context eviction', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator({ maxSessions: 1 });
  const first = permission('first-ambiguous', 'session-first');
  const second = permission('second-complete', 'session-second');
  const firstRecorded: string[] = [];
  const secondRecorded: string[] = [];

  await assert.rejects(
    coordinator.reject({
      selected: first,
      list: async () => [first],
      reply: async () => {
        throw new Error('reply failed');
      },
      record: (request) => firstRecorded.push(request.id),
    }),
    /reply failed/,
  );
  await coordinator.reject({
    selected: second,
    list: async () => [second],
    reply: async () => coordinator.settle(second.sessionID, second.id, 'reject'),
    record: (request) => secondRecorded.push(request.id),
  });

  coordinator.settle(first.sessionID, first.id, 'reject');

  assert.deepEqual(firstRecorded, ['first-ambiguous']);
  assert.deepEqual(secondRecorded, ['second-complete']);
});

await test('session ambiguity survives bounded tombstone churn', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator({ maxSessions: 1 });
  const recorded: string[] = [];
  coordinator.settle('session-a', 'allowed-a', 'once');
  coordinator.settle('session-b', 'allowed-b', 'once');
  coordinator.settle('session-c', 'allowed-c', 'once');
  const selected = permission('selected-a', 'session-a');
  const staleAllowed = permission('allowed-a', 'session-a');

  const settled = await coordinator.reject({
    selected,
    list: async () => [selected, staleAllowed],
    reply: async () => coordinator.settle(selected.sessionID, selected.id, 'reject'),
    record: (request) => recorded.push(request.id),
  });

  assert.deepEqual(
    settled.map((request) => request.id),
    ['selected-a'],
  );
  assert.deepEqual(recorded, ['selected-a']);
});

await test('concurrent rejection transactions retain late permission events', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator({ maxSessions: 128 });
  const inventories = Array.from({ length: 129 }, () =>
    Promise.withResolvers<PermissionRequest[]>(),
  );
  const recorded: string[][] = Array.from({ length: 129 }, () => []);
  const selected = Array.from({ length: 129 }, (_, index) =>
    permission(`selected-${index}`, `session-${index}`),
  );
  const arrivedLate = permission('arrived-late', 'session-0');

  const rejections = selected.map((request, index) =>
    coordinator.reject({
      selected: request,
      list: () => inventories[index].promise,
      reply: async () => undefined,
      record: (settled) => recorded[index].push(settled.id),
    }),
  );
  selected.forEach((request, index) => inventories[index].resolve([request]));
  coordinator.settle('session-0', arrivedLate.id, 'reject');
  coordinator.observe(arrivedLate);
  selected.forEach((request) => coordinator.settle(request.sessionID, request.id, 'reject'));
  await Promise.all(rejections);

  assert.deepEqual(recorded[0], ['arrived-late', 'selected-0']);
});

await test('completed rejection contexts expire after the bounded session window', async () => {
  const coordinator = new OpenCodePermissionRejectionCoordinator({ maxSessions: 1 });
  const firstRecorded: string[] = [];
  const secondRecorded: string[] = [];
  const first = permission('first-selected', 'session-1');
  const second = permission('second-selected', 'session-2');
  const expiredLate = permission('first-late', 'session-1');

  await coordinator.reject({
    selected: first,
    list: async () => [first],
    reply: async () => coordinator.settle(first.sessionID, first.id, 'reject'),
    record: (request) => firstRecorded.push(request.id),
  });
  await coordinator.reject({
    selected: second,
    list: async () => [second],
    reply: async () => coordinator.settle(second.sessionID, second.id, 'reject'),
    record: (request) => secondRecorded.push(request.id),
  });
  coordinator.settle('session-1', expiredLate.id, 'reject');
  coordinator.observe(expiredLate);

  assert.deepEqual(firstRecorded, ['first-selected']);
  assert.deepEqual(secondRecorded, ['second-selected']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentPermission } from '../src/lib/acp.ts';
import {
  enqueueAcpPermission,
  fencedAcpPermissionInventory,
  reconcileRejectedAcpPermission,
  removeResolvedAcpPermission,
} from '../src/lib/acp-permissions.ts';

function permission(generation: number, fingerprint: string): AgentPermission {
  return {
    id: 7,
    sessionId: 'session-1',
    title: `Request ${generation}`,
    options: [],
    generation,
    fingerprint,
  };
}

void test('reused request IDs remain visible until their matching generation resolves', () => {
  const oldRequest = permission(1, 'old-fingerprint');
  const newRequest = permission(2, 'new-fingerprint');
  const queued = enqueueAcpPermission([oldRequest], newRequest);

  const remaining = removeResolvedAcpPermission(queued, oldRequest);

  assert.deepEqual(remaining, [newRequest]);
});

void test('duplicate events for one permission identity remain deduplicated', () => {
  const request = permission(1, 'same-fingerprint');

  const queued = enqueueAcpPermission([request], request);

  assert.deepEqual(queued, [request]);
});

await test('inventory retries when a permission resolves while its snapshot is in flight', async () => {
  const stale = permission(1, 'stale-fingerprint');
  const current = permission(2, 'current-fingerprint');
  const firstInventory = Promise.withResolvers<AgentPermission[]>();
  let revision = 0;
  let loads = 0;

  const inventory = fencedAcpPermissionInventory(
    () => (++loads === 1 ? firstInventory.promise : Promise.resolve([current])),
    () => revision,
    () => true,
  );
  revision++;
  firstInventory.resolve([stale]);

  assert.deepEqual(await inventory, [current]);
  assert.equal(loads, 2);
});

void test('backend rejection removes only the stale permission identity', () => {
  const stale = permission(1, 'stale-fingerprint');
  const current = permission(2, 'current-fingerprint');

  const reconciled = reconcileRejectedAcpPermission([stale, current], stale, [current]);

  assert.deepEqual(reconciled, [current]);
});

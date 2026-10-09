import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticPermissionPolicy, permissionPolicy } from '../src/lib/capability-profiles.ts';
import {
  assertAutomaticPermissionAllowed,
  AutomaticPermissionResolver,
  permissionChoiceForPolicy,
} from '../src/lib/permission-resolution.ts';

const allowOnce = [
  { optionId: 'allow-background', kind: 'allow_once' },
  { optionId: 'deny-background', kind: 'reject_once' },
];

await test('background permission resolves and records without a mounted conversation', async () => {
  const resolver = new AutomaticPermissionResolver();
  let pending = true;
  const durableAudit: { optionId: string; outcome: string }[] = [];
  const policy = permissionPolicy({
    profile: 'explore',
    workspace: '/workspace',
    title: 'Read file',
    toolCall: { name: 'read', rawInput: { file_path: '/workspace/README.md' } },
    options: allowOnce,
    resourceTrust: { trusted: true, canonicalResources: ['/workspace/README.md'] },
  });

  const resolved = await resolver.resolve({
    key: 'acp:background:request-1',
    generation: 1,
    policy,
    respond: async (optionId) => {
      assert.equal(optionId, 'allow-background');
      pending = false;
    },
    record: (optionId) => durableAudit.push({ optionId, outcome: 'completed' }),
  });

  assert.equal(resolved, true);
  assert.equal(pending, false);
  assert.deepEqual(durableAudit, [{ optionId: 'allow-background', outcome: 'completed' }]);
});

await test('concurrent inventory and mounted refresh cannot resolve a request twice', async () => {
  const resolver = new AutomaticPermissionResolver();
  const response = Promise.withResolvers<void>();
  let providerResponses = 0;
  const durableAudit: string[] = [];
  const request = {
    key: 'opencode:permission:request-2',
    generation: 1,
    policy: permissionPolicy({
      profile: 'explore' as const,
      workspace: '/workspace',
      title: 'Read file',
      toolCall: { action: 'read', resources: ['/workspace/README.md'] },
      options: allowOnce,
      resourceTrust: { trusted: true, canonicalResources: ['/workspace/README.md'] },
    }),
    respond: async () => {
      providerResponses++;
      await response.promise;
    },
    record: () => durableAudit.push('completed'),
  };

  const first = resolver.resolve(request);
  const duplicate = resolver.resolve(request);
  response.resolve();
  await Promise.all([first, duplicate]);
  await resolver.resolve(request);

  assert.equal(providerResponses, 1);
  assert.deepEqual(durableAudit, ['completed']);
});

await test('failed automatic resolution remains retryable and unaudited', async () => {
  const resolver = new AutomaticPermissionResolver();
  let fail = true;
  const durableAudit: string[] = [];
  const request = {
    key: 'acp:background:request-3',
    generation: 1,
    policy: permissionPolicy({
      profile: 'review' as const,
      workspace: '/workspace',
      title: 'Edit file',
      toolCall: { action: 'edit', resources: ['/workspace/file.ts'] },
      options: allowOnce,
    }),
    respond: async () => {
      if (fail) throw new Error('provider unavailable');
    },
    record: () => durableAudit.push('rejected'),
  };

  await assert.rejects(resolver.resolve(request), /provider unavailable/);
  fail = false;
  assert.equal(await resolver.resolve(request), true);

  assert.deepEqual(durableAudit, ['rejected']);
});

await test('skipped automatic resolution remains visible and retryable', async () => {
  const resolver = new AutomaticPermissionResolver();
  let safe = false;
  let responses = 0;
  let records = 0;
  const request = {
    key: 'opencode:permission:changing-inventory',
    generation: 1,
    policy: permissionPolicy({
      profile: 'review' as const,
      workspace: '/workspace',
      title: 'Edit file',
      toolCall: { action: 'edit', resources: ['/workspace/file.ts'] },
      options: allowOnce,
    }),
    respond: async () => {
      responses++;
      return safe;
    },
    record: () => records++,
  };

  assert.equal(await resolver.resolve(request), false);
  safe = true;
  assert.equal(await resolver.resolve(request), true);
  assert.equal(responses, 2);
  assert.equal(records, 1);
});

await test('reused provider request IDs resolve again in a new generation', async () => {
  const resolver = new AutomaticPermissionResolver();
  let providerResponses = 0;
  const policy = permissionPolicy({
    profile: 'explore',
    workspace: '/workspace',
    title: 'Read file',
    toolCall: { name: 'read', rawInput: { file_path: '/workspace/README.md' } },
    options: allowOnce,
    resourceTrust: { trusted: true, canonicalResources: ['/workspace/README.md'] },
  });
  const request = (generation: number) => ({
    key: 'acp:agent:session:reused-id',
    generation,
    policy,
    respond: async () => {
      providerResponses++;
    },
    record: () => undefined,
  });

  await resolver.resolve(request(1));
  await resolver.resolve(request(2));

  assert.equal(providerResponses, 2);
});

await test('provider-added read paths stop an already scheduled automatic approval', () => {
  const initialPolicy = automaticPermissionPolicy({
    profile: 'explore',
    workspace: '/workspace',
    title: 'read',
    toolCall: { action: 'read', resources: [] },
    options: allowOnce,
    resourceTrust: { trusted: true, canonicalResources: [] },
  });

  assert.equal(initialPolicy.recommendation, 'allow');
  assert.throws(
    () =>
      assertAutomaticPermissionAllowed(
        {
          profile: 'explore',
          workspace: '/workspace',
          title: 'read',
          toolCall: { action: 'read', resources: ['README.md'] },
          options: allowOnce,
          resourceTrust: {
            trusted: true,
            canonicalResources: ['/workspace/README.md'],
          },
        },
        'allow-background',
      ),
    /Permission resource changed before automatic approval/,
  );
});

await test('a stale allow choice becomes the live policy rejection', () => {
  const reviewPolicy = permissionPolicy({
    profile: 'review',
    workspace: '/workspace',
    title: 'Edit file',
    toolCall: { action: 'edit', resources: ['/workspace/file.ts'] },
    options: allowOnce,
  });

  assert.equal(reviewPolicy.recommendation, 'deny');
  assert.equal(
    permissionChoiceForPolicy(reviewPolicy, allowOnce, 'allow-background'),
    'deny-background',
  );
  assert.equal(permissionChoiceForPolicy(reviewPolicy, [], 'allow-background'), null);
});

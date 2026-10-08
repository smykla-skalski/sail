import assert from 'node:assert/strict';
import test from 'node:test';
import {
  automaticPermissionPolicy,
  CapabilityProfileReservationCoordinator,
  capabilityProfileForPhase,
  capabilityProfileForRuntime,
  capabilityProfileFromMetadata,
  classifyPermission,
  conflictingCapabilityProfiles,
  exploreSessionMetadata,
  holdCapabilityProfileReservation,
  openCodePermissionToolCall,
  permissionPolicy,
  permissionReadResources,
  permissionOutcome,
  settledOpenCodePermissions,
  withCapabilityProfileReservation,
} from '../src/lib/capability-profiles.ts';

const options = [
  { optionId: 'yes', kind: 'allow_once' },
  { optionId: 'no', kind: 'reject_once' },
];

await test('classifies raw permission calls before deciding', () => {
  assert.equal(classifyPermission({ command: "cat $'/etc/'shadow" }, 'Run command'), 'unknown');
  assert.equal(
    classifyPermission({ command: "cat '/workspace/'README.md" }, 'Run command'),
    'unknown',
  );
  assert.equal(classifyPermission({ command: 'cat $SECRET_FILE' }, 'Run command'), 'unknown');
  assert.equal(classifyPermission({ command: 'cat secret-*' }, 'Run command'), 'high');
  assert.equal(classifyPermission({ command: 'cat safe\\ path' }, 'Run command'), 'unknown');
  assert.equal(classifyPermission({ command: 'git status --short' }, 'Run command'), 'unknown');
  assert.equal(classifyPermission({ command: 'apply_patch' }, 'Edit file'), 'medium');
  assert.equal(classifyPermission({ command: 'git reset --hard' }, 'Run command'), 'high');
  assert.equal(
    classifyPermission({ command: "GIT_EXTERNAL_DIFF='rm -f' git diff" }, 'Run command'),
    'high',
  );
  assert.equal(classifyPermission({ command: 'NO_COLOR=1 git status' }, 'Run command'), 'high');
  assert.equal(
    classifyPermission({ command: 'git diff --output=important.txt' }, 'Run command'),
    'medium',
  );
  assert.equal(classifyPermission({ command: 'git diff --ext-diff' }, 'Run command'), 'high');
  assert.equal(
    classifyPermission(
      { command: 'git -c diff.external=/tmp/payload diff --ext-diff' },
      'Run command',
    ),
    'high',
  );
  assert.equal(classifyPermission({ command: 'git diff' }, 'Run command'), 'unknown');
  assert.equal(
    classifyPermission({ command: 'rg --pre=/bin/rm needle important.txt' }, 'Run command'),
    'high',
  );
  assert.equal(
    classifyPermission({ command: 'rg --hostname-bin=/bin/rm needle' }, 'Run command'),
    'high',
  );
  assert.equal(
    classifyPermission({ command: 'git branch -D unmerged-work' }, 'Run command'),
    'high',
  );
  assert.equal(
    classifyPermission({ command: 'git branch --delete merged-work' }, 'Run command'),
    'high',
  );
  assert.equal(
    classifyPermission({ command: 'git branch -f backup HEAD~100' }, 'Run command'),
    'unknown',
  );
  assert.equal(classifyPermission({ command: 'git branch new-work' }, 'Run command'), 'unknown');
  assert.equal(
    classifyPermission({ command: 'git branch --merged main' }, 'Run command'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ command: "sed -n -i.bak '1p' important.txt" }, 'Run command'),
    'medium',
  );
  assert.equal(
    classifyPermission({ command: "sed -ni '1p' important.txt" }, 'Run command'),
    'medium',
  );
  assert.equal(
    classifyPermission({ command: "sed -n 'w /tmp/output' input" }, 'Run command'),
    'unknown',
  );
  assert.equal(classifyPermission({ command: 'find . -delete' }, 'Run command'), 'high');
  assert.equal(classifyPermission(['find', 'victim', '-delete'], 'Run command'), 'high');
  assert.equal(
    classifyPermission({ command: 'find . -type f -execdir rm {} +' }, 'Run command'),
    'high',
  );
  assert.equal(
    classifyPermission({ command: 'git status && npm install untrusted' }, 'Run command'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ command: 'cargo test; touch /tmp/policy-bypass' }, 'Run command'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ command: 'git status && touch /tmp/policy-bypass' }, 'Run command'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ command: 'git status & touch /tmp/policy-bypass' }, 'Run command'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ command: "sh -c 'rm important.txt' git diff" }, 'Run command'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ command: 'unknown-command', description: 'git status' }, 'Read file'),
    'unknown',
  );
  assert.equal(
    classifyPermission(
      { title: 'git status', rawInput: { command: 'rm important.txt' } },
      'Run command',
    ),
    'unknown',
  );
  assert.equal(
    classifyPermission(
      { action: 'bash', message: 'git status', resources: ['rm important.txt'] },
      'Run command',
    ),
    'unknown',
  );
  assert.equal(
    classifyPermission({ action: 'read', command: 'rm important.txt' }, 'Run command'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ action: 'read', command: ['rm', '-rf', 'victim'] }, 'Run command'),
    'high',
  );
  assert.equal(
    classifyPermission({ action: 'read', message: 'Read release notes' }, 'Run command'),
    'low',
  );
  assert.equal(
    classifyPermission({ action: 'read', resources: ['~/.ssh/id_rsa'] }, 'Read file'),
    'high',
  );
  assert.equal(
    classifyPermission({ action: 'read', resources: ['README.md'] }, 'Read file', undefined, {
      trusted: true,
      canonicalResources: [],
    }),
    'low',
  );
  assert.equal(
    classifyPermission({ name: 'read', rawInput: { file_path: '~/.ssh/id_ed25519' } }, 'Read file'),
    'high',
  );
  assert.equal(
    classifyPermission(
      { name: 'read', rawInput: { file_path: 'README.md' } },
      'Read file',
      undefined,
      { trusted: true, canonicalResources: [] },
    ),
    'low',
  );
  assert.equal(
    classifyPermission(
      { name: 'read', arguments: { command: 'touch /tmp/unexpected' } },
      'Run command',
    ),
    'unknown',
  );
  assert.equal(classifyPermission({ name: 'provider-specific-action' }, 'Do thing'), 'unknown');
  assert.equal(
    classifyPermission({ command: `${'x'.repeat(20_000)} rm -rf build` }, 'Read file'),
    'high',
  );
});

await test('keeps dependency and project code execution interactive in the build profile', async (t) => {
  const cases = [
    { name: 'package lifecycle scripts', toolCall: { command: 'npm install' } },
    { name: 'npm project scripts', toolCall: { command: 'npm run build' } },
    { name: 'pnpm project scripts', toolCall: { command: 'pnpm run generate' } },
    { name: 'Yarn project scripts', toolCall: { command: 'yarn run compile' } },
    { name: 'Bun project scripts', toolCall: { command: 'bun run bundle' } },
    { name: 'build scripts', toolCall: { command: 'cargo build' } },
    { name: 'test actions', toolCall: { action: 'test' } },
  ];

  await Promise.all(
    cases.map((testCase) =>
      t.test(testCase.name, () => {
        const decision = permissionPolicy({
          profile: 'build',
          workspace: '/workspace',
          title: 'Run command',
          toolCall: testCase.toolCall,
          options,
        });

        assert.equal(decision.risk, 'high');
        assert.equal(decision.recommendation, 'interactive');
        assert.equal(decision.optionId, undefined);
      }),
    ),
  );
});

await test('classifies OpenCode permission metadata as security input', () => {
  const toolCall = openCodePermissionToolCall({
    action: 'read',
    resources: [],
    metadata: { command: ['rm', '-rf', 'victim'] },
  });

  assert.equal(classifyPermission(toolCall, 'read'), 'high');
  assert.equal(
    automaticPermissionPolicy({
      profile: 'explore',
      workspace: '/workspace',
      title: 'read',
      toolCall,
      options,
    }).recommendation,
    'interactive',
  );
});

await test('canonical resource inspection blocks escaped and sensitive reads', () => {
  assert.deepEqual(permissionReadResources({ command: 'cat linked-secret' }), ['linked-secret']);
  const toolCall = { name: 'read', rawInput: { file_path: '/workspace/link' } };
  assert.equal(
    classifyPermission(toolCall, 'Read file', '/workspace', {
      trusted: false,
      canonicalResources: ['/etc/shadow'],
    }),
    'high',
  );
  assert.equal(
    classifyPermission(toolCall, 'Read file', '/workspace', {
      trusted: false,
      canonicalResources: [],
    }),
    'unknown',
  );
});

await test('unrecognized nested inputs never receive automatic approval', () => {
  const hiddenTarget = { name: 'read', rawInput: { target: '/etc/shadow' } };
  const providerSpecific = { name: 'read', rawInput: { opaqueLocation: 'README.md' } };
  const unknownWriteTarget = { name: 'write', rawInput: { destination: '/etc/shadow' } };
  const metadataWrappedWriteTarget = {
    name: 'write',
    rawInput: { content: { destination: '/etc/shadow' } },
  };
  const metadataWrappedCommand = {
    action: 'read',
    content: { command: 'rm -rf victim' },
  };
  const structuredCommand = {
    action: 'read',
    rawInput: { command: { program: 'rm', arguments: ['-rf', 'victim'] } },
  };

  assert.deepEqual(permissionReadResources(hiddenTarget), ['/etc/shadow']);
  assert.equal(classifyPermission(hiddenTarget, 'Read file', '/workspace'), 'high');
  assert.equal(classifyPermission(providerSpecific, 'Read file', '/workspace'), 'unknown');
  assert.equal(classifyPermission(unknownWriteTarget, 'Write file', '/workspace'), 'unknown');
  assert.equal(
    classifyPermission(metadataWrappedWriteTarget, 'Write file', '/workspace'),
    'unknown',
  );
  assert.equal(classifyPermission(metadataWrappedCommand, 'Read file', '/workspace'), 'unknown');
  assert.equal(
    classifyPermission(structuredCommand, 'Read file', '/workspace', {
      trusted: true,
      canonicalResources: [],
    }),
    'unknown',
  );
  assert.equal(
    permissionPolicy({
      profile: 'explore',
      workspace: '/workspace',
      title: 'Read file',
      toolCall: providerSpecific,
      options,
    }).recommendation,
    'interactive',
  );
  assert.equal(
    automaticPermissionPolicy({
      profile: 'build',
      workspace: '/workspace',
      title: 'Write file',
      toolCall: metadataWrappedWriteTarget,
      options,
      resourceTrust: { trusted: true, canonicalResources: [] },
    }).recommendation,
    'interactive',
  );
  assert.equal(
    permissionPolicy({
      profile: 'build',
      workspace: '/workspace',
      title: 'Write file',
      toolCall: unknownWriteTarget,
      options,
    }).recommendation,
    'interactive',
  );
  assert.equal(
    permissionPolicy({
      profile: 'build',
      workspace: '/workspace',
      title: 'Write file',
      toolCall: { name: 'write', payload: { destination: '/etc/shadow' } },
      options,
      resourceTrust: { trusted: true, canonicalResources: [] },
    }).recommendation,
    'interactive',
  );
});

await test('keeps common plaintext credential files interactive', async (t) => {
  const cases = [
    { name: 'Netrc', path: '~/.netrc', expected: 'high' },
    { name: 'Windows netrc', path: 'C:\\Users\\dev\\_netrc', expected: 'high' },
    { name: 'npm user config', path: '~/.npmrc', expected: 'high' },
    { name: 'Python package index config', path: '~/.pypirc', expected: 'high' },
    { name: 'Git credential store', path: '~/.git-credentials', expected: 'high' },
    { name: 'RubyGems credentials', path: '~/.gem/credentials', expected: 'high' },
    { name: 'Docker client credentials', path: '~/.docker/config.json', expected: 'high' },
    { name: 'Kubernetes client config', path: '~/.kube/config', expected: 'high' },
    { name: 'GitHub CLI credentials', path: '~/.config/gh/hosts.yml', expected: 'high' },
    {
      name: 'Google application default credentials',
      path: '~/.config/gcloud/application_default_credentials.json',
      expected: 'high',
    },
  ] as const;

  await Promise.all(
    cases.map((testCase) =>
      t.test(testCase.name, () => {
        assert.equal(
          classifyPermission({ name: 'read', rawInput: { file_path: testCase.path } }, 'Read file'),
          testCase.expected,
        );
      }),
    ),
  );
});

await test('keeps reads outside the trusted workspace interactive', async (t) => {
  const cases = [
    { name: 'system password database', path: '/etc/shadow', expected: 'high' },
    { name: 'Codex authentication store', path: '~/.codex/auth.json', expected: 'high' },
    { name: 'untrusted absolute path', path: '/tmp/untrusted.txt', expected: 'unknown' },
    { name: 'parent traversal', path: '../outside.txt', expected: 'unknown' },
    { name: 'remote URL', path: 'https://example.com/data.txt', expected: 'unknown' },
    {
      name: 'remote file URL',
      path: 'file://untrusted/workspace/README.md',
      expected: 'unknown',
    },
    {
      name: 'sibling workspace prefix',
      path: '/workspace-other/README.md',
      expected: 'unknown',
    },
    {
      name: 'Windows path outside workspace',
      path: 'D:\\other\\README.md',
      expected: 'unknown',
    },
  ] as const;

  await Promise.all(
    cases.map((testCase) =>
      t.test(testCase.name, () => {
        assert.equal(
          classifyPermission(
            { name: 'read', rawInput: { file_path: testCase.path } },
            'Read file',
            '/workspace',
          ),
          testCase.expected,
        );
      }),
    ),
  );
  assert.equal(
    classifyPermission({ command: 'cat /tmp/untrusted.txt' }, 'Read file', '/workspace'),
    'unknown',
  );
  assert.equal(
    classifyPermission({ command: 'cat $HOME/notes.txt' }, 'Read file', '/workspace'),
    'unknown',
  );
  assert.equal(
    classifyPermission(
      { name: 'read', rawInput: { file_path: '~other/notes.txt' } },
      'Read file',
      '/workspace',
    ),
    'unknown',
  );
});

await test('keeps reads inside the trusted workspace eligible for automatic approval', async (t) => {
  const cases = [
    { name: 'relative file', path: 'src/App.svelte', workspace: '/workspace', expected: 'low' },
    {
      name: 'absolute workspace file',
      path: '/workspace/README.md',
      workspace: '/workspace',
      expected: 'low',
    },
    {
      name: 'normalized workspace file',
      path: '/workspace/src/../README.md',
      workspace: '/workspace',
      expected: 'low',
    },
    {
      name: 'Windows workspace file',
      path: 'C:\\repo\\src\\App.svelte',
      workspace: 'C:\\repo',
      expected: 'low',
    },
    {
      name: 'local workspace file URL',
      path: 'file:///workspace/README.md',
      workspace: '/workspace',
      expected: 'low',
    },
  ] as const;

  await Promise.all(
    cases.map((testCase) =>
      t.test(testCase.name, () => {
        assert.equal(
          classifyPermission(
            { name: 'read', rawInput: { file_path: testCase.path } },
            'Read file',
            testCase.workspace,
            { trusted: true, canonicalResources: [] },
          ),
          testCase.expected,
        );
      }),
    ),
  );
  assert.equal(
    classifyPermission({ command: 'cat /workspace/README.md' }, 'Read file', '/workspace'),
    'unknown',
  );
});

await test('keeps path-based reads interactive when the provider opens the path later', () => {
  const decision = automaticPermissionPolicy({
    profile: 'explore',
    workspace: '/workspace',
    title: 'Read file',
    toolCall: { name: 'read', rawInput: { file_path: '/workspace/README.md' } },
    options,
    resourceTrust: {
      trusted: true,
      canonicalResources: ['/workspace/README.md'],
    },
  });

  assert.equal(decision.risk, 'low');
  assert.equal(decision.recommendation, 'interactive');
  assert.equal(decision.optionId, undefined);
});

await test('keeps automatic build edits interactive when execution reopens a path', () => {
  const decision = automaticPermissionPolicy({
    profile: 'build',
    workspace: '/workspace',
    title: 'Edit file',
    toolCall: { action: 'edit', resources: ['/workspace/src/App.svelte'] },
    options,
    resourceTrust: {
      trusted: true,
      canonicalResources: ['/workspace/src/App.svelte'],
    },
  });

  assert.equal(decision.risk, 'medium');
  assert.equal(decision.recommendation, 'interactive');
  assert.equal(decision.optionId, undefined);
});

await test('keeps mounted path decisions unknown until canonical inspection', () => {
  const decision = permissionPolicy({
    profile: 'explore',
    workspace: '/workspace',
    title: 'Read file',
    toolCall: { action: 'read', resources: ['/workspace/link'] },
    options,
  });

  assert.equal(decision.risk, 'unknown');
  assert.equal(decision.recommendation, 'interactive');
});

await test('shell search operands never become eligible for automatic approval', async (t) => {
  const cases = [
    { name: 'ripgrep path', command: 'rg needle src' },
    { name: 'ripgrep files mode', command: 'rg --files src' },
    { name: 'grep recursive path', command: 'grep -R needle src' },
    { name: 'named home path', command: 'rg --files ~other/private' },
    { name: 'unknown option grammar', command: 'rg --future-option value src' },
  ] as const;

  await Promise.all(
    cases.map((testCase) =>
      t.test(testCase.name, () => {
        assert.equal(
          classifyPermission({ command: testCase.command }, 'Search files', '/workspace'),
          'unknown',
        );
      }),
    ),
  );
  assert.deepEqual(permissionReadResources({ command: 'rg --files ~other/private' }), [
    '~other/private',
  ]);
  assert.deepEqual(permissionReadResources({ command: "rg --files -g '*.ts' src" }), ['src']);
  assert.deepEqual(permissionReadResources({ command: 'grep -e needle src/App.svelte' }), [
    'src/App.svelte',
  ]);
  assert.deepEqual(permissionReadResources({ command: 'rg -f patterns.txt src' }), [
    'patterns.txt',
    'src',
  ]);
});

await test('never automatically approves out-of-workspace reads in any profile', async (t) => {
  const cases = [
    { name: 'explore profile', profile: 'explore', expected: 'interactive' },
    { name: 'review profile', profile: 'review', expected: 'interactive' },
    { name: 'build profile', profile: 'build', expected: 'interactive' },
    { name: 'release profile', profile: 'release', expected: 'interactive' },
  ] as const;

  await Promise.all(
    cases.map((testCase) =>
      t.test(testCase.name, () => {
        assert.equal(
          permissionPolicy({
            profile: testCase.profile,
            workspace: '/workspace',
            title: 'Read file',
            toolCall: { action: 'read', resources: ['/tmp/untrusted.txt'] },
            options,
          }).recommendation,
          testCase.expected,
        );
      }),
    ),
  );
});

await test('records provider-defined reject option IDs as rejected', () => {
  assert.equal(permissionOutcome(options, 'no'), 'rejected');
  assert.equal(
    permissionOutcome([{ optionId: 'provider-denied', kind: 'reject_always' }], 'provider-denied'),
    'rejected',
  );
  assert.equal(permissionOutcome(options, 'yes'), 'completed');
});

await test('rejects directory capability switches while another profile is active', () => {
  assert.deepEqual(conflictingCapabilityProfiles(['review'], 'build'), ['review']);
  assert.deepEqual(conflictingCapabilityProfiles(['review', 'build'], 'build'), ['review']);
  assert.deepEqual(conflictingCapabilityProfiles(['build'], 'build'), []);
});

await test('OpenCode rejection settles every pending request in the selected session', () => {
  const pending = [
    { id: 'first', sessionID: 'selected' },
    { id: 'second', sessionID: 'selected' },
    { id: 'other', sessionID: 'other' },
  ];

  assert.deepEqual(
    settledOpenCodePermissions(pending, pending[1], 'reject').map((request) => request.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    settledOpenCodePermissions(pending, pending[1], 'once').map((request) => request.id),
    ['second'],
  );
});

await test('capability reservation stays active for the complete operation', async () => {
  let active = false;
  const result = await withCapabilityProfileReservation(
    async () => {
      active = true;
      return () => {
        active = false;
      };
    },
    async () => {
      assert.equal(active, true);
      await Promise.resolve();
      assert.equal(active, true);
      return 'complete';
    },
  );

  assert.equal(result, 'complete');
  assert.equal(active, false);
});

await test('capability reservation releases when the operation fails', async () => {
  let active = false;
  await assert.rejects(
    withCapabilityProfileReservation(
      async () => {
        active = true;
        return () => {
          active = false;
        };
      },
      async () => {
        throw new Error('fork failed');
      },
    ),
    /fork failed/,
  );
  assert.equal(active, false);
});

await test('accepted prompts retain their profile reservation until provider settlement', async () => {
  const completion = Promise.withResolvers<void>();
  let active = true;
  const held = holdCapabilityProfileReservation(() => {
    active = false;
  }, completion.promise);

  await Promise.resolve();
  assert.equal(active, true);
  completion.resolve();
  await held;
  assert.equal(active, false);
});

await test('capability reservation conflicts prevent the operation', async () => {
  let operationRan = false;
  await assert.rejects(
    withCapabilityProfileReservation(
      async () => {
        throw new Error('build profile is active');
      },
      async () => {
        operationRan = true;
      },
    ),
    /build profile is active/,
  );
  assert.equal(operationRan, false);
});

await test('directory profile switches cannot replace a reserved side chat profile', async () => {
  const reservations = new CapabilityProfileReservationCoordinator();
  const releaseExplore = await reservations.reserve('/workspace', 'explore', async () => {});

  await assert.rejects(
    reservations.reserve('/workspace', 'build', async () => {}),
    /pending explore OpenCode launch/,
  );
  releaseExplore();
  const releaseBuild = await reservations.reserve('/workspace', 'build', async () => {});

  releaseBuild();
});

await test('same-profile reservations share one pending configuration', async () => {
  const reservations = new CapabilityProfileReservationCoordinator();
  const configured = Promise.withResolvers<void>();
  let configurations = 0;
  const configure = async () => {
    configurations++;
    await configured.promise;
  };

  const first = reservations.reserve('/workspace', 'build', configure);
  await Promise.resolve();
  const second = reservations.reserve('/workspace', 'build', configure);
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
    return undefined;
  });
  await Promise.resolve();

  assert.equal(configurations, 1);
  assert.equal(secondSettled, false);
  configured.resolve();
  const [releaseFirst, releaseSecond] = await Promise.all([first, second]);
  assert.equal(configurations, 1);
  assert.equal(secondSettled, true);
  releaseFirst();
  releaseSecond();
});

await test('keeps unknown and high-risk actions interactive', () => {
  for (const [title, toolCall] of [
    ['Do thing', { name: 'provider-specific-action' }],
    ['Run command', { command: 'rm -rf build' }],
  ] as const)
    assert.equal(
      permissionPolicy({ profile: 'release', title, toolCall, options }).recommendation,
      'interactive',
    );
});

await test('recommends reviewed actions according to the active profile', () => {
  assert.deepEqual(
    permissionPolicy({
      profile: 'explore',
      title: 'Read file',
      toolCall: { name: 'read', rawInput: { file_path: 'README.md' } },
      options,
      resourceTrust: { trusted: true, canonicalResources: ['/workspace/README.md'] },
    }).recommendation,
    'allow',
  );
  assert.equal(
    permissionPolicy({
      profile: 'review',
      title: 'Edit file',
      toolCall: { action: 'edit' },
      options,
    }).recommendation,
    'deny',
  );
  assert.equal(
    permissionPolicy({
      profile: 'build',
      title: 'Edit file',
      toolCall: { action: 'edit' },
      options,
    }).recommendation,
    'allow',
  );
});

await test('automatic approval is always one-shot', () => {
  const decision = permissionPolicy({
    profile: 'explore',
    title: 'Read file',
    toolCall: { name: 'read', rawInput: { file_path: 'README.md' } },
    options: [
      { optionId: 'forever', kind: 'allow_always' },
      { optionId: 'once', kind: 'allow_once' },
    ],
    resourceTrust: { trusted: true, canonicalResources: ['/workspace/README.md'] },
  });
  assert.equal(decision.recommendation, 'allow');
  assert.equal(decision.optionId, 'once');
  assert.equal(
    permissionPolicy({
      profile: 'explore',
      title: 'Read file',
      toolCall: { name: 'read', rawInput: { file_path: 'README.md' } },
      options: [{ optionId: 'forever', kind: 'allow_always' }],
      resourceTrust: { trusted: true, canonicalResources: ['/workspace/README.md'] },
    }).recommendation,
    'interactive',
  );
});

await test('profile denial uses a provider reject even when it is persistent', () => {
  const decision = permissionPolicy({
    profile: 'review',
    title: 'Edit file',
    toolCall: { action: 'edit' },
    options: [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'deny', kind: 'reject_always' },
    ],
  });
  assert.equal(decision.recommendation, 'deny');
  assert.equal(decision.optionId, 'deny');
});

await test('maps workflow phase to capability profile', () => {
  assert.equal(capabilityProfileForPhase('explore'), 'explore');
  assert.equal(capabilityProfileForPhase('review'), 'review');
  assert.equal(capabilityProfileForPhase('implement'), 'build');
  assert.equal(capabilityProfileForPhase('pr'), 'release');
});

await test('side chat session metadata overrides a build workspace fallback', () => {
  const metadata = exploreSessionMetadata({ inherited: 'kept' });

  assert.deepEqual(metadata, {
    inherited: 'kept',
    saiHarness: true,
    sailCapabilityProfile: 'explore',
  });
  assert.equal(capabilityProfileFromMetadata(metadata, 'build'), 'explore');
});

await test('runtime capability profile follows active session metadata after reconnect', () => {
  const sessions = [
    { id: 'running', metadata: { sailCapabilityProfile: 'explore' } },
    { id: 'idle', metadata: { sailCapabilityProfile: 'build' } },
  ];

  assert.equal(capabilityProfileForRuntime(sessions, ['running'], 'build'), 'explore');
  assert.equal(capabilityProfileForRuntime(sessions, [], 'build'), 'build');
  assert.equal(capabilityProfileForRuntime(sessions, ['running', 'idle'], 'build'), null);
});

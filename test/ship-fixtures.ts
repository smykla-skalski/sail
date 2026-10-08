import { createShipRun } from '../src/lib/issue-shipping.ts';
import { recordTaskEvidence } from '../src/lib/task-evidence.ts';
import { emptyTaskEconomics, syntheticCiEconomics } from '../src/lib/task-economics.ts';

export function fixture() {
  return createShipRun(
    {
      umbrella: {
        id: 'umbrella',
        number: 1,
        url: 'https://github.com/a/b/issues/1',
        title: 'Umbrella',
        body: '',
        dependsOn: [],
        state: 'OPEN',
      },
      issues: [
        {
          id: 'first',
          number: 2,
          repository: 'a/b',
          url: 'https://github.com/a/b/issues/2',
          title: 'First',
          body: '',
          dependsOn: [],
          state: 'OPEN',
        },
        {
          id: 'second',
          number: 3,
          repository: 'a/b',
          url: 'https://github.com/a/b/issues/3',
          title: 'Second',
          body: '',
          dependsOn: ['first'],
          state: 'OPEN',
        },
      ],
    },
    '/repo',
    'a/b',
    'plan',
    'codex',
    2,
    'run',
    1,
  );
}

export function withMergeEvidence(issue: ReturnType<typeof fixture>['issues'][number]) {
  const revision = 'revision-one';
  let evidenceManifests = issue.checkpoint!.requiredGates.reduce(
    (manifests, gate, index) =>
      recordTaskEvidence(manifests, revision, issue.checkpoint!.acceptanceCriteria, {
        id: `evidence-${gate}`,
        kind: 'gate',
        name: gate,
        provider: 'codex',
        model: 'test',
        result: 'passed',
        timestamp: 10 + index,
        outputReference: `thread:${gate}`,
        criteria: issue.checkpoint!.acceptanceCriteria,
        economics: {
          ...emptyTaskEconomics('validator', gate === 'test-adversary' ? 'test' : 'review'),
          checks: 1,
        },
      }),
    issue.evidenceManifests ?? [],
  );
  evidenceManifests = recordTaskEvidence(
    evidenceManifests,
    revision,
    issue.checkpoint!.acceptanceCriteria,
    {
      id: 'evidence-ci-build',
      kind: 'command',
      name: 'ci:build',
      provider: 'github',
      model: null,
      result: 'passed',
      timestamp: 20,
      outputReference: 'https://example.test/build',
      criteria: [],
      economics: syntheticCiEconomics(),
    },
  );
  const requiredGates = issue.checkpoint!.requiredGates;
  return {
    ...issue,
    evidenceRevision: revision,
    evidenceManifests,
    validationPolicy: {
      risk: 'high' as const,
      requiredGates,
      sources: ['test fixture'],
      revision,
      changedPaths: [],
      selectedAt: 1,
      history: [],
    },
    gates: requiredGates.map((gate, index) => ({
      id: `gate-${gate}`,
      gate,
      requestedModel: 'test',
      provider: 'codex',
      model: 'test',
      threadId: `thread-${gate}`,
      directory: '/repo',
      state: 'completed' as const,
      created: 10 + index,
      updated: 10 + index,
      error: null,
      verdict: gate === 'test-adversary' ? ('PASS' as const) : ('CLEAN' as const),
      revision,
    })),
  };
}

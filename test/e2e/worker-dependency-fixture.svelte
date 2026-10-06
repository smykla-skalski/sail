<script lang="ts">
  import WorkerDependencyMap from '../../src/WorkerDependencyMap.svelte';
  import type { ShipIssue, ShipRun } from '../../src/lib/issue-shipping';

  function issue(number: number, dependsOn: string[] = []): ShipIssue {
    return {
      id: `owner/repo#${number}`,
      number,
      url: `https://github.com/owner/repo/issues/${number}`,
      title: `Issue ${number}`,
      dependsOn,
      state: number === 1 ? 'merged' : 'pending',
      branch: `issue-${number}`,
      path: number === 2 ? '/workspace/issue-2' : null,
      receiptId: null,
      threadId: number === 2 ? 'opencode:session-2' : null,
      pullRequest: null,
      error: null,
      workerModel: number === 1 ? 'gpt-5.6-sol' : undefined,
      checks:
        number === 2
          ? [{ name: 'Frontend', state: 'FAILURE', url: 'https://checks.example/2' }]
          : [],
    };
  }

  const run: ShipRun = {
    id: 'run',
    source: 'source',
    repository: '/workspace',
    remote: 'owner/repo',
    provider: 'codex',
    limit: 2,
    approvedAt: 1,
    externalClosed: {},
    dependencyErrors: { 'other/repo#9': 'Repository unavailable' },
    issues: [issue(1), issue(2, ['1']), issue(3, ['missing-target', 'other/repo#9'])],
  };
  const independent = { ...run, id: 'independent', issues: [issue(4)] };
  let selected = $state('');
  let opened = $state('');
</script>

<main>
  <WorkerDependencyMap
    {run}
    {selected}
    onselect={async (id) => {
      selected = id;
    }}
    onopen={async (path, thread) => {
      opened = `${path}:${thread}`;
    }}
  />
  <div id="independent">
    <WorkerDependencyMap run={independent} onselect={async () => {}} onopen={async () => {}} />
  </div>
  <output aria-label="Selected dependency">{selected}</output>
  <output aria-label="Opened worker">{opened}</output>
</main>

<style>
  main {
    padding: 16px;
  }
  output {
    position: fixed;
    left: -10000px;
  }
</style>

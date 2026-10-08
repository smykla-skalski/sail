<script lang="ts">
  import SpawnActivity from '../../src/SpawnActivity.svelte';
  import SpawnResponse from '../../src/SpawnResponse.svelte';
  import { receiptIsSettled, type SpawnReceipt } from '../../src/lib/agent-results';

  const base: SpawnReceipt = {
    receiptId: 'targeted',
    accessKey: 'secret',
    requestId: 'request',
    project: '/repo',
    sourceId: 'opencode:parent',
    sourceDirectory: '/repo',
    targetId: 'acp:codex:exact-child',
    turnId: 'turn',
    targetDirectory: '/repo/child',
    worktreeId: '/repo/child',
    provider: 'codex',
    prompt: 'Inspect the exact child task',
    state: 'working',
    created: Date.now() - 1_000,
    updated: Date.now(),
    result: `older output ${'x'.repeat(5_000)} TAIL`,
    error: null,
    activity: 'Running browser checks',
    toolCount: 3,
  };
  const finished: SpawnReceipt = {
    ...base,
    receiptId: 'finished',
    targetId: 'acp:claude:finished-child',
    targetDirectory: '/repo/finished',
    provider: 'claude',
    name: 'Explore',
    prompt: 'Map the sidebar code',
    state: 'completed',
    created: 1_000_000,
    updated: 1_065_000,
    toolCount: 7,
    activity: 'Completed',
    result: Array.from({ length: 8 }, (_, index) => `Finding ${index + 1} about the sidebar.`).join(
      '\n\n',
    ),
  };
  let receipts = $state<SpawnReceipt[]>([
    base,
    finished,
    {
      ...base,
      receiptId: 'missing',
      targetId: null,
      targetDirectory: null,
      provider: 'claude',
      prompt: 'Waiting for a thread',
      state: 'starting',
      updated: 1e20,
      result: null,
      activity: undefined,
    },
  ]);
  let draft = $state('Parent draft stays here');
  let opened = $state('');
  let openCount = $state(0);
  let responseOpened = $state('');

  function update() {
    receipts = receipts.map((receipt) =>
      receipt.receiptId === 'targeted'
        ? Object.assign({}, receipt, { activity: 'Running final checks', updated: Date.now() })
        : receipt,
    );
  }

  function settleMissing(result: string | null) {
    receipts = receipts.map((receipt) =>
      receipt.receiptId === 'missing'
        ? Object.assign({}, receipt, {
            state: 'completed' as const,
            result,
            updated: Date.now(),
          })
        : receipt,
    );
  }
</script>

<textarea aria-label="Parent message" bind:value={draft}></textarea>
<button aria-label="Update child" onclick={update}>Update child</button>
<button aria-label="Settle without result" onclick={() => settleMissing(null)}>
  Settle without result
</button>
<button aria-label="Preserve result" onclick={() => settleMissing('Preserved result')}>
  Preserve result
</button>
<output aria-label="Opened thread">{opened}</output>
<output aria-label="Open count">{openCount}</output>
<output aria-label="Response opened">{responseOpened}</output>
{#each receipts.filter((receipt) => receiptIsSettled(receipt.state)) as receipt (receipt.receiptId)}
  <SpawnResponse
    {receipt}
    onopen={async (item) => {
      responseOpened = `${item.targetDirectory}|${item.targetId}`;
    }}
  />
{/each}
<SpawnActivity
  {receipts}
  onopen={async (receipt) => {
    openCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    opened = `${receipt.targetDirectory}|${receipt.targetId}`;
  }}
/>

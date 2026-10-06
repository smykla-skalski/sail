<script lang="ts">
  import SpawnActivity from '../../src/SpawnActivity.svelte';
  import type { SpawnReceipt } from '../../src/lib/agent-results';

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
  };
  let receipts = $state<SpawnReceipt[]>([
    base,
    {
      ...base,
      receiptId: 'missing',
      targetId: null,
      targetDirectory: null,
      provider: 'claude',
      prompt: 'Waiting for a thread',
      state: 'starting',
      result: null,
      activity: undefined,
    },
  ]);
  let draft = $state('Parent draft stays here');
  let opened = $state('');
  let openCount = $state(0);

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
<SpawnActivity
  {receipts}
  onopen={async (receipt) => {
    openCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    opened = `${receipt.targetDirectory}|${receipt.targetId}`;
  }}
/>

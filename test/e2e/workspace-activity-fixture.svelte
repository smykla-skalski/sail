<script lang="ts">
  import WorkspaceActivity from '../../src/WorkspaceActivity.svelte';
  import { workspaceActivityItems } from '../../src/lib/workspace-activity';
  import type { SpawnReceipt } from '../../src/lib/agent-results';

  const children: SpawnReceipt[] = Array.from({ length: 10 }, (_, index) => ({
    receiptId: `child-${index}`,
    accessKey: 'key',
    requestId: `request-${index}`,
    project: '/repo',
    sourceId: 'opencode:parent',
    sourceDirectory: '/repo',
    targetId: `acp:codex:child-${index}`,
    turnId: 'turn',
    targetDirectory: `/repo/child-${index}`,
    worktreeId: `/repo/child-${index}`,
    provider: 'codex',
    prompt: `Child task ${index}`,
    state: 'working',
    created: index,
    updated: index,
    result: null,
    error: null,
    activity: `Working on child ${index}`,
  }));
  const items = workspaceActivityItems({
    children,
    tools: [{ id: 'read', title: 'Read configuration', status: 'completed', updated: 2 }],
    decisions: [
      { id: 'permission', title: 'Allow test command?', detail: 'Agent permission request' },
    ],
    checks: [
      {
        id: 'check',
        updated: 20,
        directory: '/repo',
        thread: 'opencode:parent',
        turn: 'turn',
        source: 'repository',
        command: 'npm test',
        status: 'failed',
        output: 'failed',
        code: 1,
      },
    ],
  });
  let activeItems = $state(items);
  let opened = $state('');
  let failSelection = $state(false);
</script>

<main>
  <div class="fixture-body">
    <section class="conversation" aria-label="Fixture conversation">
      Conversation remains visible
    </section>
    <div id="active-panel">
      <WorkspaceActivity
        items={activeItems}
        storageKey="e2e-workspace-activity-active"
        onselect={(item) => {
          if (failSelection) {
            failSelection = false;
            throw new Error('Target unavailable');
          }
          opened = `${item.kind}:${item.sourceId}`;
        }}
      />
    </div>
  </div>
  <div class="composer" aria-label="Fixture composer">Composer remains visible</div>
  <output aria-label="Opened activity">{opened}</output>
  <button class="fixture-control" aria-label="Clear activity" onclick={() => (activeItems = [])}
    >Clear</button
  >
  <button
    class="fixture-control"
    aria-label="Restore activity"
    onclick={() => (activeItems = items)}>Restore</button
  >
  <button
    class="fixture-control"
    aria-label="Fail activity selection"
    onclick={() => (failSelection = true)}>Fail selection</button
  >
  <div id="empty-panel">
    <WorkspaceActivity items={[]} storageKey="e2e-workspace-activity-empty" onselect={() => {}} />
  </div>
</main>

<style>
  :global(html),
  :global(body),
  :global(#root) {
    height: 100%;
    margin: 0;
  }
  main {
    position: relative;
    display: flex;
    height: 100%;
    flex-direction: column;
    overflow: hidden;
    background: var(--sui-background);
  }
  .fixture-body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .conversation {
    flex: 1;
    padding: 24px;
  }
  #active-panel {
    display: contents;
  }
  .composer {
    flex: 0 0 90px;
    padding: 16px;
    border-top: 1px solid var(--sui-border);
  }
  output {
    position: absolute;
    left: 8px;
    bottom: 8px;
  }
  .fixture-control {
    position: fixed;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
  }
  #empty-panel {
    position: absolute;
    top: 8px;
    left: 8px;
  }
</style>

<script lang="ts">
  import WorkspaceActivity from '../../src/WorkspaceActivity.svelte';
  import { workspaceActivityItems } from '../../src/lib/workspace-activity';
  import type { SpawnReceipt } from '../../src/lib/agent-results';
  import type { ActivityHistoryEvent } from '../../src/lib/activity-history';

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
  const events: ActivityHistoryEvent[] = [
    {
      id: 'duplicate-child',
      workspace: '/repo',
      kind: 'subagent',
      source: 'codex',
      sourceId: 'child-9',
      title: 'Child task 9',
      outcome: 'working',
      at: 20,
    },
    {
      id: 'earlier-parent',
      workspace: '/repo',
      kind: 'parent',
      source: 'opencode',
      sourceId: 'parent',
      title: 'Earlier parent task',
      outcome: 'completed',
      at: 1,
    },
  ];
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
        {events}
        onselect={(item) => {
          if (failSelection) {
            failSelection = false;
            throw new Error('Target unavailable');
          }
          opened = `${item.kind}:${item.sourceId}`;
        }}
        onselecthistory={(event) => {
          opened = `${event.kind}:${event.sourceId}`;
        }}
      />
    </div>
  </div>
  <div class="agent-status-bar" aria-label="Fixture agent status">Agents</div>
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
    width: min(420px, 50%);
    min-width: 0;
    border-left: 1px solid var(--sui-border);
  }
  .agent-status-bar {
    flex: 0 0 31px;
    padding: 7px 12px;
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
  @media (max-width: 850px) {
    .conversation {
      display: none;
    }
    #active-panel {
      width: 100%;
      border-left: 0;
    }
  }
</style>

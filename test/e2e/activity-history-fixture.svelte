<script lang="ts">
  import HistoryPanel from '../../src/HistoryPanel.svelte';
  import { recentActivityEvents } from '../../src/lib/activity-history';

  const events = recentActivityEvents([
    {
      workspace: '/workspace/alpha',
      kind: 'tool',
      source: 'Codex',
      sourceId: 'tool-1',
      title: 'Run tests',
      outcome: 'working',
      at: 10,
      agent: 'codex',
      sessionId: 'session-1',
    },
    {
      workspace: '/workspace/alpha',
      kind: 'tool',
      source: 'Codex',
      sourceId: 'tool-1',
      title: 'Run tests',
      outcome: 'completed',
      at: 30,
      agent: 'codex',
      sessionId: 'session-1',
    },
    {
      workspace: '/workspace/beta',
      kind: 'decision',
      source: 'Claude',
      sourceId: 'decision-1',
      title: `Approve ${'long output '.repeat(80)}`,
      outcome: 'waiting',
      at: 20,
      agent: 'claude',
      sessionId: 'session-2',
    },
  ]);
  let opened = $state('');
</script>

<main>
  <HistoryPanel
    {events}
    loading={false}
    error=""
    onrefresh={() => {}}
    onselect={(event) => {
      opened = `${event.workspace}:${event.sourceId}`;
    }}
  />
  <output aria-label="Opened activity">{opened}</output>
</main>

<style>
  main {
    width: 420px;
    height: 600px;
  }
  output {
    position: fixed;
    left: -10000px;
  }
</style>

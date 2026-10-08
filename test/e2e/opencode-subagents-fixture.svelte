<script lang="ts">
  import OpenCodeSubagents from '../../src/OpenCodeSubagents.svelte';
  import type { OpenCodeChildClient } from '../../src/lib/opencode-children';
  import type { SessionInfo, SessionMessageInfo } from '../../src/lib/opencode';
  import type { SpawnReceipt } from '../../src/lib/agent-results';
  import WorkspaceActivity from '../../src/WorkspaceActivity.svelte';
  import { workspaceActivityItems } from '../../src/lib/workspace-activity';

  // `mixed` shows one running, one finished and one failed child with Open and activity wiring.
  const mixed = new URLSearchParams(location.search).has('mixed');

  const calls = {
    list: 0,
    listTimes: [] as number[],
    summaries: {} as Record<string, number>,
    histories: {} as Record<string, number>,
  };
  Object.assign(window, { openCodeSubagentCalls: calls });

  function sessionFor(id: string): SessionInfo {
    const info: SessionInfo = {
      id,
      parentID: 'parent',
      projectID: 'project',
      agent: 'general',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      title: `Child ${id}`,
      location: { directory: '/repo' },
    };
    if (id === 'child-d') info.outcome = 'failed';
    return info;
  }
  const children = (mixed ? ['child-a', 'child-c', 'child-d'] : ['child-a', 'child-b']).map(
    sessionFor,
  );

  const client: OpenCodeChildClient = {
    session: {
      list: async () => {
        calls.list++;
        calls.listTimes.push(Math.round(performance.now()));
        return { data: children, cursor: {} };
      },
      active: async () =>
        Object.fromEntries(
          children
            .filter((child) => !mixed || child.id === 'child-a')
            .map((child) => [child.id, {}]),
        ),
    },
    message: {
      list: async ({ sessionID, type }) => {
        const counts = type === 'assistant' ? calls.summaries : calls.histories;
        counts[sessionID] = (counts[sessionID] ?? 0) + 1;
        const message: SessionMessageInfo = {
          id: `${sessionID}-message`,
          type: 'assistant',
          agent: 'general',
          model: { id: 'model', providerID: 'provider' },
          content: [{ type: 'text', text: `Output of ${sessionID}` }],
          time: { created: 1 },
        };
        return { data: [message], cursor: {} };
      },
    },
  };

  let opened = $state('');
  let reported = $state.raw<SpawnReceipt[]>([]);
  const items = $derived(workspaceActivityItems({ children: reported }));
</script>

{#if mixed}
  <main>
    <output aria-label="Opened thread">{opened}</output>
    <OpenCodeSubagents
      {client}
      parentID="parent"
      directory="/repo"
      onopen={async (receipt) => {
        opened = `${receipt.targetDirectory}|${receipt.targetId}`;
      }}
      onchildren={(receipts) => (reported = receipts)}
    />
    <WorkspaceActivity {items} onselect={() => {}} />
  </main>
{:else}
  <main>
    <section aria-label="First OpenCode view">
      <OpenCodeSubagents {client} parentID="parent" />
    </section>
    <section aria-label="Second OpenCode view">
      <OpenCodeSubagents {client} parentID="parent" />
    </section>
  </main>
{/if}

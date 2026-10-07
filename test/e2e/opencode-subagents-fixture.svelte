<script lang="ts">
  import OpenCodeSubagents from '../../src/OpenCodeSubagents.svelte';
  import type { OpenCodeChildClient } from '../../src/lib/opencode-children';
  import type { SessionInfo, SessionMessageInfo } from '../../src/lib/opencode';

  const calls = {
    list: 0,
    summaries: {} as Record<string, number>,
    histories: {} as Record<string, number>,
  };
  Object.assign(window, { openCodeSubagentCalls: calls });

  const children: SessionInfo[] = ['child-a', 'child-b'].map((id) => ({
    id,
    parentID: 'parent',
    projectID: 'project',
    agent: 'general',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: `Child ${id}`,
    location: { directory: '/repo' },
  }));

  const client: OpenCodeChildClient = {
    session: {
      list: async () => {
        calls.list++;
        return { data: children, cursor: {} };
      },
      active: async () => Object.fromEntries(children.map((child) => [child.id, {}])),
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
</script>

<main>
  <section aria-label="First OpenCode view">
    <OpenCodeSubagents {client} parentID="parent" />
  </section>
  <section aria-label="Second OpenCode view">
    <OpenCodeSubagents {client} parentID="parent" />
  </section>
</main>

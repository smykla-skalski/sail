<script lang="ts">
  import AgentFocus from './AgentFocus.svelte';
  import { agentFocusDisplay } from './lib/agent-focus';
  import type { ThreadStatus } from './lib/attention';
  import type { TaskSnapshot } from './lib/session-tasks';
  let {
    snapshot,
    status = snapshot.turnId ? 'working' : null,
  }: { snapshot: TaskSnapshot; status?: ThreadStatus | null } = $props();
  const focus = $derived(agentFocusDisplay(snapshot, status));
</script>

<section class="tasks-panel" aria-label="Session tasks">
  <h2>Tasks</h2>
  {#if focus}<div class="focus-summary"><AgentFocus {focus} /></div>{/if}
  {#if !snapshot.tasks.length}<p>No tasks reported in this session.</p>{:else}<ul>
      {#each snapshot.tasks as task (task.id)}<li
          class:focused={status === 'working' &&
            snapshot.focus === task.id &&
            task.origin === 'agent'}
        >
          <span class="task-title">{task.title}</span>
          <span class="task-status">{task.status.replaceAll('_', ' ')}</span>
          {#if task.origin === 'sail'}<span class="task-origin">Sail starting task</span>{/if}
          {#if status === 'working' && snapshot.focus === task.id && task.origin === 'agent'}<span
              class="task-origin">Current focus</span
            >{/if}
        </li>{/each}
    </ul>{/if}
</section>

<style>
  .tasks-panel {
    padding: 16px;
    min-width: 0;
  }
  .focus-summary {
    margin-bottom: 12px;
  }
  h2 {
    font-size: 16px;
    margin: 0 0 12px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding: 12px 0;
    border-bottom: 1px solid var(--sui-border);
  }
  .task-title {
    flex: 1 1 100%;
    overflow-wrap: anywhere;
  }
  .task-status,
  .task-origin {
    font-size: 12px;
    color: var(--sui-muted);
  }
  .focused .task-title {
    font-weight: 600;
  }
</style>

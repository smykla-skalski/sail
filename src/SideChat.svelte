<script lang="ts">
  import AgentWorkspace from './AgentWorkspace.svelte';
  import type { AgentId } from './lib/acp';
  import type { TaskLocation as TaskLocationValue } from './lib/task-location';

  let {
    source,
    directory,
    taskLocation,
    focused,
    focusPrompt,
    onpromptfocused,
  }: {
    source: { kind: 'acp'; agent: AgentId; context: string };
    directory: string;
    taskLocation: TaskLocationValue;
    focused: boolean;
    focusPrompt: boolean;
    onpromptfocused: () => void;
  } = $props();
</script>

<AgentWorkspace
  agent={source.agent}
  agentName={source.agent}
  {directory}
  {taskLocation}
  thread={null}
  running={false}
  {focused}
  {focusPrompt}
  {onpromptfocused}
  capabilityProfile="explore"
  ephemeral
  seedContext={source.context}
  oncreated={() => {}}
  onactivity={() => {}}
  onstatus={() => {}}
  onterminal={() => {}}
/>

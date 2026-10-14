<script lang="ts">
  import { focusReportTime, type AgentFocusDisplay } from './lib/agent-focus';
  let { focus }: { focus: AgentFocusDisplay } = $props();
</script>

<span class="agent-focus" data-focus-source={focus.source}>
  <span class="agent-focus-text" title={focus.text}>{focus.text}</span>
  <small>
    {focus.source}{#if focus.source === 'Agent report'}
      · {#if focus.reportedAt !== null}<time datetime={new Date(focus.reportedAt).toISOString()}
          >{focusReportTime(focus.reportedAt)}</time
        >{:else}Report time unavailable{/if}
    {/if}
  </small>
</span>

<style>
  .agent-focus {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }
  .agent-focus-text {
    overflow-wrap: anywhere;
  }
  small {
    color: var(--shell-muted);
    font-size: var(--type-12);
  }
</style>

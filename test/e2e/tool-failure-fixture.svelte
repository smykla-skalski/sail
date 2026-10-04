<script lang="ts">
  import ToolActivity from '../../src/ToolActivity.svelte';
  import {
    appendToolFailureDraft,
    openCodeErrorDetails,
    reportedHookIdentity,
    toolFailurePrompt,
  } from '../../src/lib/tool-failure';

  const input = { command: 'npm test', workdir: '/repo' };
  let status = $state('running');
  let message = $state('Permission denied');
  let output = $state('');
  let draft = $state('Existing draft');
  const source = reportedHookIdentity({ plugin: 'policy' }) ?? '';
  const error = $derived(openCodeErrorDetails({ type: 'PluginError', message }));

  function fix() {
    draft = appendToolFailureDraft(draft, toolFailurePrompt('bash', input, error, output));
  }
</script>

<button
  aria-label="Fail action"
  onclick={() => {
    status = 'error';
    output = 'blocked output';
  }}>Fail action</button
>
<button
  aria-label="Update failure"
  onclick={() => {
    message = 'Policy blocked command';
    output = 'updated output';
  }}>Update failure</button
>
<ToolActivity
  title="bash"
  {status}
  {input}
  {output}
  error={status === 'error' ? error : ''}
  source={status === 'error' ? source : ''}
  onfix={status === 'error' ? fix : undefined}
/>
<textarea aria-label="Message" bind:value={draft}></textarea>

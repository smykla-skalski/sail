<script lang="ts">
  import ToolActivity from '../../src/ToolActivity.svelte';
  import {
    prepareToolFailureDraft,
    openCodeErrorDetails,
    reportedHookIdentity,
    toolFailurePrompt,
  } from '../../src/lib/tool-failure';

  const input = { command: 'npm test', workdir: '/repo' };
  let status = $state('running');
  let message = $state('Permission denied');
  let output = $state('');
  let draft = $state('Existing draft');
  let previousRequest = '';
  let mounted = $state<{ live: boolean; key: number }[]>([]);
  const source = reportedHookIdentity({ plugin: 'policy' }) ?? '';
  const error = $derived(openCodeErrorDetails({ type: 'PluginError', message }));

  function fix() {
    const request = toolFailurePrompt('bash', input, error, output);
    draft = prepareToolFailureDraft(draft, request, previousRequest);
    previousRequest = request;
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
<button
  aria-label="Mount history failure"
  onclick={() => mounted.push({ live: false, key: mounted.length })}>Mount history failure</button
>
<button
  aria-label="Mount live failure"
  onclick={() => mounted.push({ live: true, key: mounted.length })}>Mount live failure</button
>
<button
  aria-label="Remount failures"
  onclick={() => (mounted = mounted.map((card) => ({ ...card, key: card.key + 100 })))}
  >Remount failures</button
>
{#each mounted as card (card.key)}
  <div data-mounted={card.live ? 'live' : 'history'}>
    <ToolActivity
      title="read"
      status="error"
      activityId={card.live ? 'mounted-live' : 'mounted-history'}
      live={card.live}
      error="Mounted failure"
    />
  </div>
{/each}

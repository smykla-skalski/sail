<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button } from '@smykla-skalski/sui';
  import type { PermissionPolicyDecision } from './lib/capability-profiles';
  import type { PermissionChoice } from './lib/permission-card';

  let {
    title,
    policy,
    command = null,
    files = [],
    message = '',
    toolCallId = null,
    requestId,
    sessionId,
    agentId,
    choices,
    busy = false,
    label = 'Agent permission request',
    extraClass = '',
    onchoose,
    children,
  }: {
    title: string;
    policy?: PermissionPolicyDecision;
    command?: string | null;
    files?: string[];
    message?: string;
    toolCallId?: string | null;
    requestId: string | number;
    sessionId: string;
    agentId?: string;
    choices: PermissionChoice[];
    busy?: boolean;
    label?: string;
    extraClass?: string;
    onchoose: (choice: PermissionChoice) => void;
    children?: Snippet;
  } = $props();

  function showAction() {
    const row = [...document.querySelectorAll<HTMLElement>('[data-tool-id]')].find(
      (element) => element.dataset.toolId === toolCallId,
    );
    if (row instanceof HTMLDetailsElement) row.open = true;
    row?.scrollIntoView({ block: 'center' });
  }
</script>

<div
  class={`permission-card agent-permission ${extraClass}`}
  role="group"
  aria-label={label}
  data-request-id={requestId}
  data-session-id={sessionId}
  data-agent-id={agentId}
  data-policy-risk={policy?.risk}
  tabindex="-1"
>
  <strong>{title}</strong>
  {#if policy}
    <small class="permission-policy" data-policy-recommendation={policy.recommendation}
      >{policy.profile} · {policy.risk} risk · policy {policy.policyRevision}: {policy.reason}</small
    >
    {#if policy.recommendation === 'deny'}<small class="permission-automated"
        >Denied by policy: {policy.reason}</small
      >{/if}
  {/if}
  {#if message}<p class="permission-message">{message}</p>{/if}
  {#if command}<pre class="permission-command"><code>{command}</code></pre>{/if}
  {#if files.length}<ul class="permission-files">
      {#each files as file, index (`${file}:${index}`)}<li><code>{file}</code></li>{/each}
    </ul>{/if}
  {#if children}{@render children()}{/if}
  <div class="permission-actions">
    {#each choices as choice (choice.id)}
      <Button
        size="sm"
        variant={choice.tone === 'primary' ? 'primary' : 'secondary'}
        disabled={busy}
        onclick={() => onchoose(choice)}>{choice.label}</Button
      >
    {/each}
  </div>
  {#if toolCallId}<button type="button" class="permission-link" onclick={showAction}
      >Show action</button
    >{/if}
</div>

<style>
  .permission-card {
    margin-bottom: 10px;
    padding: 12px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
  }
  .permission-card[data-policy-risk='high'] {
    border-color: var(--sui-danger);
  }
  .permission-policy,
  .permission-automated {
    display: block;
    margin-top: 4px;
    color: var(--sui-muted);
  }
  .permission-message {
    margin: 6px 0 0;
  }
  .permission-command {
    margin: 8px 0 0;
    padding: 8px 10px;
    overflow: auto;
    border-radius: 6px;
    background: var(--sui-subtle);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .permission-files {
    margin: 8px 0 0;
    padding-left: 20px;
    overflow-wrap: anywhere;
  }
  .permission-link {
    margin-top: 6px;
    padding: 0;
    border: 0;
    color: var(--sui-primary);
    background: none;
    font-size: 12px;
    cursor: pointer;
  }
  .permission-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
</style>

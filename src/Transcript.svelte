<script lang="ts">
  import type { Snippet } from 'svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import ChatMessage from './ChatMessage.svelte';
  import HookActivityCard from './HookActivity.svelte';
  import Markdown from './Markdown.svelte';
  import PostTurnChecks from './PostTurnChecks.svelte';
  import ShellCommandCard from './ShellCommandCard.svelte';
  import SpawnActivity from './SpawnActivity.svelte';
  import SpawnResponse from './SpawnResponse.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import type { SpawnReceipt } from './lib/agent-results';
  import {
    coordinationMessageForText,
    coordinationPrompt,
    type CoordinationMessage,
  } from './lib/coordination';
  import { splitKlaudiushMessage, type KlaudiushRule } from './lib/klaudiush';
  import type { PostTurnCheck } from './lib/post-turn-checks';
  import { splitShellCommands, type ShellRun } from './lib/shell-command';
  import type { SubagentControl } from './lib/subagent-control';
  import {
    isFailedStatus,
    notificationStats,
    splitTaskNotifications,
    type TaskSegment,
  } from './lib/task-notification';
  import {
    currentToolGroup,
    toolFailed,
    toolRunning,
    type TranscriptItem,
    type TranscriptTool,
  } from './lib/transcript';
  import type { ShellSegment } from './lib/shell-command';

  let {
    items,
    busy = false,
    coordinationMessages = [],
    onopen,
    control,
    onterminal,
    onretrycheck = () => {},
    onstopshell = () => {},
    ontoolfix,
    failure,
    queuedActions,
    tail,
  }: {
    items: TranscriptItem[];
    busy?: boolean;
    coordinationMessages?: CoordinationMessage[];
    onopen?: (receipt: SpawnReceipt) => Promise<void>;
    control?: SubagentControl;
    onterminal?: (id: string) => void;
    onretrycheck?: (check: PostTurnCheck) => void;
    onstopshell?: (run: ShellRun) => void;
    /** Offered on failed tools when the host can hand the failure to the agent. */
    ontoolfix?: (tool: TranscriptTool) => void;
    /** Host card for a failed tool, shown above its group. */
    failure?: Snippet<[TranscriptTool]>;
    queuedActions?: Snippet;
    tail?: Snippet;
  } = $props();

  const queued = $derived(items.filter((item) => item.kind === 'message' && item.queued));
  const flow = $derived(items.filter((item) => !(item.kind === 'message' && item.queued)));

  function userSegments(text: string): (TaskSegment | ShellSegment)[] {
    return splitShellCommands(text).flatMap((part): (TaskSegment | ShellSegment)[] =>
      part.type === 'text' ? splitTaskNotifications(part.text) : [part],
    );
  }
</script>

{#snippet hookNotice(rules: KlaudiushRule[])}
  <div class="agent-hook-notice">
    <strong>Action blocked by hook</strong>
    <ul>
      {#each rules as rule (rule.code)}
        <li><code>{rule.code}</code> {rule.reason}</li>
      {/each}
    </ul>
  </div>
{/snippet}

{#snippet toolRow(tool: TranscriptTool, revealed: boolean)}
  <ToolActivity
    title={tool.title}
    status={tool.status}
    activityId={tool.id}
    input={tool.input}
    output={tool.output}
    error={tool.error}
    source={tool.source}
    expanded={revealed}
    onfix={toolFailed(tool) && ontoolfix && tool.error ? () => ontoolfix(tool) : undefined}
  >
    {#each tool.terminalIds as terminalId (terminalId)}
      <button onclick={() => onterminal?.(terminalId)}>Open terminal</button>
    {/each}
  </ToolActivity>
{/snippet}

{#snippet messageBody(item: Extract<TranscriptItem, { kind: 'message' }>)}
  {@const segments =
    item.role === 'user' ? userSegments(item.text) : [{ type: 'text' as const, text: item.text }]}
  {#each segments as segment, index (index)}
    {#if segment.type === 'shell'}
      <ShellCommandCard run={segment.shell} />
    {:else if segment.type === 'notification'}
      {@const note = segment.notification}
      <div
        class="agent-subagent-card"
        class:stopped={note.status !== 'completed'}
        aria-label={`Subagent ${note.status}`}
        role="group"
      >
        <ActivityStatus status={isFailedStatus(note.status) ? 'failed' : note.status} compact />
        <span class="agent-subagent-summary">{note.summary}</span>
        {#each notificationStats(note) as stat (stat)}<span class="agent-subagent-stat">{stat}</span
          >{/each}
      </div>
    {:else}
      {@const text = segment.text}
      {@const hookMessage = item.role === 'assistant' ? splitKlaudiushMessage(text) : null}
      {@const attribution =
        item.role === 'user' ? coordinationMessageForText(text, coordinationMessages) : undefined}
      {#if hookMessage}
        {@render hookNotice(hookMessage.rules)}
        <details class="agent-hook-details">
          <summary>Full hook notice</summary>
          <Markdown source={hookMessage.notice} />
        </details>
        {#if hookMessage.remainder}<Markdown source={hookMessage.remainder} />{/if}
      {:else if text}
        <Markdown
          source={attribution
            ? text.replace(coordinationPrompt(attribution), attribution.text)
            : text}
        />
      {/if}
    {/if}
  {/each}
  {#if item.files?.length}<div class="message-files">
      {#each item.files as file, index (index)}<span>{file}</span>{/each}
    </div>{/if}
  {#if item.retry}<p class="retry-state" role="status">{item.retry}</p>{/if}
  {#if item.error}<p class="message-error" role="alert">{item.error}</p>{/if}
{/snippet}

{#each flow as item (item.id)}
  {#if item.kind === 'spawn-response'}
    <SpawnResponse receipt={item.receipt} {onopen} />
  {:else if item.kind === 'tools'}
    {#each item.tools.filter(toolFailed) as tool (tool.id)}{#if failure}{@render failure(
          tool,
        )}{/if}{/each}
    {#if currentToolGroup(item, flow, busy)}
      {#if item.tools.length > 1}
        <details class="agent-tool-group">
          <summary>
            {item.tools.length - 1} earlier {item.tools.length === 2 ? 'action' : 'actions'}
            {#if item.tools.slice(0, -1).some(toolRunning)}<ActivityStatus
                status="working"
                compact
              />{/if}
            {#if item.tools.slice(0, -1).some(toolFailed)}<ActivityStatus
                status="failed"
                compact
              />{/if}
          </summary>
          <div class="agent-tool-list">
            {#each item.tools.slice(0, -1) as tool (tool.id)}
              {@render toolRow(tool, true)}
            {/each}
          </div>
        </details>
      {/if}
      {@const latest = item.tools.at(-1)}
      {#if latest}
        <div class="agent-tool-current" class:running={toolRunning(latest)}>
          <span class="agent-tool-current-label">Latest action</span>
          {@render toolRow(latest, false)}
        </div>
      {/if}
    {:else}
      <details class="agent-tool-group">
        <summary>
          <span>{item.tools.length} {item.tools.length === 1 ? 'action' : 'actions'}</span>
          <span class="agent-tool-group-last">{item.tools.at(-1)?.title}</span>
          {#if item.tools.at(-1)?.status !== 'completed' && !toolFailed(item.tools.at(-1)!)}<ActivityStatus
              status={item.tools.at(-1)?.status}
              compact
            />{/if}
          {#if item.tools.slice(0, -1).some(toolRunning)}<ActivityStatus
              status="working"
              compact
            />{/if}
          {#if item.tools.some(toolFailed)}<ActivityStatus status="failed" compact />{/if}
        </summary>
        <div class="agent-tool-list">
          {#each item.tools as tool (tool.id)}
            {@render toolRow(tool, true)}
          {/each}
        </div>
      </details>
    {/if}
  {:else if item.kind === 'message'}
    {#if item.text || item.retry || item.error || item.files?.length}
      {@const attribution =
        item.role === 'user'
          ? coordinationMessageForText(item.text, coordinationMessages)
          : undefined}
      <ChatMessage
        kind={item.role}
        created={item.created}
        messageId={item.id}
        provider={item.provider}
        author={attribution ? `From ${attribution.sender}` : item.author}
      >
        {@render messageBody(item)}
      </ChatMessage>
    {/if}
  {:else if item.kind === 'shell'}
    <ShellCommandCard run={item.run} pending onstop={() => onstopshell(item.run)} />
  {:else if item.kind === 'hook'}
    <HookActivityCard activity={item.activity} />
  {:else if item.kind === 'checks'}
    <PostTurnChecks checks={item.checks} onretry={onretrycheck} />
  {:else if item.kind === 'subagents'}
    <SpawnActivity receipts={item.receipts} {onopen} {control} />
  {/if}
{/each}
{#if queued.length}<div class="queued-messages" role="status" aria-label="Queued messages">
    {#each queued as item (item.id)}
      {#if item.kind === 'message'}
        <ChatMessage kind="user" author={item.author} provider={item.provider}>
          <Markdown source={item.text} />
        </ChatMessage>
      {/if}
    {/each}
    {#if queuedActions}{@render queuedActions()}{/if}
  </div>{/if}
{#if tail}{@render tail()}{/if}

<style>
  .agent-tool-group,
  .agent-tool-current {
    margin: 0 0 8px 42px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
  }
  .agent-hook-notice {
    margin: 0 0 8px;
    padding: 9px 12px;
    border: 1px solid var(--sui-danger);
    border-radius: 8px;
  }
  .agent-hook-notice strong {
    color: var(--sui-danger-ink);
  }
  .agent-hook-notice ul {
    margin: 5px 0 0;
    padding-left: 20px;
  }
  .agent-hook-notice code {
    margin-right: 4px;
  }
  .agent-hook-details {
    margin-bottom: 8px;
    color: var(--sui-muted);
  }
  .agent-tool-group > summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    color: var(--sui-muted);
    cursor: pointer;
  }
  .agent-tool-group-last {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-tool-group > summary::before {
    content: '▸';
    flex: 0 0 auto;
  }
  .agent-tool-group[open] > summary::before {
    transform: rotate(90deg);
  }
  .agent-tool-list {
    padding: 0 12px 10px;
  }
  .agent-subagent-card {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    margin: 0 0 8px 42px;
    padding: 8px 12px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
  }
  .agent-subagent-card.stopped {
    border-style: dashed;
  }
  .agent-subagent-summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .agent-subagent-stat {
    color: var(--sui-muted);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .agent-tool-current {
    padding: 7px 12px;
  }
  .agent-tool-current.running {
    border-color: var(--sui-primary);
  }
  .agent-tool-current-label {
    display: block;
    margin-bottom: 2px;
    color: var(--sui-muted);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .queued-messages :global(.agent-message) {
    opacity: 0.6;
  }
</style>

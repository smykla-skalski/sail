<script lang="ts">
  import Markdown from './Markdown.svelte';
  import ActivityStatus from './ActivityStatus.svelte';
  import { activityState } from './lib/activity-state';
  import type { SpawnReceipt } from './lib/agent-results';
  import { boundedSpawnOutput, receiptNeedsLiveActivity } from './lib/agent-results';
  import {
    lastSignalAge,
    stateAnnouncement,
    subagentDurationMs,
    subagentType,
    toolCountLabel,
  } from './lib/subagent-display';
  import { formatDuration } from './lib/task-notification';
  import {
    childPermissions,
    parentTurnStopHint,
    permissionAlreadyAnswered,
    stoppableSubagents,
    subagentStop,
    type SubagentControl,
  } from './lib/subagent-control';
  import type { InboxItem } from './lib/inbox';
  import { onMount } from 'svelte';

  let {
    receipts,
    onopen,
    control,
  }: {
    receipts: SpawnReceipt[];
    onopen?: (receipt: SpawnReceipt) => Promise<void>;
    control?: SubagentControl;
  } = $props();
  const active = $derived(receipts.filter(receiptNeedsLiveActivity));
  const stoppable = $derived(control ? stoppableSubagents(active, control.shipOwned) : []);
  let busy = $state<string[]>([]);
  let actionErrors = $state<Record<string, string>>({});

  async function act(id: string, run: () => Promise<void>) {
    if (busy.includes(id)) return;
    busy = [...busy, id];
    const next = { ...actionErrors };
    delete next[id];
    actionErrors = next;
    try {
      await run();
    } catch (cause) {
      if (!permissionAlreadyAnswered(cause))
        actionErrors = {
          ...actionErrors,
          [id]: cause instanceof Error ? cause.message : String(cause),
        };
    } finally {
      busy = busy.filter((item) => item !== id);
    }
  }

  function decide(item: InboxItem, optionId: string) {
    return act(item.key, () => control!.ondecide(item, optionId));
  }
  let expanded = $state<string[]>([]);
  let opening = $state<string[]>([]);
  let openErrors = $state<Record<string, string>>({});

  let now = $state(Date.now());
  let announcement = $state('');
  let announced: Record<string, string> = {};

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(timer);
  });

  // One announcement per group: it names only children whose state changed since the last
  // update. Activity text and clock ticks never reach it. The first update only records states.
  $effect(() => {
    const changes: string[] = [];
    const seen: Record<string, string> = {};
    for (const receipt of receipts) {
      seen[receipt.receiptId] = receipt.state;
      const previous = announced[receipt.receiptId];
      if (previous !== undefined && previous !== receipt.state)
        changes.push(stateAnnouncement(receipt));
    }
    announced = seen;
    if (changes.length) announcement = changes.join('. ');
  });

  function label(receipt: SpawnReceipt): string {
    return subagentType(receipt);
  }

  function elapsed(receipt: SpawnReceipt): string {
    const duration = subagentDurationMs(receipt, now);
    return duration === null ? '' : formatDuration(duration);
  }

  function activity(receipt: SpawnReceipt): string {
    if (receipt.state === 'waiting') return 'Needs your input';
    if (receipt.activity) return receipt.activity;
    if (receipt.result) return 'Writing response…';
    if (receipt.state === 'queued' || receipt.state === 'starting') return 'Waiting to start…';
    if (['completed', 'failed', 'interrupted', 'unavailable'].includes(receipt.state))
      return activityState(receipt.state).label;
    return 'Starting task…';
  }

  function signalDate(receipt: SpawnReceipt): Date {
    const updated = Number.isFinite(receipt.updated) ? receipt.updated : 0;
    const date = new Date(updated);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
  }

  function toggle(id: string) {
    expanded = expanded.includes(id)
      ? expanded.filter((receiptId) => receiptId !== id)
      : [...expanded, id];
  }

  function keepComposerSelection(event: PointerEvent) {
    if (event.button === 0) event.preventDefault();
  }

  async function open(receipt: SpawnReceipt) {
    if (
      !onopen ||
      !receipt.targetId ||
      !receipt.targetDirectory ||
      opening.includes(receipt.receiptId)
    )
      return;
    opening = [...opening, receipt.receiptId];
    const nextErrors = { ...openErrors };
    delete nextErrors[receipt.receiptId];
    openErrors = nextErrors;
    try {
      await onopen(receipt);
    } catch (cause) {
      openErrors = {
        ...openErrors,
        [receipt.receiptId]: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      opening = opening.filter((id) => id !== receipt.receiptId);
    }
  }
</script>

<div class="spawn-announcer" role="status" aria-live="polite" aria-atomic="true">
  {announcement}
</div>
{#if active.length}
  <section class="spawn-activity" aria-label="Subagent activity">
    <div class="spawn-activity-heading">
      <h2>Subagents ({active.length})</h2>
      {#if control && stoppable.length > 1}<button
          class="spawn-stop"
          aria-label="Stop all subagents"
          disabled={busy.includes('stop-all')}
          onpointerdown={keepComposerSelection}
          onclick={() => void act('stop-all', () => control.onstopall(stoppable))}
          >{busy.includes('stop-all') ? 'Stopping…' : 'Stop all'}</button
        >{/if}
    </div>
    {#if actionErrors['stop-all']}<p class="spawn-error" role="alert">
        {actionErrors['stop-all']}
      </p>{/if}
    {#each active as receipt (receipt.receiptId)}
      <article
        class="spawn-active state-{receipt.state}"
        data-spawn-id={receipt.receiptId}
        tabindex="-1"
        role="group"
        aria-label={`${label(receipt)} subagent`}
      >
        <div class="spawn-heading">
          <button
            class="spawn-toggle"
            aria-label={`${expanded.includes(receipt.receiptId) ? 'Collapse' : 'Expand'} ${label(receipt)} subagent task: ${receipt.prompt ?? 'Task details unavailable'}`}
            aria-expanded={expanded.includes(receipt.receiptId)}
            aria-controls={`spawn-details-${receipt.receiptId}`}
            onpointerdown={keepComposerSelection}
            onclick={() => toggle(receipt.receiptId)}
          >
            <span class="spawn-chevron" aria-hidden="true"
              >{expanded.includes(receipt.receiptId) ? '▾' : '▸'}</span
            >
            <span class="spawn-avatar" aria-hidden="true">↳</span>
            <strong>{label(receipt)} <span class="spawn-kind">subagent</span></strong>
          </button>
          <ActivityStatus status={receipt.state} compact />
          {#if receipt.targetId && receipt.targetDirectory && onopen}<button
              class="spawn-open"
              aria-label={`Open ${label(receipt)} subagent thread for ${receipt.prompt ?? 'task details unavailable'}`}
              disabled={opening.includes(receipt.receiptId)}
              onpointerdown={keepComposerSelection}
              onclick={() => void open(receipt)}
              >{opening.includes(receipt.receiptId) ? 'Opening…' : 'Open thread'}</button
            >{/if}
        </div>
        <p class="spawn-task">
          <strong>Task</strong>
          {receipt.prompt ?? 'Task details unavailable'}
        </p>
        <div class="spawn-signal">
          <span>{activity(receipt)}</span>
          <span class="spawn-clock">
            {#if elapsed(receipt)}<span>{elapsed(receipt)}</span>{/if}
            {#if receipt.toolCount !== undefined}<span>{toolCountLabel(receipt.toolCount)}</span
              >{/if}
            <time
              datetime={signalDate(receipt).toISOString()}
              title={signalDate(receipt).toLocaleString()}
              >Last signal {lastSignalAge(receipt, now) ?? 'unknown'}</time
            >
          </span>
        </div>
        {#if control}
          {@const stop = subagentStop(receipt, control.shipOwned)}
          {@const permissions = childPermissions(control, receipt)}
          {#each permissions.pending as item (item.key)}
            <div
              class="spawn-permission"
              role="group"
              aria-label="Subagent permission request"
              data-request-id={item.requestId}
              data-session-id={item.sessionId}
              data-agent-id={item.agentId}
              tabindex="-1"
            >
              <strong>{item.permissionTitle ?? item.text}</strong>
              <div class="spawn-permission-options">
                {#each item.options ?? [] as option (option.optionId)}{#if item.policy?.recommendation !== 'deny' || !option.kind.startsWith('allow')}<button
                      class="spawn-permission-option"
                      class:allow={option.kind.startsWith('allow')}
                      disabled={busy.includes(item.key)}
                      onpointerdown={keepComposerSelection}
                      onclick={() => void decide(item, option.optionId)}>{option.name}</button
                    >{/if}{/each}
              </div>
              {#if actionErrors[item.key]}<p class="spawn-error" role="alert">
                  {actionErrors[item.key]}
                </p>{/if}
            </div>
          {/each}
          {#each permissions.answered as note (note.key)}
            <p class="spawn-permission-answered" role="status" data-answered-key={note.key}>
              Answered · {note.title}
            </p>
          {/each}
          {#if stop === 'stop'}
            <div class="spawn-controls">
              <button
                class="spawn-stop"
                aria-label={`Stop ${label(receipt)} subagent`}
                disabled={busy.includes(receipt.receiptId)}
                onpointerdown={keepComposerSelection}
                onclick={() => void act(receipt.receiptId, () => control.onstop(receipt))}
                >{busy.includes(receipt.receiptId) ? 'Stopping…' : 'Stop'}</button
              >
            </div>
          {:else if stop === 'parent-turn'}
            <p class="spawn-stop-hint">{parentTurnStopHint}</p>
          {/if}
          {#if actionErrors[receipt.receiptId]}<p class="spawn-error" role="alert">
              {actionErrors[receipt.receiptId]}
            </p>{/if}
        {/if}
        {#if !receipt.targetId || !receipt.targetDirectory}<p class="spawn-unavailable">
            Thread unavailable — the child has not confirmed a target yet.
          </p>{/if}
        {#if openErrors[receipt.receiptId]}<p class="spawn-error" role="alert">
            Thread unavailable — {openErrors[receipt.receiptId]}
          </p>{/if}
        <div
          class="spawn-details"
          id={`spawn-details-${receipt.receiptId}`}
          hidden={!expanded.includes(receipt.receiptId)}
        >
          {#if boundedSpawnOutput(receipt)}<div class="spawn-output">
              <Markdown source={boundedSpawnOutput(receipt)} />
            </div>{:else}<p class="spawn-empty">No output confirmed yet.</p>{/if}
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .spawn-activity {
    margin: 12px 0 16px 42px;
  }
  .spawn-activity h2 {
    margin: 0 0 8px;
    font-size: 0.85rem;
  }
  .spawn-activity-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    width: min(100%, 720px);
  }
  .spawn-controls,
  .spawn-permission {
    margin: 8px 0 0 42px;
  }
  .spawn-permission {
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--activity-waiting);
    border-radius: var(--radius-6);
    background: color-mix(in srgb, var(--activity-waiting) 8%, var(--sui-surface));
    font-size: 0.83rem;
  }
  .spawn-permission-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .spawn-permission-option,
  .spawn-stop {
    min-height: 28px;
    padding: 3px 10px;
    border: 1px solid var(--shell-divider);
    border-radius: var(--radius-6);
    color: var(--sui-foreground);
    background: transparent;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .spawn-permission-option.allow {
    border-color: var(--sui-primary);
    color: var(--sui-primary);
  }
  .spawn-permission-option:disabled,
  .spawn-stop:disabled {
    cursor: wait;
    opacity: 0.6;
  }
  .spawn-permission-answered,
  .spawn-stop-hint {
    margin: 8px 0 0 42px;
    color: var(--sui-muted);
    font-size: 0.76rem;
  }
  .spawn-active {
    --spawn-color: var(--activity-working);
    width: min(100%, 720px);
    margin-bottom: 8px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--spawn-color) 35%, transparent);
    border-left: 3px solid var(--spawn-color);
    border-radius: var(--radius-8);
    background: color-mix(in srgb, var(--spawn-color) 5%, var(--sui-surface));
  }
  .spawn-active.state-waiting {
    --spawn-color: var(--activity-waiting);
  }
  .spawn-active.state-completed {
    --spawn-color: var(--activity-completed);
  }
  .spawn-active.state-failed {
    --spawn-color: var(--activity-failed);
  }
  .spawn-active.state-interrupted,
  .spawn-active.state-unavailable,
  .spawn-active.state-queued,
  .spawn-active.state-starting {
    --spawn-color: var(--activity-neutral);
  }
  .spawn-heading {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }
  .spawn-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-8);
    padding: 0;
    border: 0;
    color: inherit;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .spawn-toggle strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spawn-chevron {
    width: 10px;
    color: var(--sui-muted);
  }
  .spawn-avatar {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    color: var(--spawn-color);
    background: color-mix(in srgb, var(--spawn-color) 15%, transparent);
  }
  .spawn-kind,
  .spawn-prompt {
    color: var(--sui-muted);
  }
  .spawn-kind {
    font-weight: 400;
  }
  .spawn-open {
    border: 0;
    padding: 3px 5px;
    color: var(--sui-primary);
    background: transparent;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .spawn-open:disabled {
    cursor: wait;
    opacity: 0.6;
  }
  .spawn-task {
    margin: 8px 0 0 42px;
    font-size: 0.83rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spawn-task strong {
    margin-right: 5px;
    color: var(--sui-muted);
    font-size: var(--type-12);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .spawn-signal {
    display: flex;
    justify-content: space-between;
    gap: var(--space-12);
    margin: 5px 0 0 42px;
    color: var(--sui-muted);
    font-size: 0.76rem;
  }
  .spawn-signal > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spawn-clock {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 3px 10px;
    font-variant-numeric: tabular-nums;
  }
  .spawn-announcer {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .spawn-unavailable,
  .spawn-error,
  .spawn-empty {
    margin: 7px 0 0 42px;
    color: var(--sui-muted);
    font-size: 0.76rem;
  }
  .spawn-error {
    color: var(--sui-danger);
  }
  .spawn-details {
    margin: 9px -12px -10px;
    padding: 9px 12px 10px;
    border-top: 1px solid color-mix(in srgb, var(--spawn-color) 20%, transparent);
  }
  .spawn-output {
    max-height: 240px;
    overflow: auto;
    overflow-wrap: anywhere;
  }
  .spawn-output :global(:first-child) {
    margin-top: 0;
  }
  .spawn-output :global(:last-child) {
    margin-bottom: 0;
  }
  @media (max-width: 620px) {
    .spawn-signal {
      display: block;
    }
    .spawn-clock {
      justify-content: flex-start;
      margin-top: 3px;
    }
    .spawn-open {
      font-size: 0;
    }
    .spawn-open::after {
      content: 'Open';
      font-size: 0.78rem;
    }
  }
</style>

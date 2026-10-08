<script lang="ts">
  import type { TaskLocation } from './lib/task-location';

  let { location }: { location: TaskLocation } = $props();
  const accessibleLabel = $derived(
    location.known
      ? `Task location: ${location.repository}, branch ${location.branch}`
      : location.repository
        ? `Task location: ${location.repository}, unknown branch or worktree`
        : 'Task location unknown',
  );
  const fullLabel = $derived(
    location.known
      ? `${location.repository} / ${location.branch}`
      : location.repository
        ? `${location.repository} / Unknown location`
        : 'Unknown task location',
  );
</script>

<div class="task-location" role="note" aria-label={accessibleLabel} title={fullLabel}>
  <span class="task-location-marker" aria-hidden="true">⌖</span>
  {#if location.repository}<span class="task-location-repository" dir="auto"
      >{location.repository}</span
    ><span class="task-location-separator" aria-hidden="true">/</span>{/if}
  <span class:unknown={!location.known} class="task-location-branch" dir="auto"
    >{location.known ? location.branch : location.repository ? 'Unknown location' : fullLabel}</span
  >
</div>

<style>
  .task-location {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 7px 12px 0;
    color: var(--sui-muted);
    font-size: var(--type-12);
    line-height: 1.4;
  }
  .task-location-marker,
  .task-location-separator {
    flex: 0 0 auto;
    opacity: 0.7;
  }
  .task-location-repository,
  .task-location-branch {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    unicode-bidi: plaintext;
    white-space: nowrap;
  }
  .task-location-repository {
    max-width: 40%;
    flex: 0 1 auto;
    color: var(--sui-foreground, inherit);
    font-weight: 600;
  }
  .task-location-branch {
    flex: 1 1 auto;
  }
  .task-location-branch.unknown {
    font-style: italic;
  }
</style>

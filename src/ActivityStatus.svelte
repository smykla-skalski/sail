<script lang="ts">
  import { activityState } from './lib/activity-state';

  let {
    status,
    label,
    compact = false,
  }: { status: string | null | undefined; label?: string; compact?: boolean } = $props();
  const info = $derived(activityState(status));
</script>

<span
  class="activity-status"
  class:compact
  data-state={info.state}
  aria-label={label ?? info.label}
>
  <span class="activity-status-icon" aria-hidden="true">{info.icon}</span>
  <span>{label ?? info.label}</span>
</span>

<style>
  .activity-status {
    --activity-color: var(--activity-neutral);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    padding: 3px 7px;
    border: 1px solid color-mix(in srgb, var(--activity-color) 30%, transparent);
    border-radius: 999px;
    color: var(--activity-color);
    background: color-mix(in srgb, var(--activity-color) 8%, transparent);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
  }
  .activity-status.compact {
    gap: 3px;
    padding: 1px 4px;
    border-color: transparent;
    background: transparent;
    font-size: 10px;
  }
  .activity-status[data-state='working'] {
    --activity-color: var(--activity-working);
  }
  .activity-status[data-state='fixing'] {
    --activity-color: var(--activity-fixing);
  }
  .activity-status[data-state='stalled'] {
    --activity-color: var(--activity-stalled);
  }
  .activity-status[data-state='waiting'] {
    --activity-color: var(--activity-waiting);
  }
  .activity-status[data-state='completed'],
  .activity-status[data-state='ready'] {
    --activity-color: var(--activity-completed);
  }
  .activity-status[data-state='failed'],
  .activity-status[data-state='interrupted'] {
    --activity-color: var(--activity-failed);
  }
  .activity-status-icon {
    flex: 0 0 auto;
    width: 1em;
    text-align: center;
  }
  .activity-status[data-state='working'] .activity-status-icon,
  .activity-status[data-state='fixing'] .activity-status-icon {
    animation: activity-pulse 1.4s ease-in-out infinite;
  }
  @keyframes activity-pulse {
    50% {
      opacity: 0.35;
      transform: scale(0.8);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .activity-status[data-state='working'] .activity-status-icon,
    .activity-status[data-state='fixing'] .activity-status-icon {
      animation: none;
    }
  }
</style>

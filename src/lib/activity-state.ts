export type ActivityState =
  | 'working'
  | 'fixing'
  | 'stalled'
  | 'waiting'
  | 'queued'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'offline'
  | 'unknown'
  | 'connecting'
  | 'ready';

export type ActivityStateInfo = {
  state: ActivityState;
  label: string;
  icon: string;
};

const activityStates: Record<ActivityState, ActivityStateInfo> = {
  working: { state: 'working', label: 'Working', icon: '●' },
  fixing: { state: 'fixing', label: 'Fixing', icon: '↻' },
  stalled: { state: 'stalled', label: 'Stalled', icon: '‖' },
  waiting: { state: 'waiting', label: 'Needs input', icon: '!' },
  queued: { state: 'queued', label: 'Queued', icon: '◷' },
  completed: { state: 'completed', label: 'Completed', icon: '✓' },
  failed: { state: 'failed', label: 'Failed', icon: '×' },
  interrupted: { state: 'interrupted', label: 'Interrupted', icon: '■' },
  offline: { state: 'offline', label: 'Offline', icon: '○' },
  unknown: { state: 'unknown', label: 'Unknown', icon: '?' },
  connecting: { state: 'connecting', label: 'Connecting', icon: '…' },
  ready: { state: 'ready', label: 'Ready', icon: '✓' },
};

const aliases: Record<string, ActivityState> = {
  working: 'working',
  running: 'working',
  in_progress: 'working',
  stopping: 'working',
  fixing: 'fixing',
  stalled: 'stalled',
  waiting: 'waiting',
  needs_input: 'waiting',
  blocked: 'waiting',
  queued: 'queued',
  pending: 'queued',
  starting: 'queued',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  succeeded: 'completed',
  success: 'completed',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  killed: 'failed',
  rejected: 'failed',
  interrupted: 'interrupted',
  stopped: 'interrupted',
  cancelled: 'interrupted',
  canceled: 'interrupted',
  unavailable: 'offline',
  offline: 'offline',
  disconnected: 'offline',
  unknown: 'unknown',
  connecting: 'connecting',
  ready: 'ready',
};

export function activityState(value: string | null | undefined): ActivityStateInfo {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replaceAll(/[\s-]+/g, '_') ?? 'unknown';
  return activityStates[aliases[normalized] ?? 'unknown'];
}

export type HookOutcome = 'observed' | 'blocked' | 'failed' | 'completed';

export type HookActivity = {
  id: string;
  provider: string;
  sessionId: string;
  event: string;
  source: string;
  outcome: HookOutcome;
  action?: string | null;
  reason?: string | null;
  actor?: string | null;
  created: number;
  diagnostics: unknown;
};

function hookOutcome(value: unknown): value is HookOutcome {
  return value === 'observed' || value === 'blocked' || value === 'failed' || value === 'completed';
}

export function parseHookActivity(value: unknown): HookActivity | null {
  if (!value || typeof value !== 'object') return null;
  const get = (name: string): unknown => Reflect.get(value, name);
  const outcome = get('outcome');
  if (
    typeof get('id') !== 'string' ||
    typeof get('provider') !== 'string' ||
    typeof get('sessionId') !== 'string' ||
    typeof get('event') !== 'string' ||
    typeof get('source') !== 'string' ||
    !hookOutcome(outcome) ||
    typeof get('created') !== 'number'
  )
    return null;
  const optional = (name: string) => {
    const found = get(name);
    return typeof found === 'string' ? found : null;
  };
  return {
    id: String(get('id')),
    provider: String(get('provider')),
    sessionId: String(get('sessionId')),
    event: String(get('event')),
    source: String(get('source')),
    outcome,
    action: optional('action'),
    reason: optional('reason'),
    actor: optional('actor'),
    created: Number(get('created')),
    diagnostics: get('diagnostics'),
  };
}

export function activityForSession(
  activities: HookActivity[],
  sessionId: string | null,
): HookActivity[] {
  if (!sessionId) return [];
  return activities.filter((item) => item.sessionId === sessionId).slice(-100);
}

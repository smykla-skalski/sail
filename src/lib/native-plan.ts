/** Provider-neutral view of plans announced through ACP session updates. */
export type NativePlan = {
  provider: 'claude' | 'codex' | 'opencode';
  markdown: string;
  updated: number;
  tasks: { title: string; status: string }[];
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function markdown(value: unknown): string | null {
  const item = record(value);
  if (!item) return text(value);
  return text(item.markdown) ?? text(item.plan) ?? text(item.text) ?? text(item.content);
}

function tasks(value: unknown): NativePlan['tasks'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const task = record(item);
    const title = task && (text(task.title) ?? text(task.step) ?? text(task.description));
    return title ? [{ title, status: text(task?.status) ?? 'pending' }] : [];
  });
}

/** ACP's standard `plan` update carries the full entry list on every change. */
function entries(value: unknown): NativePlan['tasks'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    const title = entry && text(entry.content);
    return title ? [{ title, status: text(entry?.status) ?? 'pending' }] : [];
  });
}

/**
 * Codex emits `plan_update`; Claude's ExitPlanMode tool input is the
 * authoritative implementation plan. Task stream updates are deliberately
 * not treated as Claude plans.
 */
export function nativePlanUpdate(
  provider: string,
  update: unknown,
  previous: NativePlan | null = null,
  updated = Date.now(),
): NativePlan | null {
  const data = record(update);
  if (!data || (provider !== 'claude' && provider !== 'codex' && provider !== 'opencode'))
    return previous;
  if (provider === 'opencode' && data.sessionUpdate === 'plan') {
    const progress = entries(data.entries);
    if (!progress.length) return previous;
    return {
      provider,
      markdown: progress
        .map((task) => `- [${task.status === 'completed' ? 'x' : ' '}] ${task.title}`)
        .join('\n'),
      tasks: progress,
      updated,
    };
  }
  if (provider === 'codex' && data.sessionUpdate === 'plan_update') {
    const plan = markdown(data.plan) ?? markdown(data);
    if (!plan) return previous;
    const planData = record(data.plan);
    const progress = tasks(planData?.steps ?? data.plan);
    return {
      provider,
      markdown: plan,
      tasks: progress.length ? progress : tasks(data.steps),
      updated,
    };
  }
  if (
    provider === 'claude' &&
    ['tool_call', 'tool_call_update'].includes(String(data.sessionUpdate))
  ) {
    const title = text(data.title);
    if (title !== 'ExitPlanMode') return previous;
    const input = record(data.input) ?? record(data.rawInput) ?? record(data.arguments);
    const plan = markdown(input) ?? markdown(data.content);
    if (!plan) return previous;
    return { provider, markdown: plan, tasks: [], updated };
  }
  return previous;
}

/** Replay starts from an empty state and reuses the same reducer as live updates. */
export function replayNativePlan(provider: string, updates: readonly unknown[]): NativePlan | null {
  return updates.reduce<NativePlan | null>(
    (plan, update) => nativePlanUpdate(provider, update, plan),
    null,
  );
}

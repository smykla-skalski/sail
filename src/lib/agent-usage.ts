export type RateWindow = { label: string; remaining: number; resetsAt?: number };
export type AgentUsage = {
  context?: number;
  contextTokens?: number;
  contextWindow?: number;
  rates?: RateWindow[];
};

export function contextUsageLabel(usage: AgentUsage): string {
  return usage.contextWindow === undefined
    ? 'Context window unknown'
    : `Context ${usage.context ?? 0}% · ${usage.contextTokens?.toLocaleString('en-US')} / ${usage.contextWindow.toLocaleString('en-US')} tokens`;
}

function percentage(used: unknown, size: unknown): number | undefined {
  if (
    typeof used !== 'number' ||
    typeof size !== 'number' ||
    !Number.isFinite(used) ||
    !Number.isFinite(size) ||
    used < 0 ||
    size <= 0
  )
    return undefined;
  return Math.min(100, Math.round((used / size) * 100));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function remaining(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? Math.round((1 - value) * 100)
    : undefined;
}

function resetTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value * 1000
    : undefined;
}

function rateWindow(label: string, source: Record<string, unknown> | null): RateWindow | null {
  const value = remaining(source?.utilization);
  if (value === undefined) return null;
  const resetsAt = resetTime(source?.resetsAt);
  if (resetsAt !== undefined && resetsAt <= Date.now()) return null;
  return { label, remaining: value, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

export function acpUsage(update: unknown, previous: AgentUsage = {}): AgentUsage | null {
  const data = record(update);
  if (data?.sessionUpdate !== 'usage_update') return null;
  const context = percentage(data.used, data.size);
  const contextUsage = {
    context,
    contextTokens: context !== undefined && typeof data.used === 'number' ? data.used : undefined,
    contextWindow: context !== undefined && typeof data.size === 'number' ? data.size : undefined,
  };
  const metadata = record(data['_meta']);
  const rate = record(metadata?.['_claude/rateLimit']);
  if (!rate) return { ...previous, ...contextUsage };
  const windows = record(rate.unifiedWindows);
  const rates: RateWindow[] = [];
  for (const [key, label] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ]) {
    const window = rateWindow(label, record(windows?.[key]));
    if (window) rates.push(window);
  }
  if (
    rates.length === 0 &&
    (rate.rateLimitType === 'five_hour' || rate.rateLimitType === 'seven_day')
  ) {
    const window = rateWindow(rate.rateLimitType === 'five_hour' ? '5h' : '7d', rate);
    if (window) rates.push(window);
  }
  return { ...contextUsage, rates };
}

import { getSetting } from './settings.ts';
import { ResourceQueue } from './resource-queue.ts';

export type ResourceKind = 'agent' | 'browser';
export const resourceLimitKeys = {
  agent: 'sai-agent-job-limit',
  browser: 'sai-browser-job-limit',
  e2e: 'sai-e2e-job-limit',
} as const;
export const defaultResourceLimits = { agent: 4, browser: 2, e2e: 1 } as const;

export function parseResourceLimit(value: string | null, fallback: number): number {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return fallback;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= 32 ? limit : fallback;
}

export const resourceQueues: Record<ResourceKind, ResourceQueue> = {
  agent: new ResourceQueue(
    parseResourceLimit(
      typeof localStorage === 'undefined' ? null : getSetting(resourceLimitKeys.agent),
      defaultResourceLimits.agent,
    ),
  ),
  browser: new ResourceQueue(
    parseResourceLimit(
      typeof localStorage === 'undefined' ? null : getSetting(resourceLimitKeys.browser),
      defaultResourceLimits.browser,
    ),
  ),
};

export function setResourceLimit(kind: ResourceKind, limit: number): void {
  resourceQueues[kind].setLimit(limit);
}

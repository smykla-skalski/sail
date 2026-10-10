import { invoke } from '@tauri-apps/api/core';
import { getSetting } from './settings.ts';
import { ResourceQueue } from './resource-queue.ts';
import {
  defaultPressureThresholds,
  parsePressureThreshold,
  pressureReason,
  pressureThresholdKeys,
  type MachineReading,
  type PressureThresholds,
} from './machine-pressure.ts';

export type ResourceKind = 'agent' | 'browser';
export const resourceLimitKeys = {
  agent: 'sai-agent-job-limit',
  browser: 'sai-browser-job-limit',
  e2e: 'sai-e2e-job-limit',
} as const;
export const defaultResourceLimits = { agent: 4, browser: 2, e2e: 1 } as const;
const checkingReason = 'Checking machine pressure…';

let pressureThresholds: PressureThresholds = {
  memoryFreePercent: parsePressureThreshold(
    typeof localStorage === 'undefined'
      ? null
      : getSetting(pressureThresholdKeys.memoryFreePercent),
    defaultPressureThresholds.memoryFreePercent,
  ),
  swapUsedPercent: parsePressureThreshold(
    typeof localStorage === 'undefined' ? null : getSetting(pressureThresholdKeys.swapUsedPercent),
    defaultPressureThresholds.swapUsedPercent,
  ),
  diskFreePercent: parsePressureThreshold(
    typeof localStorage === 'undefined' ? null : getSetting(pressureThresholdKeys.diskFreePercent),
    defaultPressureThresholds.diskFreePercent,
  ),
};
let lastReading: MachineReading | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;

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
    checkingReason,
  ),
  browser: new ResourceQueue(
    parseResourceLimit(
      typeof localStorage === 'undefined' ? null : getSetting(resourceLimitKeys.browser),
      defaultResourceLimits.browser,
    ),
    checkingReason,
  ),
};

function pendingWork(): boolean {
  return Object.values(resourceQueues).some((queue) => queue.status.waiting > 0);
}

function setPressureReason(reason: string | null): void {
  for (const queue of Object.values(resourceQueues)) queue.setBlockedReason(reason);
}

async function refreshPressure(): Promise<void> {
  if (refreshing || !pendingWork()) return;
  refreshing = true;
  try {
    lastReading = await invoke<MachineReading>('machine_pressure');
    setPressureReason(pressureReason(lastReading, pressureThresholds));
  } catch {
    lastReading = null;
    setPressureReason('Waiting for machine pressure: host readings unavailable.');
  } finally {
    refreshing = false;
    updateMonitor();
  }
}

function updateMonitor(): void {
  if (pendingWork()) {
    if (!timer) {
      timer = setInterval(() => void refreshPressure(), 3000);
      void refreshPressure();
    }
  } else if (timer) {
    clearInterval(timer);
    timer = null;
    setPressureReason(checkingReason);
  }
}

for (const queue of Object.values(resourceQueues)) queue.subscribe(updateMonitor);

export function setPressureThresholds(value: PressureThresholds): void {
  pressureThresholds = value;
  if (lastReading) setPressureReason(pressureReason(lastReading, value));
  if (pendingWork()) void refreshPressure();
  else setPressureReason(checkingReason);
}

export function setResourceLimit(kind: ResourceKind, limit: number): void {
  resourceQueues[kind].setLimit(limit);
}

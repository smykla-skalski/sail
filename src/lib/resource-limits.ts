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
let lastReadings: Map<string, MachineReading> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let updatingReason = false;

function checkNewWork(): void {
  setPressureReason(checkingReason);
  void refreshPressure();
}

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
    checkNewWork,
  ),
  browser: new ResourceQueue(
    parseResourceLimit(
      typeof localStorage === 'undefined' ? null : getSetting(resourceLimitKeys.browser),
      defaultResourceLimits.browser,
    ),
    checkingReason,
    checkNewWork,
  ),
};

function pendingWork(): boolean {
  return Object.values(resourceQueues).some((queue) => queue.status.waiting > 0);
}

function pendingDirectories(): string[] {
  return [...new Set(Object.values(resourceQueues).flatMap((queue) => queue.waitingDirectories()))];
}

function setPressureReason(reason: string | null): void {
  updatingReason = true;
  try {
    for (const queue of Object.values(resourceQueues)) queue.setBlockedReason(reason);
  } finally {
    updatingReason = false;
  }
  updateMonitor();
}

async function refreshPressure(): Promise<void> {
  if (refreshing || !pendingWork()) return;
  refreshing = true;
  try {
    const directories = pendingDirectories();
    const readings = new Map(
      await Promise.all(
        directories.map(
          async (directory) =>
            [
              directory,
              await invoke<MachineReading>('machine_pressure', { directory: directory || null }),
            ] as const,
        ),
      ),
    );
    lastReadings = readings;
    if (pendingDirectories().every((directory) => readings.has(directory)))
      setPressureReason(readingsReason(readings));
    else setPressureReason(checkingReason);
  } catch {
    lastReadings = null;
    setPressureReason('Waiting for machine pressure: host readings unavailable.');
  } finally {
    refreshing = false;
    updateMonitor();
  }
}

function readingsReason(readings: Map<string, MachineReading>): string | null {
  const reasons = [...readings].flatMap(([directory, reading]) => {
    const reason = pressureReason(reading, pressureThresholds);
    if (!reason) return [];
    return [
      directory
        ? `${directory}: ${reason.replace('Waiting for machine pressure: ', '')}`
        : reason.replace('Waiting for machine pressure: ', ''),
    ];
  });
  return reasons.length ? `Waiting for machine pressure: ${reasons.join(' ')}` : null;
}

function updateMonitor(): void {
  if (updatingReason) return;
  if (pendingWork()) {
    if (!timer) {
      timer = setInterval(() => void refreshPressure(), 3000);
      void refreshPressure();
    }
  } else {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (Object.values(resourceQueues).some((queue) => queue.reason !== checkingReason))
      setPressureReason(checkingReason);
  }
}

for (const queue of Object.values(resourceQueues)) queue.subscribe(updateMonitor);

export function setPressureThresholds(value: PressureThresholds): void {
  pressureThresholds = value;
  if (lastReadings && pendingDirectories().every((directory) => lastReadings?.has(directory)))
    setPressureReason(readingsReason(lastReadings));
  else setPressureReason(checkingReason);
  if (pendingWork()) void refreshPressure();
}

export function setResourceLimit(kind: ResourceKind, limit: number): void {
  resourceQueues[kind].setLimit(limit);
}

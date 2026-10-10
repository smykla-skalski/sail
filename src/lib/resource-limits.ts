import { invoke } from '@tauri-apps/api/core';
import { getSetting } from './settings.ts';
import { ResourceQueue } from './resource-queue.ts';
import {
  defaultPressureThresholds,
  parsePressureThreshold,
  pressureBlockers,
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

export function isCheckingMachinePressure(reason: string | null): boolean {
  return reason === checkingReason;
}

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
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let updatingReason = false;
let readingGeneration = 0;

function checkNewWork(): void {
  readingGeneration++;
  setPressureState(checkingReason, new Map());
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

function setPressureState(reason: string | null, directoryReasons: Map<string, string>): void {
  updatingReason = true;
  try {
    for (const queue of Object.values(resourceQueues)) {
      if (reason) queue.setBlockedReason(reason);
      queue.setDirectoryReasons(directoryReasons);
      if (!reason) queue.setBlockedReason(null);
    }
  } finally {
    updatingReason = false;
  }
  updateMonitor();
}

export function pressureReasonsForResults(
  results: PromiseSettledResult<MachineReading>[],
  directories: string[],
  thresholds: PressureThresholds,
): { reason: string | null; directoryReasons: Map<string, string> } {
  const hostEnabled = thresholds.memoryFreePercent > 0 || thresholds.swapUsedPercent > 0;
  const diskEnabled = thresholds.diskFreePercent > 0;
  const hostReasons = new Set<string>();
  const directoryReasons = new Map<string, string>();
  let validHostReading = false;
  for (const [index, result] of results.entries()) {
    const directory = directories[index];
    if (result.status === 'rejected') {
      if (diskEnabled)
        directoryReasons.set(directory, `${directory || 'Workspace'}: machine reading unavailable`);
      continue;
    }
    validHostReading = true;
    const blockers = pressureBlockers(result.value, thresholds);
    for (const blocker of blockers.host) hostReasons.add(blocker);
    if (blockers.disk)
      directoryReasons.set(directory, `${directory || 'Workspace'}: ${blockers.disk}`);
  }
  const reason =
    hostEnabled && !validHostReading
      ? 'Waiting for machine pressure: host readings unavailable.'
      : hostReasons.size
        ? `Waiting for machine pressure: ${[...hostReasons].join('; ')}.`
        : null;
  return { reason, directoryReasons };
}

async function refreshPressure(): Promise<void> {
  if (refreshing || !pendingWork()) return;
  refreshing = true;
  const generation = readingGeneration;
  const directories = pendingDirectories();
  try {
    if (
      pressureThresholds.memoryFreePercent === 0 &&
      pressureThresholds.swapUsedPercent === 0 &&
      pressureThresholds.diskFreePercent === 0
    ) {
      setPressureState(null, new Map());
      return;
    }
    const results = await Promise.allSettled(
      directories.map((directory) =>
        invoke<MachineReading>('machine_pressure', { directory: directory || null }),
      ),
    );
    if (
      generation !== readingGeneration ||
      pendingDirectories().some((directory) => !directories.includes(directory))
    )
      return;
    const { reason, directoryReasons } = pressureReasonsForResults(
      results,
      directories,
      pressureThresholds,
    );
    setPressureState(reason, directoryReasons);
  } catch {
    if (generation === readingGeneration) {
      const hostEnabled =
        pressureThresholds.memoryFreePercent > 0 || pressureThresholds.swapUsedPercent > 0;
      const directoryReasons =
        pressureThresholds.diskFreePercent > 0
          ? new Map(
              directories.map((directory) => [
                directory,
                `${directory || 'Workspace'}: machine reading unavailable`,
              ]),
            )
          : new Map<string, string>();
      setPressureState(
        hostEnabled ? 'Waiting for machine pressure: host readings unavailable.' : null,
        directoryReasons,
      );
    }
  } finally {
    refreshing = false;
    updateMonitor();
    if (generation !== readingGeneration && pendingWork()) void refreshPressure();
  }
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
      setPressureState(checkingReason, new Map());
  }
}

for (const queue of Object.values(resourceQueues)) queue.subscribe(updateMonitor);

export function setPressureThresholds(value: PressureThresholds): void {
  pressureThresholds = value;
  readingGeneration++;
  setPressureState(checkingReason, new Map());
  if (pendingWork()) void refreshPressure();
}

export function setResourceLimit(kind: ResourceKind, limit: number): void {
  resourceQueues[kind].setLimit(limit);
}

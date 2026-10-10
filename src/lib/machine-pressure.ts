export type MachineReading = {
  totalMemory: number;
  availableMemory: number;
  totalSwap: number;
  usedSwap: number;
  totalDisk: number;
  availableDisk: number;
};

export type PressureThresholds = {
  memoryFreePercent: number;
  swapUsedPercent: number;
  diskFreePercent: number;
};

export const defaultPressureThresholds: PressureThresholds = {
  memoryFreePercent: 10,
  swapUsedPercent: 70,
  diskFreePercent: 2,
};

export const pressureThresholdKeys = {
  memoryFreePercent: 'sai-memory-free-threshold',
  swapUsedPercent: 'sai-swap-used-threshold',
  diskFreePercent: 'sai-disk-free-threshold',
} as const;

export function parsePressureThreshold(value: string | null, fallback: number): number {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 100 ? parsed : fallback;
}

function validPair(total: number, part: number): boolean {
  return Number.isFinite(total) && Number.isFinite(part) && total > 0 && part >= 0 && part <= total;
}

export function pressureReason(
  reading: MachineReading,
  thresholds: PressureThresholds,
): string | null {
  const { host, disk } = pressureBlockers(reading, thresholds);
  const blockers = [...host, ...(disk ? [disk] : [])];
  return blockers.length ? `Waiting for machine pressure: ${blockers.join('; ')}.` : null;
}

export function pressureBlockers(
  reading: MachineReading,
  thresholds: PressureThresholds,
): { host: string[]; disk: string | null } {
  const host: string[] = [];
  let disk: string | null = null;
  if (thresholds.memoryFreePercent > 0) {
    if (!validPair(reading.totalMemory, reading.availableMemory))
      host.push('memory reading unavailable');
    else if (reading.availableMemory * 100 <= reading.totalMemory * thresholds.memoryFreePercent)
      host.push(`free memory at or below ${thresholds.memoryFreePercent}%`);
  }

  if (thresholds.swapUsedPercent > 0) {
    if (
      !Number.isFinite(reading.totalSwap) ||
      !Number.isFinite(reading.usedSwap) ||
      reading.totalSwap < 0 ||
      reading.usedSwap < 0 ||
      reading.usedSwap > reading.totalSwap
    )
      host.push('swap reading unavailable');
    else if (
      reading.totalSwap > 0 &&
      reading.usedSwap * 100 >= reading.totalSwap * thresholds.swapUsedPercent
    )
      host.push(`swap use at or above ${thresholds.swapUsedPercent}%`);
  }

  if (thresholds.diskFreePercent > 0) {
    if (!validPair(reading.totalDisk, reading.availableDisk)) disk = 'disk reading unavailable';
    else if (reading.availableDisk * 100 <= reading.totalDisk * thresholds.diskFreePercent)
      disk = `free disk at or below ${thresholds.diskFreePercent}%`;
  }

  return { host, disk };
}

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
  const blockers: string[] = [];
  if (!validPair(reading.totalMemory, reading.availableMemory))
    blockers.push('memory reading unavailable');
  else if (
    thresholds.memoryFreePercent > 0 &&
    reading.availableMemory * 100 <= reading.totalMemory * thresholds.memoryFreePercent
  )
    blockers.push(`free memory at or below ${thresholds.memoryFreePercent}%`);

  if (
    !Number.isFinite(reading.totalSwap) ||
    !Number.isFinite(reading.usedSwap) ||
    reading.totalSwap < 0 ||
    reading.usedSwap < 0 ||
    reading.usedSwap > reading.totalSwap
  )
    blockers.push('swap reading unavailable');
  else if (
    thresholds.swapUsedPercent > 0 &&
    reading.totalSwap > 0 &&
    reading.usedSwap * 100 >= reading.totalSwap * thresholds.swapUsedPercent
  )
    blockers.push(`swap use at or above ${thresholds.swapUsedPercent}%`);

  if (!validPair(reading.totalDisk, reading.availableDisk))
    blockers.push('disk reading unavailable');
  else if (
    thresholds.diskFreePercent > 0 &&
    reading.availableDisk * 100 <= reading.totalDisk * thresholds.diskFreePercent
  )
    blockers.push(`free disk at or below ${thresholds.diskFreePercent}%`);

  return blockers.length ? `Waiting for machine pressure: ${blockers.join('; ')}.` : null;
}

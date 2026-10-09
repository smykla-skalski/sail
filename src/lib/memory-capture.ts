import { setSettingDurable } from './settings.ts';

export interface MemoryStatus {
  enabled: boolean;
  projectKey: string;
}

export interface AutomaticCaptureControl {
  available: boolean;
  enabled: boolean;
  settingKey: string;
}

export function automaticCaptureSettingKey(projectKey: string): string {
  return `sai-memory-auto-capture:${projectKey}`;
}

export function automaticCaptureControl(
  status: MemoryStatus,
  storedValue: string | null,
): AutomaticCaptureControl {
  return {
    available: status.enabled,
    enabled: status.enabled && storedValue === 'true',
    settingKey: automaticCaptureSettingKey(status.projectKey),
  };
}

export async function persistAutomaticCapture(
  projectKey: string,
  enabled: boolean,
  write: (key: string, value: string) => Promise<void> = setSettingDurable,
): Promise<void> {
  await write(automaticCaptureSettingKey(projectKey), String(enabled));
}

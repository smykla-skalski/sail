import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AdmissionProvider } from './resource-queue.ts';

export const reefAdmissionSettingKey = 'sai-reef-admission-enabled';

let startupEnabled = false;

export async function initializeReefAdmission(): Promise<void> {
  startupEnabled = isTauri() ? await invoke<boolean>('reef_admission_mode') : false;
}

export function reefAdmissionStartupEnabled(): boolean {
  return startupEnabled;
}

type AdmissionStatus = { state: 'checking' | 'queued' | 'granted' | 'failed'; reason: string };

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function reefAdmission(kind: 'agent' | 'browser'): AdmissionProvider {
  return (signal, reason) => {
    const waitForGrant = async (id: string): Promise<boolean> => {
      if (signal.aborted) return false;
      const status = await invoke<AdmissionStatus>('reef_admission_status', { id });
      if (signal.aborted) return false;
      if (status.state === 'granted') return true;
      reason(status.reason);
      if (status.state === 'failed') return false;
      await pause(signal, 250);
      return waitForGrant(id);
    };
    const attempt = async (): Promise<() => void> => {
      if (signal.aborted) throw new Error('Queued work was cancelled.');
      const id = crypto.randomUUID();
      const release = () => {
        void invoke('reef_admission_release', { id }).catch(() => {});
      };
      const abort = () => release();
      signal.addEventListener('abort', abort, { once: true });
      let admitted = false;
      try {
        await invoke('reef_admission_request', { id, kind });
        admitted = await waitForGrant(id);
        if (admitted) {
          return release;
        }
      } catch (error) {
        reason(`Reef admission unavailable: ${String(error)}`);
      } finally {
        signal.removeEventListener('abort', abort);
        if (!admitted) release();
      }
      await pause(signal, 3000);
      return attempt();
    };
    return attempt();
  };
}

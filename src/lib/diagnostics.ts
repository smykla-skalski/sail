import { invoke, isTauri } from '@tauri-apps/api/core';

export type DiagnosticEvent =
  | 'message_queued'
  | 'queue_dispatch_started'
  | 'queue_paused'
  | 'stop_requested'
  | 'escape_cancel'
  | 'turn_failed'
  | 'frontend_error'
  | 'frontend_unhandled_rejection'
  | 'frontend_start_failed'
  | 'opencode_event_stream_failed';

export function recordDiagnostic(
  event: DiagnosticEvent,
  details: {
    agent?: string;
    sessionId?: string | null;
    turnId?: string | null;
    queueLength?: number;
    errorName?: string;
    message?: string;
    source?: string;
    line?: number;
    column?: number;
    phase?: string;
  } = {},
): void {
  if (!isTauri()) return;
  void invoke('diagnostic_event', { details: { event, ...details } }).catch(() => {});
}

export function installFrontendDiagnostics(): void {
  window.addEventListener('error', (event) => {
    recordDiagnostic('frontend_error', {
      errorName: errorName(event.error),
      source: sourceName(event.filename),
      line: event.lineno,
      column: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const frame = event.reason instanceof Error ? event.reason.stack?.split('\n')[1] : undefined;
    const location = frame?.match(/([^\s()]+):(\d+):(\d+)\)?$/);
    recordDiagnostic('frontend_unhandled_rejection', {
      errorName: errorName(event.reason),
      source: location ? sourceName(location[1]) : undefined,
      line: location ? Number(location[2]) : undefined,
      column: location ? Number(location[3]) : undefined,
    });
  });
}

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : typeof value;
}

function sourceName(filename: string): string | undefined {
  try {
    return new URL(filename).pathname.split('/').at(-1);
  } catch {
    return undefined;
  }
}

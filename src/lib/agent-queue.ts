import type { BrowserAttachment } from './browser-pick';
import type { AcpTurnEvidence } from './acp';

export function queuedTurnDisposition(
  backendStatus: 'done' | 'failed' | 'interrupted' | null,
  evidenceStatus: AcpTurnEvidence['status'] | null,
): 'completed' | 'sent' | 'uncertain' | 'unsent' {
  if (backendStatus === 'done' || evidenceStatus === 'done') return 'completed';
  if (
    backendStatus !== null ||
    evidenceStatus === 'dispatched' ||
    evidenceStatus === 'failed' ||
    evidenceStatus === 'interrupted'
  )
    return 'sent';
  return evidenceStatus === 'dispatch_uncertain' ? 'uncertain' : 'unsent';
}

export interface QueuedAgentMessage {
  text: string;
  images: BrowserAttachment[];
  attachments: { path: string; name: string; image: boolean }[];
}

const queues = new Map<string, QueuedAgentMessage[]>();
const paused = new Map<string, string>();

export function queuedAgentMessages(
  agent: string,
  directory: string,
  sessionId: string,
): QueuedAgentMessage[] {
  return queues.get(JSON.stringify([agent, directory, sessionId])) ?? [];
}

export function saveQueuedAgentMessages(
  agent: string,
  directory: string,
  sessionId: string,
  messages: QueuedAgentMessage[],
): void {
  const key = JSON.stringify([agent, directory, sessionId]);
  if (messages.length) queues.set(key, messages);
  else queues.delete(key);
}

/** Why the session's queue stopped, or null while it may dispatch. */
export function agentQueuePauseReason(
  agent: string,
  directory: string,
  sessionId: string,
): string | null {
  return paused.get(JSON.stringify([agent, directory, sessionId])) ?? null;
}

export function setAgentQueuePaused(
  agent: string,
  directory: string,
  sessionId: string,
  reason: string | null,
): void {
  const key = JSON.stringify([agent, directory, sessionId]);
  if (reason !== null) paused.set(key, reason);
  else paused.delete(key);
}

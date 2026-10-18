import type { BrowserAttachment } from './browser-pick';
import type { AcpTurnEvidence } from './acp';
import { shellContext, type ShellRun } from './shell-command.ts';

/** Moves finished commands into their session queues, leaving running commands visible. */
export function enqueueShellResults(
  agent: string,
  runs: ShellRun[],
  activeSessionId: string | null,
  currentQueue: QueuedAgentMessage[],
): { runs: ShellRun[]; queue: QueuedAgentMessage[] } {
  let queue = currentQueue;
  const pending: ShellRun[] = [];
  for (const run of runs) {
    if (run.status === 'running' || (run.session === null && activeSessionId !== null)) {
      pending.push(run);
      continue;
    }
    const message: QueuedAgentMessage = {
      text: shellContext([run]),
      images: [],
      attachments: [],
    };
    const active = run.session === activeSessionId;
    const previous = active
      ? queue
      : run.session
        ? queuedAgentMessages(agent, run.directory, run.session)
        : [];
    const next = [...previous, message];
    if (run.session) saveQueuedAgentMessages(agent, run.directory, run.session, next);
    if (active) queue = next;
  }
  return { runs: pending, queue };
}

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
const paused = new Set<string>();

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

export function agentQueuePaused(agent: string, directory: string, sessionId: string): boolean {
  return paused.has(JSON.stringify([agent, directory, sessionId]));
}

export function setAgentQueuePaused(
  agent: string,
  directory: string,
  sessionId: string,
  value: boolean,
): void {
  const key = JSON.stringify([agent, directory, sessionId]);
  if (value) paused.add(key);
  else paused.delete(key);
}

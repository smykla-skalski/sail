import { listen } from '@tauri-apps/api/event';
import type { AgentEvent } from './acp.ts';
import { beginImplementationTurn, recordImplementationModel } from './implementation-models.ts';

type SteerResult = { outcome: 'injected' | 'startedNewTurn' | 'promptRequired' | 'failed' };

function property(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

export async function trackImplementationSteer(
  directory: string,
  model: string | undefined,
  agent: string,
  sessionId: string,
  turnId: string | null,
  request: () => Promise<SteerResult>,
): Promise<{ response: Promise<SteerResult>; completed: Promise<void> }> {
  let previousFinished = false;
  let sawIdle = false;
  let sawNewActive = false;
  let detachedFinished = false;
  let finish!: () => void;
  const lifecycle = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const unlisten = await listen<AgentEvent>('acp-event', ({ payload }) => {
    if (payload.agent !== agent) return;
    if (payload.message.method === 'sail/disconnected') {
      detachedFinished = true;
      finish();
      return;
    }
    const params = payload.message.params;
    if (params?.sessionId !== sessionId) return;
    if (payload.message.method === 'sail/prompt_finished' && params.turnId === turnId)
      previousFinished = true;
    if (payload.message.method !== 'session/update') return;
    const update = params.update;
    if (property(update, 'sessionUpdate') !== 'session_info_update') return;
    const status = property(
      property(property(property(update, '_meta'), 'codex'), 'threadStatus'),
      'type',
    );
    if (status === 'active') {
      if (sawIdle || previousFinished) sawNewActive = true;
    } else if (status === 'idle' || status === 'notLoaded' || status === 'systemError') {
      sawIdle = true;
      if (sawNewActive) {
        detachedFinished = true;
        finish();
      }
    }
  });
  let tracking;
  try {
    tracking = await beginImplementationTurn(directory, model, `acp:${agent}:${sessionId}`);
  } catch (cause) {
    unlisten();
    throw cause;
  }
  const response = Promise.resolve().then(request);
  const completed = (async () => {
    try {
      const result = await response;
      if (result.outcome === 'startedNewTurn') {
        // Legacy steering returns at start; the prompt RPC no longer owns this turn.
        tracking.owner = undefined;
        if (!detachedFinished) await lifecycle;
      }
    } finally {
      try {
        await recordImplementationModel(directory, model, tracking);
      } finally {
        unlisten();
      }
    }
  })();
  return { response, completed };
}

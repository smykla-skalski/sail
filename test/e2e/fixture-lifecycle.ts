type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

type PendingRequest = {
  agent: string;
  directory: string;
  profile: string;
  message: {
    id?: string | number;
    method: string;
    params?: { sessionId?: string };
  };
};

function pendingRequests(value: unknown): PendingRequest[] {
  if (!Array.isArray(value)) throw new Error('Invalid pending inbox response');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid pending inbox item');
    const agent = Reflect.get(item, 'agent');
    const directory = Reflect.get(item, 'directory');
    const profile = Reflect.get(item, 'profile');
    const message = Reflect.get(item, 'message');
    const method = message && typeof message === 'object' ? Reflect.get(message, 'method') : null;
    const id = message && typeof message === 'object' ? Reflect.get(message, 'id') : null;
    const params = message && typeof message === 'object' ? Reflect.get(message, 'params') : null;
    const sessionId =
      params && typeof params === 'object' ? Reflect.get(params, 'sessionId') : null;
    if (
      typeof agent !== 'string' ||
      typeof directory !== 'string' ||
      typeof profile !== 'string' ||
      !message ||
      typeof message !== 'object' ||
      typeof method !== 'string' ||
      typeof sessionId !== 'string'
    )
      throw new Error('Invalid pending inbox request');
    return {
      agent,
      directory,
      profile,
      message: {
        ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
        method,
        params: { sessionId },
      },
    };
  });
}

async function settleRequest(invoke: Invoke, request: PendingRequest): Promise<void> {
  const { agent, directory, profile, message } = request;
  const sessionId = message.params?.sessionId;
  if (!sessionId) throw new Error('Pending request has no session');
  if (message.method === 'elicitation/create') {
    if (typeof message.id !== 'string' && typeof message.id !== 'number')
      throw new Error('Pending elicitation has no request ID');
    await invoke('acp_elicitation', {
      params: {
        agent,
        directory,
        sessionId,
        profile,
        requestId: message.id,
        action: 'cancel',
        content: null,
      },
    });
    return;
  }
  if (message.method === 'session/request_permission') {
    await invoke('acp_cancel', { agent, directory, sessionId, turnId: null });
    return;
  }
  throw new Error(`Unexpected pending request: ${message.method}`);
}

export async function resetAgentFixture(
  invoke: Invoke,
  yieldToRuntime: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<void> {
  const settleAll = async (pending: PendingRequest[]): Promise<void> => {
    const [current, ...remaining] = pending;
    if (!current) return;
    await settleRequest(invoke, current);
    return settleAll(remaining);
  };
  const reset = async (pass: number): Promise<void> => {
    const pending = pendingRequests(await invoke('acp_pending_inbox'));
    await settleAll(pending);
    await invoke('acp_reset_test_runtimes');
    await yieldToRuntime();
    if (pendingRequests(await invoke('acp_pending_inbox')).length === 0) return;
    if (pass === 10) throw new Error('Pending agent requests remained after 10 cleanup passes');
    return reset(pass + 1);
  };
  return reset(1);
}

export class AgentReplay {
  private sessionId: string | null = null;

  get active(): boolean {
    return this.sessionId !== null;
  }

  set(replaying: boolean, activeSessionId: string | null): string | null {
    if (replaying) {
      if (this.sessionId !== null || activeSessionId === null) return null;
      this.sessionId = activeSessionId;
      return activeSessionId;
    }
    const stoppedSessionId = this.sessionId;
    this.sessionId = null;
    return stoppedSessionId;
  }
}

export function updateReplayingAgentSessions(
  sessions: Record<string, number>,
  agent: string,
  directory: string,
  sessionId: string,
  replaying: boolean,
): Record<string, number> {
  const key = JSON.stringify([agent, directory, sessionId]);
  const next = { ...sessions };
  const count = (next[key] ?? 0) + (replaying ? 1 : -1);
  if (count > 0) next[key] = count;
  else delete next[key];
  return next;
}

import type { SessionMessageInfo } from '@opencode/client';

export interface CachedOpenCodeTimeline {
  messages: SessionMessageInfo[];
  cursor: string | null;
}

const timelines = new Map<string, CachedOpenCodeTimeline>();
const limit = 8;

export interface OpenCodeTimelineSnapshot extends CachedOpenCodeTimeline {
  directory: string;
  sessionID: string;
}

function key(directory: string, sessionID: string): string {
  return `${directory}\0${sessionID}`;
}

export function rememberOpenCodeTimeline(
  directory: string,
  sessionID: string,
  timeline: CachedOpenCodeTimeline,
): void {
  const id = key(directory, sessionID);
  timelines.delete(id);
  timelines.set(id, { messages: [...timeline.messages], cursor: timeline.cursor });
  while (timelines.size > limit) timelines.delete(timelines.keys().next().value!);
}

export function recallOpenCodeTimeline(
  directory: string,
  sessionID: string,
): CachedOpenCodeTimeline | null {
  const id = key(directory, sessionID);
  const timeline = timelines.get(id);
  if (!timeline) return null;
  timelines.delete(id);
  timelines.set(id, timeline);
  return { messages: [...timeline.messages], cursor: timeline.cursor };
}

export function forgetOpenCodeTimeline(directory: string, sessionID: string): void {
  timelines.delete(key(directory, sessionID));
}

export function clearOpenCodeTimelineCache(): void {
  timelines.clear();
}

export function cachedOpenCodeTimelines(): OpenCodeTimelineSnapshot[] {
  return [...timelines.entries()].map(([id, timeline]) => {
    const [directory, sessionID] = id.split('\0');
    return { directory, sessionID, messages: [...timeline.messages], cursor: timeline.cursor };
  });
}

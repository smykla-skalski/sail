const announced = new Set<string>();

/**
 * Returns the error a tool card should announce, or '' to stay silent.
 * Errors present when a card mounts from history stay silent; a card
 * mounted live, or an error that changes later, announces. Each tool
 * error announces once, even when its card remounts.
 */
export function toolAlert(
  input: {
    id: string | undefined;
    error: string;
    mountedError: string;
    mountedLive: boolean;
  },
  seen: Set<string> = announced,
): string {
  const { id, error, mountedError, mountedLive } = input;
  if (!error || (!mountedLive && error === mountedError)) return '';
  if (id === undefined) return error;
  const key = `${id}\n${error}`;
  if (seen.has(key)) return '';
  seen.add(key);
  return error;
}

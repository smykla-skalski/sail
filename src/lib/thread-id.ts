const legacyPrefix = 'opencode:';
const acpPrefix = 'acp:opencode:';

/** `opencode:<id>` becomes `acp:opencode:<id>`; every other string is returned unchanged. */
export function acpThreadId(value: string): string {
  return value.startsWith(legacyPrefix) ? `${acpPrefix}${value.slice(legacyPrefix.length)}` : value;
}

/** OpenCode session id from either thread id form; null for other agents. */
export function openCodeSessionId(value: string | null | undefined): string | null {
  if (!value) return null;
  const prefix = value.startsWith(acpPrefix)
    ? acpPrefix
    : value.startsWith(legacyPrefix)
      ? legacyPrefix
      : null;
  return prefix && value.length > prefix.length ? value.slice(prefix.length) : null;
}

/** True when both ids name one thread, whichever OpenCode form each uses. */
export function sameThreadId(left: string | null | undefined, right: string): boolean {
  return !!left && acpThreadId(left) === acpThreadId(right);
}
